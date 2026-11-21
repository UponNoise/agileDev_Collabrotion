import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DomainError, schemas, type Operation } from './contracts.js';
import { describedInput, isReadOperation, roleInstructions, toolDescription, toolsForRole } from './agent-profiles.js';
import { commandFailure } from './issue-brief.js';
import { LocalClient } from './client.js';

export async function connectMcp(client: LocalClient) {
  const { actor } = await client.request('/api/session');
  if (actor.role === 'human') throw new DomainError('HUMAN_CREDENTIAL_DENIED', 'Enroll a scoped agent; owner credentials cannot be used by MCP', 403);
  const operations = toolsForRole(actor.role);
  const server = new Server({ name: 'agiledev', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: roleInstructions(actor.role) });
  server.oninitialized = () => {
    const clientInfo = server.getClientVersion();
    if (clientInfo) void client.request('/api/connection', { name: clientInfo.name, version: clientInfo.version }).catch(() => process.stderr.write('Could not record MCP initialization metadata.\n'));
  };
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: operations.map(name => ({
    name, description: toolDescription(name), inputSchema: describedInput(schemas[name]) as any,
    annotations: { readOnlyHint: isReadOperation(name), destructiveHint: !isReadOperation(name), idempotentHint: true, openWorldHint: false }
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const name = request.params.name;
      if (!Object.hasOwn(schemas, name)) throw new DomainError('UNKNOWN_OPERATION', 'Unknown operation', 404);
      if (!operations.includes(name as Operation)) throw new DomainError('ROLE_DENIED', 'Operation is outside this role profile', 403);
      const result = await client.command(name, request.params.arguments ?? {}, name === 'message_wait' ? extra.signal : undefined);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'SERVICE_UNAVAILABLE';
      const failure = error instanceof DomainError
        ? commandFailure(code, error.message, error.details)
        : commandFailure(code, 'The local service is unavailable');
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: failure }) }] };
    }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
