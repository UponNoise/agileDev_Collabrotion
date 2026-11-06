import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { agentOperations, DomainError, schemas } from './contracts.js';
import { LocalClient } from './client.js';

const descriptions: Record<string, string> = {
  workspace_list: 'List only workspaces authorized for this agent. Select an explicit workspace for all subsequent commands.',
  issue_get: 'Read the assigned issue, current versions, readiness blockers, and legal next actions.',
  issue_list: 'List scoped issues with pagination. Creation never starts work.',
  issue_create: 'Create an unstarted requirement or task. Child titles use [Type] Area: action -> outcome.',
  design_set: 'Create a new design revision; invalidates affected approvals. Cannot approve a design.',
  design_submit: 'Request human review of the exact current design revision.',
  work_dispatch: 'Queue a ready assignment for the selected harness. Queued is not running or completed.',
  work_claim: 'Acknowledge the current scope/design and atomically claim assigned work.',
  work_submit: 'Hash real workspace artifacts and submit them for initial lead review.',
  review_submit: 'Record a role-checked review of the exact candidate. QA pass requires trusted test evidence.',
  gap_list: 'Find specific blocking readiness gaps and advisory unscheduled work.',
};
export async function connectMcp(client: LocalClient) {
  const { actor } = await client.request('/api/session');
  if (actor.role === 'human') throw new DomainError('HUMAN_CREDENTIAL_DENIED', 'Enroll a scoped agent; owner credentials cannot be used by MCP', 403);
  const server = new McpServer({ name: 'agiledev', version: '0.1.0' }, { instructions: 'Operate on explicit workspace and issue IDs. Read current versions before mutations. Never invent human approval, test evidence, or completion. Queued dispatch is not execution. Resolve blockers reported by the service.' });
  server.server.oninitialized = () => {
    const clientInfo = server.server.getClientVersion();
    if (clientInfo) void client.request('/api/connection', { name: clientInfo.name, version: clientInfo.version }).catch(() => process.stderr.write('Could not record MCP initialization metadata.\n'));
  };
  for (const name of agentOperations) {
    server.registerTool(name, { description: descriptions[name] ?? `Perform ${name} within authenticated role and workspace scope. Mutations require current versions and a unique idempotency key.`, inputSchema: schemas[name] }, async (args: any) => {
      try {
        const result = await client.command(name, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const code = error instanceof DomainError ? error.code : 'SERVICE_UNAVAILABLE';
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message: error instanceof DomainError ? error.message : 'The local service is unavailable', details: error instanceof DomainError ? error.details : undefined } }) }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
  return server;
}
