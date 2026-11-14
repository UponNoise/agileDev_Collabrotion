import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { agentOperations, DomainError, schemas } from './contracts.js';
import { LocalClient } from './client.js';

const descriptions: Record<string, string> = {
  defect_propose: 'Record a nonblocking pending problem on an issue you can read. No artifact or confirmed origin is invented; human triage is required.',
  defect_list: 'Read defect records only within the existing issue scope, with filters and bounded pagination.',
  defect_get: 'Read one scoped defect and its actual observation, origin and human triage history.',
  iteration_list: 'Read scoped iteration records and advisory planning progress; no workflow gate changes.',
  iteration_get: 'Read scoped iteration membership, event-derived daily flow or an immutable close summary. Full membership preconditions and Markdown export require planning authority.',
  iteration_membership_set: 'Atomically change optional planning membership with every issue version and complete source/destination membership precondition. Never advances a gate.',
  iteration_close: 'Explicitly close an iteration with complete member versions and unfinished carry-over/backlog dispositions; seal historical summary without changing issue lifecycle.',
  workspace_list: 'List only workspaces authorized for this agent. Select an explicit workspace for all subsequent commands.',
  issue_get: 'Read the assigned issue, current versions, readiness blockers, and legal next actions.',
  issue_list: 'List scoped issues with pagination. Creation never starts work.',
  issue_create: 'Create an unstarted requirement or task. Child titles use [Type] Area: action -> outcome.',
  plan_get: 'Read current or historical decomposition, criterion coverage, overlap reasons and blockers. Default coverage is paginated; full explicitly expands task scope and versions.',
  scope_get: 'Expand paginated child scope and human exclusion/replacement/restore decisions for planning. Human, lead or PM only. This cannot create scope authority or remove approved criteria.',
  plan_apply: 'Atomically create/update a complete requirement decomposition with exact parent/child versions, criterion coverage, dependencies and optional assignments/schedule. DRAFT may be incomplete; READY needs approved complete coverage. Existing children cannot be omitted. Applying a plan never starts a model run.',
  dependency_set: 'Replace the complete blocking dependency set for unstarted/rejected work. Rejects explicit and aggregate cycles and stales affected plan coverage.',
  integration_get: 'Read paginated current accepted child snapshot/commit references and the ready plan for parent integration. Managed workers/QA may expand only their assigned parent packet.',
  artifact_read: 'Read a bounded byte window from a current sealed artifact, or an accepted child snapshot in this managed parent integration. UTF-8 is strict; use base64 for binary or split character windows. Does not expose private storage paths.',
  design_set: 'Create a new design revision; invalidates affected approvals. Cannot approve a design.',
  design_submit: 'Request human review of the exact current design revision.',
  grant_list: 'List this agent\'s human-issued grants for the exact issue, including scope, expiry, uses and current status. This cannot issue or revoke authority.',
  issue_transition: 'Perform a guarded lifecycle action. Lead/PM must supply a current human grantId for this exact issue and action; authority does not extend to children.',
  work_dispatch: 'Queue a ready assignment for the selected harness. Queued is not running or completed.',
  work_claim: 'Acknowledge exact approved scope and claim only this coordinator-reserved STARTING implementation run. Requires a run-scoped actor and prepared isolated directory; a logical worker must ask PM to dispatch.',
  work_submit: 'Hash real workspace artifacts and submit them for initial lead review.',
  review_submit: 'Record an initial or final lead review of the exact sealed candidate. This cannot advance the independent QA gate.',
  qa_check_run: 'Queue a human-approved fixed test command against this QA copy of the sealed snapshot. Test sources must be under .qa.',
  qa_check_get: 'Read captured test status, command, exit code, output, and snapshot binding. Queued/running is not a pass.',
  qa_report_submit: 'Submit criterion-level independent QA results and reproducible findings using captured check IDs. Gate advancement waits for producer termination.',
  git_submit: 'Attach a full GitHub commit URL to the current sealed candidate in the owner-bound repository. Queued verification is not a successful check; changed mappings invalidate human delivery acceptance.',
  git_retry: 'Retry unavailable/failed read verification of the same current commit mapping. Preserves exact saved human acceptance; cannot change the target or assert success.',
  delivery_complete: 'Recheck saved human acceptance or consume an exact human completion grantId. Independent reviews, children, defects and remote Git evidence still apply. This cannot invent human authority.',
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
    const readOnly = ['workspace_list', 'connection_list', 'issue_get', 'issue_list', 'run_get', 'run_list', 'gap_list', 'event_list', 'check_profile_list', 'qa_check_get', 'evidence_get','grant_list','plan_get','integration_get','artifact_read','scope_get','iteration_list','iteration_get','defect_list','defect_get'].includes(name);
    server.registerTool(name, { description: descriptions[name] ?? `Perform ${name} within authenticated role and workspace scope. Mutations require current versions and a unique idempotency key.`, inputSchema: schemas[name], annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: false } }, async (args: any) => {
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
