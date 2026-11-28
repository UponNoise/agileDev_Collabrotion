import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { Store, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { decideJoinRequest, JoinRequests, pendingJoinRequests } from '../src/join.js';
import { executeFixture } from './fixtures.js';
import { agentRoles } from '../src/contracts.js';
import { firstSteps, reportRule, roleInstructions, sessionRule, toolsForRole } from '../src/agent-profiles.js';

function fixture(t: TestContext, register = true) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { actor } = store.bootstrap();
  let time = Date.parse('2026-11-28T00:00:00Z');
  const now = () => time;
  const advance = (ms: number) => { time += ms; };
  const flow = new Workflow(store, now);
  const addWorkspace = (name: string) => {
    const root = name === 'Fixture' ? tmpdir() : process.cwd();
    return (flow.execute(actor, 'workspace_register', { root, name, prefix: name === 'Fixture' ? 'AA' : 'BB', idempotencyKey: name }) as any).workspace;
  };
  const workspace = register ? addWorkspace('Fixture') : undefined;
  const workspaceId = workspace?.id;
  const joins = new JoinRequests(store, now);
  const create = (name: string, harness: 'other' | 'codex' = 'other') => joins.create({ name, role: 'pm', harness });
  const decide = (id: string, decision: 'APPROVE' | 'REFUSE', expectedVersion = 1) =>
    decideJoinRequest(store, { ...actor, channel: 'browser' }, { workspaceId, requestId: id, expectedVersion, decision }, now());
  const poll = (request: { requestId: string; secret: string }) => joins.poll(request, () => ({ role: 'pm' }));
  return { store, actor, flow, now, advance, workspace, workspaceId, joins, create, decide, poll, addWorkspace };
}

test('join delivery is one-time and claim rolls back if first steps fail', t => {
  const f = fixture(t);
  const request = f.create(' Neon ');
  assert.equal(f.poll(request).state, 'PENDING');
  const notFound = { code: 'JOIN_REQUEST_NOT_FOUND' };
  assert.throws(() => f.poll({ ...request, secret: 'wrong' }), notFound);
  assert.throws(() => f.poll({ ...request, requestId: 'unknown' }), notFound);
  assert.throws(() => f.decide(request.requestId, 'APPROVE', 2), { code: 'VERSION_CONFLICT', details: { currentVersion: 1 } });
  const decision = f.decide(request.requestId, 'APPROVE');
  assert.equal(decision.request.decidedChannel, 'browser');
  assert.equal(Object.hasOwn(decision.request, 'secretHash'), false);
  assert.throws(() => f.joins.poll(request, () => { throw new Error('Fixture rollback'); }), /Fixture rollback/);
  assert.equal(f.store.get<any>('join_request', request.requestId).state, 'APPROVED');
  assert.equal(f.store.list('actor').length, 1);
  assert.equal((f.store.db.prepare('SELECT count(*) AS count FROM credentials').get() as { count: number }).count, 1);
  const result = f.poll(request);
  assert.equal(result.state, 'APPROVED');
  if (!('token' in result) || !result.token) throw new Error('Expected a credential');
  assert.equal(result.actor.name, ' Neon ');
  assert.deepEqual(result.firstSteps, { role: 'pm' });
  const actor = f.store.authenticate(result.token);
  assert.equal(actor.harness, 'other');
  assert.equal(actor.joinedVia, 'join_request');
  assert.equal(actor.joinedAt, new Date(f.now()).toISOString());
  assert.deepEqual(f.poll(request), { ok: true, state: 'CLAIMED' });
  const stored = ['records', 'credentials', 'receipts', 'events'].map(table => f.store.db.prepare(`SELECT * FROM ${table}`).all());
  assert.ok(!JSON.stringify(stored).includes(result.token));
  assert.ok(!JSON.stringify(stored).includes(request.secret));
  assert.deepEqual(f.store.db.prepare('SELECT actor_id FROM credentials WHERE hash=?').get(hash(result.token)), { actor_id: actor.id });
  assert.deepEqual(JSON.parse((f.store.db.prepare("SELECT data FROM events WHERE operation='actor_enroll'").get() as { data: string }).data),
    { name: ' Neon ', role: 'pm', harness: 'other', requestId: request.requestId, via: 'join_request', decidedChannel: 'browser', channel: 'confirmed' });
});

test('workspace checks, duplicate, cooldown, pending and rolling limit apply in order', t => {
  const f = fixture(t, false);
  assert.throws(() => f.create('No workspace'), { code: 'NO_WORKSPACE' });
  const first = f.addWorkspace('Fixture');
  assert.throws(() => f.joins.create({ workspaceId: 'unknown', name: 'Unknown', role: 'lead', harness: 'other' }), { code: 'NOT_FOUND' });
  f.addWorkspace('Second');
  assert.throws(() => f.create('Ambiguous'), { code: 'WORKSPACE_REQUIRED' });
  const create = (name: string, harness: 'other' | 'codex' = 'other') => f.joins.create({ workspaceId: first.id, name, role: 'lead', harness });
  const decide = (id: string, decision: 'APPROVE' | 'REFUSE') =>
    decideJoinRequest(f.store, f.actor, { workspaceId: first.id, requestId: id, decision, expectedVersion: 1 }, f.now());
  const refused = create('Refused');
  decide(refused.requestId, 'REFUSE');
  assert.equal(f.poll(refused).state, 'REFUSED');
  const pending = Array.from({ length: 5 }, (_, n) => create(`Pending ${n}`));
  assert.throws(() => create('Pending 0'), { code: 'JOIN_REQUEST_PENDING' });
  assert.throws(() => create('Refused', 'codex'), { code: 'JOIN_REQUEST_REFUSED_RECENTLY', details: { retryAfterSeconds: 600 } });
  assert.throws(() => create('Sixth'), { code: 'JOIN_REQUESTS_PENDING_LIMIT' });
  for (const request of pending) decide(request.requestId, 'APPROVE');
  for (let n = 0; n < 4; n++) decide(create(`Remaining ${n}`).requestId, 'APPROVE');
  assert.throws(() => create('Eleventh'), { code: 'JOIN_RATE_LIMIT', details: { retryAfterSeconds: 600 } });
  assert.equal(f.store.list('actor').length, 1);
  f.advance(600_000);
  assert.equal(create('Refused').state, 'PENDING');
});

test('pending and approved requests expire at their exact boundaries', t => {
  const f = fixture(t);
  const pending = f.create('Pending');
  const approved = f.create('Approved');
  f.advance(1);
  f.decide(approved.requestId, 'APPROVE');
  f.advance(599_999);
  assert.deepEqual(pendingJoinRequests(f.store, f.workspaceId, f.now()), []);
  assert.equal(f.store.get<any>('join_request', pending.requestId).state, 'PENDING');
  assert.throws(() => f.decide(pending.requestId, 'APPROVE'), { code: 'JOIN_REQUEST_EXPIRED' });
  assert.deepEqual(f.poll(pending), { ok: true, state: 'EXPIRED' });
  assert.equal(f.store.get<any>('join_request', pending.requestId).version, 2);
  f.advance(1);
  assert.deepEqual(f.poll(approved), { ok: true, state: 'EXPIRED' });
  assert.equal(f.store.list('actor').length, 1);
});

test('first steps reuse the role catalog and only point to readable actionable issues', t => {
  const f = fixture(t);
  const { issue } = f.flow.execute(f.actor, 'issue_create', { workspaceId: f.workspaceId, title: 'Design required', description: 'Fixture requirement', criteria: ['AC1'], idempotencyKey: 'issue' }) as any;
  const connect = { endpoint: 'http://127.0.0.1:43170', mcp: { command: process.execPath, args: ['cli.js', 'mcp'], env: ['AGILEDEV_ENDPOINT', 'AGILEDEV_TOKEN'] } };
  for (const role of agentRoles) {
    const request = f.joins.create({ name: role, role, harness: 'other' });
    f.decide(request.requestId, 'APPROVE');
    const claim = f.joins.poll(request, (actor, workspace) => firstSteps(f.flow, actor, workspace, connect));
    if (!('firstSteps' in claim) || !claim.firstSteps) throw new Error('Expected first steps');
    const steps = claim.firstSteps;
    assert.equal(steps.summary, roleInstructions(role));
    assert.deepEqual(steps.operations, toolsForRole(role));
    assert.equal(steps.report, reportRule);
    assert.equal(steps.session, sessionRule);
    assert.deepEqual(steps.readFirst.map(row => row.issueId), role === 'lead' ? [issue.id] : []);
  }

  const write = (op: string, args: object = {}) => executeFixture(f.flow, f.actor, op, {
    workspaceId: f.workspaceId, issueId: issue.id, expectedVersion: f.store.get<any>('issue', issue.id).version,
    idempotencyKey: op, ...args,
  }) as any;
  const design = write('design_set', { content: 'Fixture design', criteria: ['AC1'] }).issue.designId;
  write('design_submit');
  write('design_decide', { designId: design, decision: 'APPROVED' });
  const pm = f.store.list<any>('actor').find(actor => actor.role === 'pm');
  assert.deepEqual(firstSteps(f.flow, pm, f.workspace, connect).readFirst.map(row => row.issueId), [issue.id]);
});
