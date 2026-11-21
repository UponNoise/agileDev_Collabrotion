import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, canonical } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { createServer } from '../src/http.js';
import { DomainError, schemas, type Role } from '../src/contracts.js';
import { agentReference, toolsForRole } from '../src/agent-profiles.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'b23-profile-'));
  const store = new Store(':memory:'); const flow = new Workflow(store); const human = store.bootstrap();
  const workspace = (flow.execute(human.actor, 'workspace_register', { root, name: 'Synthetic B23 fixture', prefix: 'B23', idempotencyKey: randomUUID() }) as any).workspace;
  const agents = Object.fromEntries((['lead', 'pm', 'worker', 'qa'] as const).map(role => [role, flow.execute(human.actor, 'actor_enroll', { workspaceId: workspace.id, role, name: `Synthetic ${role}`, idempotencyKey: randomUUID() })])) as Record<Exclude<Role, 'human'>, any>;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const unchanged = () => canonical(['records', 'receipts', 'events'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  return { root, store, flow, human, workspace, agents, unchanged };
}

test('service role denial precedes malformed input, legacy-field handling and receipt replay', t => {
  const f = fixture(t); const before = f.unchanged();
  for (const [role, agent] of Object.entries(f.agents)) {
    const profile = toolsForRole(role as Role);
    for (const operation of Object.keys(schemas).filter(name => !profile.includes(name as any))) {
      assert.throws(() => f.flow.execute(agent.actor, operation, { iteration: 'retired', tasks: [{ iteration: 'retired' }], idempotencyKey: 'occupied' }), (error: unknown) => error instanceof DomainError && error.code === 'ROLE_DENIED', `${role}: ${operation}`);
    }
  }
  assert.equal(f.unchanged(), before);
  const input = { workspaceId: f.workspace.id, title: 'Previously permitted intent', idempotencyKey: randomUUID() };
  f.flow.execute(f.agents.pm.actor, 'issue_create', input);
  const after = f.unchanged();
  assert.throws(() => f.flow.execute({ ...f.agents.pm.actor, role: 'worker' }, 'issue_create', input), (e: any) => e.code === 'ROLE_DENIED');
  assert.equal(f.unchanged(), after);
  assert.throws(() => f.flow.execute(f.human.actor, 'work_claim', {}), (e: any) => e.code === 'ROLE_DENIED');
  assert.throws(() => f.flow.execute(f.human.actor, 'workspace_register', {}), (e: any) => e.code === 'INVALID_INPUT');
  assert.throws(() => f.flow.claimReservedWork(f.agents.worker.actor, { workspaceId: f.workspace.id, issueId: 'missing', expectedVersion: 1, designId: 'missing', scopeRevision: 1, idempotencyKey: randomUUID() }), (e: any) => e.code === 'NOT_FOUND');
});

test('published role reference is generated from the authoritative registry', () => {
  const reference = readFileSync('docs/local-development.md', 'utf8').replaceAll('\r\n', '\n').split('<!-- B23_PROFILE_REFERENCE_START -->\n')[1]?.split('\n<!-- B23_PROFILE_REFERENCE_END -->')[0];
  assert.equal(reference, agentReference());
});

test('HTTP profiles deny before preconditions and preserve assigned issue/workspace read scope', async t => {
  const f = fixture(t); const server = createServer(f.store); t.after(() => server.close());
  const issue = (title: string) => (f.flow.execute(f.human.actor, 'issue_create', { workspaceId: f.workspace.id, title, idempotencyKey: randomUUID() }) as any).issue;
  const mine = issue('Visible requirement'); const hidden = issue('Hidden requirement');
  f.flow.execute(f.human.actor, 'issue_assign', { workspaceId: f.workspace.id, issueId: mine.id, expectedVersion: mine.version, actorId: f.agents.worker.actor.id, harness: 'codex', idempotencyKey: randomUUID() });
  for (const [role, agent] of Object.entries(f.agents)) {
    for (const operation of ['delivery_decide', 'design_decide', 'actor_enroll', 'work_claim']) {
      const before = f.unchanged();
      const response = await server.inject({ method: 'POST', url: `/api/command/${operation}`, headers: { host: '127.0.0.1', authorization: `Bearer ${agent.token}` }, payload: { expectedVersion: -1 } });
      assert.equal(response.statusCode, 403, `${role}: ${operation}`); assert.equal(response.json().error.code, 'ROLE_DENIED'); assert.equal(f.unchanged(), before);
    }
  }
  const read = async (operation: string, input: object) => server.inject({ method: 'POST', url: `/api/command/${operation}`, headers: { host: '127.0.0.1', authorization: `Bearer ${f.agents.worker.token}` }, payload: input });
  const list = await read('issue_list', { workspaceId: f.workspace.id });
  assert.equal(list.statusCode, 200); assert.deepEqual(list.json().result.issues.map((i: any) => i.id), [mine.id]);
  assert.equal((await read('issue_get', { workspaceId: f.workspace.id, issueId: hidden.id })).json().error.code, 'SCOPE_DENIED');
  assert.equal((await read('issue_list', { workspaceId: 'another-workspace' })).json().error.code, 'SCOPE_DENIED');
  for (const operation of ['iteration_list', 'iteration_get']) assert.equal((await read(operation, {})).json().error.code, 'ROLE_DENIED');
});

test('real stdio MCP advertises complete described role profiles and rejects foreign calls before arguments', { timeout: 30000 }, async t => {
  const f = fixture(t); const app = createServer(f.store); await app.listen({ host: '127.0.0.1', port: 0 }); t.after(() => app.close());
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  for (const role of ['worker', 'qa', 'pm', 'lead'] as const) {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    env.AGILEDEV_ENDPOINT = `http://127.0.0.1:${address.port}`; env.AGILEDEV_TOKEN = f.agents[role].token;
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'mcp'], env, stderr: 'pipe' });
    const client = new Client({ name: 'Synthetic B23 transport test', version: '1' });
    try {
      await client.connect(transport); const tools = (await client.listTools()).tools; const names = tools.map(tool => tool.name);
      assert.deepEqual(new Set(names), new Set(toolsForRole(role))); assert.ok(client.getInstructions()?.includes(role === 'worker' ? 'coordinator' : role === 'qa' ? 'Independently' : role === 'pm' ? 'Plan scope' : 'initial/final'));
      for (const name of ['defect_get', 'defect_list', 'defect_propose', 'workspace_list', 'issue_get']) assert.ok(names.includes(name));
      for (const name of ['delivery_decide', 'defect_triage', 'work_claim', 'inbox_list']) assert.equal(names.includes(name), false);
      if (role === 'worker' || role === 'qa') for (const name of ['iteration_get', 'iteration_list', 'issue_create', 'review_submit']) assert.equal(names.includes(name), false);
      if (role === 'pm') assert.equal(names.includes('design_set'), false);
      function described(node: any) {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node.properties ?? {}) as [string, any][]) assert.ok(typeof value.description === 'string' && value.description.length > 20, `${role}: ${key}`);
        for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(described) : described(value);
      }
      for (const tool of tools) { assert.ok(tool.description?.includes('Preconditions:')); assert.ok(tool.description?.includes('Rejections:')); described(tool.inputSchema); }
      for (const name of ['delivery_decide', 'work_claim', ...(role === 'worker' || role === 'qa' ? ['iteration_get'] : [])]) {
        const result = await client.callTool({ name, arguments: { expectedVersion: -1, iteration: 'legacy' } });
        assert.equal(result.isError, true); assert.equal(JSON.parse((result.content as any)[0].text).error.code, 'ROLE_DENIED');
      }
      const result = await client.callTool({ name: 'workspace_list', arguments: {} }); assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as any).workspaces[0].id, f.workspace.id);
    } finally { await client.close(); }
  }
});
