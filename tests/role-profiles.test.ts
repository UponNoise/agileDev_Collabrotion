import { executeFixture } from './fixtures.js';
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

test('default briefs keep 200 defects compact and point to exact scoped blocking evidence', t => {
  const f = fixture(t);
  const workspaceId = f.workspace.id;
  const lead = f.agents.lead.actor;
  const { issue } = f.flow.execute(f.human.actor, 'issue_create', {
    workspaceId, title: 'Large scoped brief', description: '長い要件\n'.repeat(600), criteria: ['C'], idempotencyKey: randomUUID()
  }) as any;
  const rawEvidence = 'Exact private defect evidence 未解决\n'.repeat(120);
  const ids = Array.from({ length: 200 }, () => randomUUID());
  for (const [index, id] of ids.entries()) {
    f.store.put('defect', {
      id, workspaceId, issueId: issue.id, state: 'OPEN', severity: index >= 198 ? 'BLOCKER' : 'MAJOR',
      criterionId: 'C', reproduce: rawEvidence, expected: rawEvidence, actual: rawEvidence,
      reportId: randomUUID(), candidateId: randomUUID(), snapshotId: randomUUID()
    }, workspaceId);
  }
  f.flow.execute(lead, 'defect_propose', {
    workspaceId, issueId: issue.id, expectedVersion: issue.version, severity: 'BLOCKER',
    criterionIds: ['C'], reproduce: 'Pending details', expected: 'Expected pending', actual: 'Proposed only',
    idempotencyKey: randomUUID()
  });
  const before = f.unchanged();
  const brief = f.flow.execute(lead, 'issue_get', { workspaceId, issueId: issue.id }) as any;
  assert.deepEqual(brief.defects, {
    open: 200, proposed: 1, blocking: 200,
    topBlocking: ids.slice(-2).map(id => ({ id, severity: 'BLOCKER' })),
    expand: { operation: 'defect_list', args: { workspaceId, issueId: issue.id } }
  });
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) <= 1990);
  assert.ok(!JSON.stringify(brief).includes('Exact private defect evidence'));
  const { operation, args } = brief.defects.expand;
  const page = f.flow.execute(lead, operation, args) as any;
  assert.equal(page.defects.length, 20);
  assert.equal(page.total, 201);
  assert.equal(page.nextOffset, 20);
  const expanded = f.flow.execute(lead, 'defect_get', { workspaceId, defectId: ids[199] }) as any;
  assert.equal(expanded.defect.actual, rawEvidence);
  assert.equal(f.unchanged(), before);
});

test('scoped design reads retain exact decision reasons and reject unrelated evidence', async t => {
  const f = fixture(t);
  const workspaceId = f.workspace.id;
  const command = (op: string, input: object) =>
    executeFixture(f.flow, f.human.actor, op, { workspaceId, idempotencyKey: randomUUID(), ...input }) as any;
  const create = (title: string, parentId?: string) => command('issue_create', {
    title, description: 'Captured requirement content', criteria: ['AC1'],
    ...(parentId ? { parentId, expectedParentVersion: f.store.get<any>('issue', parentId).version } : {})
  }).issue;
  const parent = create('Owned requirement');
  const siblingRoot = create('Other requirement');
  const child = create('[Feature] Scope: read design -> execute safely', parent.id);
  const sibling = create('[Feature] Other: handle data -> no cross-task access', parent.id);
  const change = (issueId: string, op: string, input: object = {}) =>
    command(op, { issueId, expectedVersion: f.store.get<any>('issue', issueId).version, ...input });
  const decide = (issueId: string, content: string, decision: string, reason: string) => {
    change(issueId, 'design_set', { content, criteria: ['AC1'] });
    change(issueId, 'design_submit');
    const designId = f.store.get<any>('issue', issueId).designId;
    change(issueId, 'design_decide', { designId, decision, reason });
    return designId;
  };
  const initial = decide(parent.id, 'Initial design', 'CHANGES_REQUESTED', 'Preserve the original boundary');
  const approved = decide(parent.id, 'Updated design', 'APPROVED', 'Exact revision meets the criterion');
  const foreign = decide(siblingRoot.id, 'Private design', 'APPROVED', 'Different requirement');
  change(child.id, 'issue_assign', { actorId: f.agents.worker.actor.id, harness: 'codex' });
  const acceptance = {
    id: randomUUID(), issueId: child.id, actorId: f.human.actor.id, candidateId: randomUUID(),
    digest: 'fixture-digest', decision: 'REJECT', reason: 'Stored historical delivery decision'
  };
  f.store.put('delivery_approval', acceptance, workspaceId);

  const server = createServer(f.store);
  t.after(() => server.close());
  const read = async (operation: string, payload: object) => server.inject({
    method: 'POST', url: `/api/command/${operation}`,
    headers: { host: '127.0.0.1', authorization: `Bearer ${f.agents.worker.token}` },
    payload: { workspaceId, ...payload }
  });
  const before = f.unchanged();
  const first = (await read('design_get', { issueId: child.id, limit: 1 })).json().result;
  assert.equal(first.requirementId, parent.id);
  assert.equal(first.design.id, approved);
  assert.equal(first.design.content, 'Updated design');
  assert.equal(first.design.requirementDescription, 'Captured requirement content');
  assert.deepEqual(first.design.criteria, ['AC1']);
  assert.equal(first.current, true);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.decisions[0].reason, 'Exact revision meets the criterion');
  const older = (await read('design_get', { issueId: child.id, designId: initial, limit: 1, offset: first.nextOffset })).json().result;
  assert.equal(older.current, false);
  assert.equal(older.design.id, initial);
  assert.equal(older.nextOffset, null);
  assert.equal(older.decisions[0].reason, 'Preserve the original boundary');

  const expanded = await read('evidence_get', { issueId: parent.id, kind: 'design_decision', evidenceId: older.decisions[0].id });
  assert.deepEqual(expanded.json().result.evidence, older.decisions[0]);
  const delivered = await read('evidence_get', { issueId: child.id, kind: 'delivery_decision', evidenceId: acceptance.id });
  assert.deepEqual(delivered.json().result.evidence, acceptance);
  for (const request of [
    read('design_get', { issueId: child.id, designId: foreign }),
    read('design_get', { issueId: sibling.id }),
    read('design_get', { issueId: siblingRoot.id }),
    read('evidence_get', { issueId: parent.id, kind: 'delivery_decision', evidenceId: acceptance.id }),
    read('evidence_get', { issueId: child.id, kind: 'design_decision', evidenceId: older.decisions[0].id })
  ]) assert.equal((await request).json().error.code, 'SCOPE_DENIED');
  assert.equal(f.unchanged(), before);
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
      assert.equal(response.statusCode, 403, `${role}: ${operation}`);
      assert.equal(response.json().error.code, 'ROLE_DENIED');
      assert.equal(response.json().error.details, null);
      assert.match(response.json().error.remedy.action, /role profile/);
      assert.equal(f.unchanged(), before);
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
      for (const name of ['defect_get', 'defect_list', 'defect_propose', 'workspace_list', 'issue_get', 'design_get']) assert.ok(names.includes(name));
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
        assert.equal(result.isError, true);
        const failure = JSON.parse((result.content as any)[0].text).error;
        assert.equal(failure.code, 'ROLE_DENIED');
        assert.equal(failure.details, null);
        assert.match(failure.remedy.action, /role profile/);
      }
      const result = await client.callTool({ name: 'workspace_list', arguments: {} }); assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as any).workspaces[0].id, f.workspace.id);
    } finally { await client.close(); }
  }
});
