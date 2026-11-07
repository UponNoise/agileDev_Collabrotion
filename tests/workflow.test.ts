import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Actor, DomainError, Issue } from '../src/contracts.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-test-'));
  const store = new Store(join(root, 'data.sqlite'));
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const human = store.bootstrap();
  let clock = Date.now();
  const workflow = new Workflow(store, () => clock);
  const call = (actor: Actor, op: string, input: object = {}) => workflow.execute(actor, op, { ...(['workspace_list', 'issue_get', 'issue_list', 'run_get', 'run_list', 'gap_list', 'event_list'].includes(op) ? {} : { idempotencyKey: randomUUID() }), ...input }) as any;
  const workspace = call(human.actor, 'workspace_register', { root, name: 'Test workspace', prefix: 'TEST' }).workspace;
  const enroll = (role: string) => call(human.actor, 'actor_enroll', { workspaceId: workspace.id, role, name: `${role} test` });
  const lead = enroll('lead'); const pm = enroll('pm'); const worker = enroll('worker'); const qa = enroll('qa');
  const run = (actor: Actor, op: string, input: object = {}) => call(actor, op, { workspaceId: workspace.id, ...input });
  const parent = run(lead.actor, 'issue_create', { title: 'Deliver workspace binding', description: 'Preserve the active workspace across harnesses', criteria: ['AC-1'] }).issue as Issue;
  const current = (id: string) => store.get<Issue>('issue', id);
  const change = (actor: Actor, op: string, issueId: string, input: object = {}) => run(actor, op, { issueId, expectedVersion: current(issueId).version, ...input });
  const approve = () => {
    change(lead.actor, 'design_set', parent.id, { content: 'Explicit active workspace binding and cross-harness state', criteria: ['AC-1'] });
    change(lead.actor, 'design_submit', parent.id);
    change(human.actor, 'design_decide', parent.id, { designId: current(parent.id).designId, decision: 'APPROVED', reason: 'Approve this exact test design' });
  };
  const task = () => run(pm.actor, 'issue_create', { parentId: parent.id, expectedParentVersion: current(parent.id).version, title: '[Feature] Binding: select active root -> scoped commands', description: 'Implement explicit root binding', criteria: ['AC-1'] }).issue as Issue;
  const assign = (i: Issue) => change(pm.actor, 'issue_assign', i.id, { actorId: worker.actor.id, harness: 'codex' });
  const claim = (i: Issue) => change(worker.actor, 'work_claim', i.id, { designId: current(parent.id).designId ?? 'unapproved', scopeRevision: current(i.id).scopeRevision });
  return { root, store, human, lead, pm, worker, qa, run, call, parent, current, change, approve, task, assign, claim, advance: () => { clock += 300001; } };
}
function rejects(code: string) { return (error: unknown) => error instanceof DomainError && error.code === code; }

test('draft creation, immutable IDs and rendered parent-title lineage', () => {
  const f = setup(); const task = f.task();
  assert.equal(task.state, 'NOT_STARTED'); assert.equal(task.assignee, null);
  assert.equal(task.title, 'Deliver workspace binding——[Feature] Binding: select active root -> scoped commands');
  f.change(f.lead.actor, 'issue_update', f.parent.id, { title: 'Reliable workspace binding' });
  const read = f.store.get<Issue>('issue', task.id);
  assert.equal(read.key, task.key);
  const brief = f.run(f.lead.actor, 'issue_get', { issueId: task.id });
  assert.match(brief.issue.title, /^Reliable workspace binding——/);
});

test('schema and role boundaries prevent injected state, human decisions and enrollment', () => {
  const f = setup();
  assert.throws(() => f.run(f.lead.actor, 'issue_create', { title: 'Injected', state: 'DONE' }), rejects('INVALID_INPUT'));
  assert.throws(() => f.change(f.lead.actor, 'design_decide', f.parent.id, { designId: 'fake', decision: 'APPROVED', reason: 'claim' }), rejects('ROLE_DENIED'));
  assert.throws(() => f.run(f.pm.actor, 'actor_enroll', { role: 'qa', name: 'fake qa' }), rejects('ROLE_DENIED'));
});

test('design approval and explicit scope acknowledgment gate implementation', () => {
  const f = setup(); const task = f.task(); f.assign(task);
  assert.throws(() => f.claim(task), rejects('NOT_READY'));
  f.approve();
  assert.throws(() => f.change(f.worker.actor, 'work_claim', task.id, { designId: 'stale', scopeRevision: 1 }), rejects('APPROVAL_STALE'));
  const claim = f.claim(task).issue;
  assert.equal(claim.state, 'IN_PROGRESS'); assert.equal(claim.lease.actorId, f.worker.actor.id);
  assert.equal(f.current(f.parent.id).state, 'IN_PROGRESS');
  f.advance();
  assert.throws(() => f.change(f.worker.actor, 'work_heartbeat', task.id, { fence: claim.fence }), rejects('LEASE_EXPIRED'));
});

test('replayed mutations return the original result; changed payload and stale version fail', () => {
  const f = setup(); const task = f.task();
  const input = { workspaceId: task.workspaceId, issueId: task.id, expectedVersion: task.version, priority: 1, idempotencyKey: 'stable-command' };
  const one = f.call(f.pm.actor, 'issue_update', input);
  const two = f.call(f.pm.actor, 'issue_update', input);
  assert.equal(one.issue.version, two.issue.version); assert.equal(two.replayed, true);
  assert.throws(() => f.call(f.pm.actor, 'issue_update', { ...input, priority: 2 }), rejects('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.call(f.pm.actor, 'issue_update', { ...input, idempotencyKey: 'new-key' }), rejects('VERSION_CONFLICT'));
});

test('dependency cycles and cross-workspace references are rejected atomically', () => {
  const f = setup(); const a = f.task(); const b = f.task();
  f.change(f.pm.actor, 'dependency_add', a.id, { dependsOn: b.id });
  assert.throws(() => f.change(f.pm.actor, 'dependency_add', b.id, { dependsOn: a.id }), rejects('DEPENDENCY_CYCLE'));
  assert.deepEqual(f.current(b.id).dependencies, []);
  assert.throws(() => f.change(f.pm.actor, 'dependency_add', b.id, { dependsOn: f.parent.id }), rejects('DEPENDENCY_CYCLE'));
  assert.throws(() => f.store.workspace(f.worker.actor, randomUUID()), rejects('SCOPE_DENIED'));
});

test('submitted artifacts are hashed and changing them invalidates review', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task); f.claim(task);
  writeFileSync(join(f.root, 'output.txt'), 'version one');
  f.change(f.worker.actor, 'work_submit', task.id, { fence: f.current(task.id).fence, summary: 'Implemented test output', files: ['output.txt'] });
  const submitted = f.current(task.id);
  assert.equal(submitted.stage, 'PRE_QA'); assert.equal(submitted.candidate!.files.length, 1);
  writeFileSync(join(f.root, 'output.txt'), 'version two');
  assert.throws(() => f.change(f.lead.actor, 'review_submit', task.id, { candidateId: submitted.candidate!.id, verdict: 'PASS', reason: 'reviewed' }), rejects('EVIDENCE_STALE'));
});

test('lead review hands off to QA and narrative approval cannot fake independent tests', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task); f.claim(task);
  writeFileSync(join(f.root, 'output.txt'), 'implementation');
  f.change(f.worker.actor, 'work_submit', task.id, { fence: f.current(task.id).fence, summary: 'Implemented test output', files: ['output.txt'] });
  const candidateId = f.current(task.id).candidate!.id;
  assert.throws(() => f.change(f.worker.actor, 'review_submit', task.id, { candidateId, verdict: 'PASS', reason: 'self pass' }), rejects('REVIEW_INDEPENDENCE_REQUIRED'));
  f.change(f.lead.actor, 'review_submit', task.id, { candidateId, verdict: 'PASS', reason: 'Initial review' });
  assert.equal(f.current(task.id).state, 'QA_TEST');
  assert.throws(() => f.change(f.qa.actor, 'review_submit', task.id, { candidateId, verdict: 'PASS', reason: 'Unassigned reviewer' }), rejects('SCOPE_DENIED'));
  assert.throws(() => f.change(f.qa.actor, 'review_submit', task.id, { candidateId, verdict: 'FAIL', reason: 'Unassigned narrative failure' }), rejects('SCOPE_DENIED'));
  assert.equal(f.current(task.id).state, 'QA_TEST');
});

test('ancestor holds stop submission and material design changes invalidate active ownership', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task); f.claim(task);
  f.change(f.human.actor, 'issue_transition', f.parent.id, { action: 'hold', reason: 'Pause requirement' });
  assert.throws(() => f.change(f.worker.actor, 'work_heartbeat', task.id, { fence: f.current(task.id).fence }), rejects('NOT_READY'));
  f.change(f.human.actor, 'issue_transition', f.parent.id, { action: 'resume', reason: 'Continue requirement' });
  f.change(f.lead.actor, 'design_set', f.parent.id, { content: 'Changed requirement', criteria: ['AC-2'] });
  assert.equal(f.current(task.id).lease, null); assert.equal(f.current(task.id).state, 'NOT_STARTED');
});

test('dispatch is durable and idempotent, never reported as running', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task);
  const input = { workspaceId: task.workspaceId, issueId: task.id, expectedVersion: f.current(task.id).version, designId: f.current(f.parent.id).designId, scopeRevision: 1, idempotencyKey: 'dispatch-once' };
  const first = f.call(f.pm.actor, 'work_dispatch', input);
  const second = f.call(f.pm.actor, 'work_dispatch', input);
  assert.equal(first.run.id, second.run.id); assert.equal(first.run.state, 'QUEUED');
  assert.equal(f.store.list('run', task.workspaceId).length, 1);
});

test('agent credentials persist as hashes and are excluded from receipts and events', () => {
  const f = setup();
  const rows = f.store.db.prepare('SELECT result FROM receipts').all();
  const events = f.store.db.prepare('SELECT data FROM events').all();
  const data = JSON.stringify({ rows, events });
  assert.ok(!data.includes(f.worker.token)); assert.ok(!data.includes(f.human.token));
  assert.equal(f.store.authenticate(f.worker.token).id, f.worker.actor.id);
});

test('editing requirement scope creates a fresh draft and invalidates old child approval and ownership', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task); f.claim(task);
  const previous = f.store.get<any>('design',f.current(f.parent.id).designId!);
  f.change(f.pm.actor,'issue_update',f.parent.id,{ description: 'Changed root requirement scope' });
  const current = f.current(f.parent.id); const design = f.store.get<any>('design',current.designId!);
  assert.notEqual(design.id,previous.id); assert.notEqual(design.hash,previous.hash); assert.equal(design.status,'DRAFT');
  assert.equal(design.requirementDescription,'Changed root requirement scope');
  assert.deepEqual(f.store.get('design',previous.id),previous);
  assert.equal(f.current(task.id).lease,null); assert.equal(f.current(task.id).state,'NOT_STARTED');
  assert.throws(() => f.claim(task),rejects('NOT_READY'));
  assert.ok(f.store.list<any>('approval',task.workspaceId).some(a => a.designId === previous.id && a.decision === 'APPROVED'));
  f.change(f.lead.actor,'design_submit',f.parent.id);
  f.change(f.human.actor,'design_decide',f.parent.id,{ designId: design.id,decision: 'APPROVED',reason: 'Fixture approval of the changed scope' });
  assert.equal(f.claim(task).issue.state,'IN_PROGRESS');
});

test('queued child execution blocks parent scope edits and held planning never resumes the requirement', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task);
  const queued = f.change(f.pm.actor,'work_dispatch',task.id,{ designId: f.current(f.parent.id).designId,scopeRevision: 1 }).run;
  const before = f.current(f.parent.id);
  assert.throws(() => f.change(f.pm.actor,'issue_update',f.parent.id,{ description: 'Cannot replace live child scope' }),rejects('RUN_EXISTS'));
  assert.deepEqual(f.current(f.parent.id),before);
  f.run(f.human.actor,'run_interrupt',{ runId: queued.id,expectedVersion: queued.version,reason: 'Cancel fixture queue before editing' });
  f.change(f.human.actor,'issue_transition',f.parent.id,{ action: 'hold',reason: 'Keep fixture requirement suspended' });
  f.change(f.lead.actor,'design_set',f.parent.id,{ content: 'Changed held design',criteria: ['AC-1'] });
  assert.equal(f.current(f.parent.id).state,'ON_HOLD');
  f.task(); assert.equal(f.current(f.parent.id).state,'ON_HOLD');
  f.change(f.pm.actor,'issue_update',f.parent.id,{ description: 'Changed held requirement description' });
  assert.equal(f.current(f.parent.id).state,'ON_HOLD');
  f.change(f.human.actor,'issue_transition',f.parent.id,{ action: 'resume',reason: 'Explicitly resume fixture planning' });
  assert.equal(f.current(f.parent.id).state,'NOT_STARTED');
});

test('schedule metadata preserves approval while older unbound scope cannot authorize new execution', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task);
  const designId = f.current(f.parent.id).designId!;
  f.change(f.pm.actor,'issue_update',f.parent.id,{ title: 'Renamed planning title',plannedStart: '2026-11-10',dueDate: '2026-11-20' });
  assert.equal(f.current(f.parent.id).designId,designId); assert.equal(f.store.get<any>('design',designId).status,'APPROVED');
  const older = f.store.get<any>('design',designId); delete older.requirementDescription; f.store.put('design',older,task.workspaceId);
  assert.throws(() => f.claim(task),(error: any) => error.code === 'NOT_READY' && error.details.blockers.includes('DESIGN_SCOPE_STALE'));
});
