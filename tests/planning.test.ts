import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Actor, DomainError, Issue, Plan } from '../src/contracts.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { bindFixtureImplementation } from './fixtures.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function fixture(criteria = ['A', 'B', 'ASSEMBLY']) {
  const store = new Store(':memory:');
  cleanup.push(() => store.close());
  const flow = new Workflow(store);
  const source = mkdtempSync(join(tmpdir(),'agiledev-plan-unit-'));
  cleanup.push(() => rmSync(source,{ recursive: true,force: true }));
  const human = store.bootstrap().actor;
  const call = (actor: Actor, op: string, input: object) =>
    flow.execute(actor, op, {
      ...input,
      ...(['plan_get', 'issue_get'].includes(op) ? {} : { idempotencyKey: randomUUID() })
    }) as any;
  const workspace = call(human, 'workspace_register', {
    root: source,
    name: 'Planning fixture',
    prefix: 'PLAN'
  }).workspace;
  const run = (op: string, input: object, actor = human) => call(actor, op, { workspaceId: workspace.id, ...input });
  const root = run('issue_create', {
    title: 'Integrated requirement',
    description: 'Deliver A and B and verify their assembly',
    criteria
  }).issue as Issue;
  const current = (id = root.id) => store.get<Issue>('issue', id);
  const change = (op: string, id: string, input: object, actor = human) =>
    run(op, { issueId: id, expectedVersion: current(id).version, ...input }, actor);
  change('design_set', root.id, {
    content: 'Implement assigned criteria and verify the integrated artifact independently.',
    criteria
  });
  const pm = run('actor_enroll', { role: 'pm', name: 'Fixture planner' }).actor as Actor;
  const worker = run('actor_enroll', { role: 'worker', name: 'Fixture worker' }).actor as Actor;
  const approve = () => {
    change('design_submit', root.id, {});
    change('design_decide', root.id, {
      designId: current().designId,
      decision: 'APPROVED',
      reason: 'Automated fixture design approval only'
    });
  };
  const task = (ref: string, criteria: string[]) => ({
    ref,
    title: `[Feature] ${ref}: implement assigned scope -> observable output`,
    description: `Own ${ref} implementation and evidence`,
    criteria,
    dependencies: [] as ({ ref: string } | { issueId: string })[]
  });
  const packet = (tasks: any[], extra: object = {}) => ({
    workspaceId: workspace.id,
    issueId: root.id,
    expectedVersion: current().version,
    expectedPlanId: current().planId ?? null,
    designId: current().designId,
    mode: 'READY',
    tasks,
    integrationCriteria: ['ASSEMBLY'],
    reason: 'Explicit automated fixture decomposition',
    ...extra
  });
  const apply = (tasks: any[], extra: object = {}) =>
    flow.execute(pm, 'plan_apply', { ...packet(tasks, extra), idempotencyKey: randomUUID() }) as any;
  const existingTasks = () =>
    store
      .list<Issue>('issue', workspace.id)
      .filter((i) => i.parentId === root.id)
      .map((i, index) => ({
        ref: `task${index}`,
        issueId: i.id,
        expectedVersion: i.version,
        title: i.title,
        description: i.description,
        criteria: i.criteria,
        dependencies: i.dependencies.map((issueId) => ({ issueId }))
      }));
  return {
    store,
    flow,
    human,
    pm,
    worker,
    workspace,
    root,
    current,
    run,
    change,
    approve,
    task,
    packet,
    apply,
    existingTasks
  };
}
const rejects = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('an atomic PM plan creates unstarted cross-harness assignments, dependencies and explicit integration coverage once', () => {
  const f = fixture();
  f.approve();
  const a = {
    ...f.task('client', ['A']),
    assigneeId: f.worker.id,
    harness: 'codex',
    estimate: { value: 3, unit: 'hours', confidence: 'low' },
    iteration: 'Iteration 1'
  };
  const b = { ...f.task('service', ['B']), dependencies: [{ ref: 'client' }], assigneeId: f.worker.id, harness: 'dsh' };
  const command = { ...f.packet([a, b]), idempotencyKey: 'stable-plan' };
  const one = f.flow.execute(f.pm, 'plan_apply', command) as any;
  const replay = f.flow.execute(f.pm, 'plan_apply', command) as any;
  assert.equal(replay.replayed, true);
  assert.equal(replay.plan.id, one.plan.id);
  assert.equal(f.store.list<Issue>('issue', f.workspace.id).length, 3);
  assert.equal(f.store.list<Plan>('plan', f.workspace.id).length, 1);
  assert.equal(one.coverage.ready, true);
  assert.deepEqual(one.coverage.criteria.find((c: any) => c.criterionId === 'ASSEMBLY').tasks, []);
  const first = f.current(one.taskIds.client);
  const second = f.current(one.taskIds.service);
  assert.equal(first.state, 'NOT_STARTED');
  assert.equal(second.state, 'NOT_STARTED');
  assert.equal(first.harness, 'codex');
  assert.equal(second.harness, 'dsh');
  assert.deepEqual(first.estimate, { value: 3, unit: 'hours', confidence: 'low' });
  assert.equal(first.iteration, 'Iteration 1');
  assert.deepEqual(second.dependencies, [first.id]);
  assert.ok(f.flow.readiness(second).blocking.includes('DEPENDENCY_BLOCKED'));
  assert.equal(f.store.list('run', f.workspace.id).length, 0);
});

test('draft decomposition can precede approval but readiness never invents coverage or a human decision', () => {
  const f = fixture();
  const draft = f.apply([f.task('client', ['A'])], { mode: 'DRAFT', integrationCriteria: [] });
  assert.equal(draft.plan.mode, 'DRAFT');
  assert.equal(draft.coverage.ready, false);
  assert.ok(draft.coverage.blocking.includes('PLAN_CRITERIA_UNMAPPED'));
  assert.ok(draft.coverage.blocking.includes('DESIGN_APPROVAL_REQUIRED'));
  assert.equal(f.store.list('approval', f.workspace.id).length, 0);
  assert.throws(() => f.apply(f.existingTasks()), rejects('PLAN_NOT_READY'));
  f.approve();
  const planned = f.existingTasks();
  planned.push(f.task('service', ['B']) as any);
  const ready = f.apply(planned);
  assert.equal(ready.coverage.ready, true);
  assert.equal(ready.coverage.unassigned.length, 2);
  assert.equal(f.current().state, 'NOT_STARTED');
  assert.equal(f.current().assignee, null);
});

test('failed coverage, duplicate ownership, references and cycles roll back tasks, versions, keys and audit together', () => {
  const f = fixture();
  f.approve();
  const before = () => ({
    issues: f.store.list('issue'),
    events: f.store.db.prepare('SELECT * FROM events').all(),
    workspace: f.store.get('workspace', f.workspace.id),
    plans: f.store.list('plan')
  });
  const baseline = before();
  assert.throws(() => f.apply([f.task('client', ['unknown'])]), rejects('PLAN_NOT_READY'));
  assert.deepEqual(before(), baseline);
  assert.throws(() => f.apply([f.task('client', ['A']), f.task('other', ['A', 'B'])]), rejects('PLAN_NOT_READY'));
  assert.deepEqual(before(), baseline);
  assert.throws(
    () => f.apply([{ ...f.task('client', ['A', 'B']), dependencies: [{ ref: 'missing' }] }]),
    rejects('PLAN_REFERENCE_INVALID')
  );
  assert.deepEqual(before(), baseline);
  assert.throws(
    () =>
      f.apply([
        { ...f.task('client', ['A']), dependencies: [{ ref: 'service' }] },
        { ...f.task('service', ['B']), dependencies: [{ ref: 'client' }] }
      ]),
    rejects('DEPENDENCY_CYCLE')
  );
  assert.deepEqual(before(), baseline);
  assert.throws(() => f.apply([f.task('client', ['A', 'A', 'B'])]), rejects('PLAN_DUPLICATE_CRITERION'));
  assert.deepEqual(before(), baseline);
  const explained = f.apply([f.task('client', ['A']), f.task('service', ['A', 'B'])], {
    overlapReasons: { A: 'Client and service jointly satisfy the end-to-end criterion.' }
  });
  assert.equal(explained.coverage.ready, true);
  assert.equal(explained.coverage.criteria[0].overlap, true);
});

test('plan replacement checks all child versions and cannot hide an existing or abandoned task by omission', () => {
  const f = fixture();
  f.approve();
  f.apply([f.task('client', ['A']), f.task('service', ['B'])]);
  const tasks = f.existingTasks();
  const stale = { ...f.packet(tasks), idempotencyKey: 'stale-plan' };
  f.change('issue_update', tasks[0].issueId, { dueDate: '2026-12-01' });
  assert.throws(() => f.flow.execute(f.pm, 'plan_apply', stale), rejects('VERSION_CONFLICT'));
  assert.equal(f.run('plan_get', { issueId: f.root.id }).coverage.ready, true);
  const current = f.existingTasks();
  const incomplete = f.existingTasks() as Record<string, any>[];
  delete incomplete[0]!.description;
  assert.throws(() => f.apply(incomplete), rejects('PLAN_TASK_INCOMPLETE'));
  assert.equal(f.current(current[0]!.issueId).description, current[0]!.description);
  assert.throws(() => f.apply(current.slice(0, 1)), rejects('PLAN_TASK_OMITTED'));
  f.change('issue_transition', current[1].issueId, {
    action: 'abandon',
    reason: 'Fixture child cancellation does not deliver scope'
  });
  assert.throws(() => f.apply(f.existingTasks().slice(0, 1)), rejects('PLAN_TASK_OMITTED'));
  assert.equal(f.run('plan_get', { issueId: f.root.id }).coverage.children.abandoned, 1);
});

test('scope edits stale admission while metadata preserves coverage and unrelated acknowledged work can still renew', () => {
  const f = fixture();
  f.approve();
  const plan = f.apply([f.task('client', ['A']), f.task('service', ['B'])]);
  const a = plan.taskIds.client;
  const b = plan.taskIds.service;
  f.change('issue_assign', a, { actorId: f.worker.id, harness: 'codex' });
  const execution = bindFixtureImplementation(f.flow,f.pm,f.worker,a); cleanup.push(execution.dispose);
  f.change('work_claim', a, { designId: f.current().designId, scopeRevision: f.current(a).scopeRevision }, execution.actor);
  execution.activate();
  f.change('issue_update', b, { description: 'Refined unstarted B scope under the same approved criterion' }, f.pm);
  assert.equal(f.run('plan_get', { issueId: f.root.id }).coverage.status, 'STALE');
  assert.ok(f.flow.readiness(f.current(a)).blocking.includes('PLAN_STALE'));
  assert.equal(f.flow.readiness(f.current(a), false).ready, true);
  f.change('work_heartbeat', a, { fence: f.current(a).fence }, execution.actor);
  f.change('issue_assign', b, { actorId: f.worker.id, harness: 'dsh' });
  assert.throws(
    () => f.change('work_dispatch', b, { designId: f.current().designId, scopeRevision: f.current(b).scopeRevision }),
    rejects('NOT_READY')
  );
  f.apply(f.existingTasks());
  f.change('issue_update', b, { priority: 1, plannedStart: '2026-12-01', dueDate: '2026-12-02' });
  assert.equal(f.run('plan_get', { issueId: f.root.id }).coverage.ready, true);
});

test('whole-plan edge reversal validates the final graph and aggregate dependency cycles are rejected', () => {
  const f = fixture();
  f.approve();
  f.apply([{ ...f.task('client', ['A']), dependencies: [{ ref: 'service' }] }, f.task('service', ['B'])]);
  const tasks = f.existingTasks();
  tasks[0].dependencies = [];
  tasks[1].dependencies = [{ issueId: tasks[0].issueId }];
  f.apply(tasks);
  assert.deepEqual(f.current(tasks[0].issueId).dependencies, []);
  assert.deepEqual(f.current(tasks[1].issueId).dependencies, [tasks[0].issueId]);
  const other = f.run('issue_create', { title: 'Other aggregate' }).issue;
  const child = f.run('issue_create', {
    parentId: other.id,
    expectedParentVersion: other.version,
    title: '[Test] Other: create dependent child -> cycle detection'
  }).issue;
  f.change('dependency_set', tasks[0].issueId, { dependsOn: [other.id] });
  assert.throws(() => f.change('dependency_set', child.id, { dependsOn: [f.root.id] }), rejects('DEPENDENCY_CYCLE'));
});

test('planning cannot import foreign task scope, dependencies or assignees, and workers cannot become planners', () => {
  const f = fixture();
  f.approve();
  const other = f.flow.execute(f.human, 'workspace_register', {
    root: process.cwd(),
    name: 'Foreign planning fixture',
    prefix: 'OTHER',
    idempotencyKey: randomUUID()
  }) as any;
  const foreign = f.flow.execute(f.human, 'issue_create', {
    workspaceId: other.workspace.id,
    title: 'Foreign requirement',
    idempotencyKey: randomUUID()
  }) as any;
  const foreignWorker = f.flow.execute(f.human, 'actor_enroll', {
    workspaceId: other.workspace.id,
    role: 'worker',
    name: 'Foreign worker',
    idempotencyKey: randomUUID()
  }) as any;
  f.change('issue_assign', f.root.id, { actorId: f.worker.id, harness: 'codex' });
  const before = () => ({
    issues: f.store.list('issue'),
    workspace: f.store.get('workspace', f.workspace.id),
    events: f.store.db.prepare('SELECT COUNT(*) AS count FROM events').get()
  });
  const baseline = before();
  assert.throws(
    () => f.apply([{ ...f.task('client', ['A', 'B']), dependencies: [{ issueId: foreign.issue.id }] }]),
    rejects('SCOPE_DENIED')
  );
  assert.deepEqual(before(), baseline);
  assert.throws(
    () => f.apply([{ ...f.task('client', ['A', 'B']), assigneeId: foreignWorker.actor.id, harness: 'codex' }]),
    rejects('SCOPE_DENIED')
  );
  assert.deepEqual(before(), baseline);
  assert.throws(
    () =>
      f.apply([{ ...f.task('client', ['A', 'B']), issueId: foreign.issue.id, expectedVersion: foreign.issue.version }]),
    rejects('PLAN_TASK_INVALID')
  );
  assert.deepEqual(before(), baseline);
  assert.throws(
    () =>
      f.flow.execute(f.worker, 'plan_apply', {
        ...f.packet([f.task('client', ['A', 'B'])]),
        idempotencyKey: randomUUID()
      }),
    rejects('ROLE_DENIED')
  );
  assert.deepEqual(before(), baseline);
  assert.throws(() => f.run('plan_get', { issueId: f.root.id }, f.worker), rejects('ROLE_DENIED'));
});

test('empty aggregates cannot be activated and summary coverage is bounded with explicit full expansion', () => {
  const f = fixture(Array.from({ length: 45 }, (_, i) => `AC${i}`));
  f.approve();
  assert.throws(() => f.apply([], { integrationCriteria: f.current().criteria }), rejects('PLAN_NOT_READY'));
  f.apply(
    Array.from({ length: 25 }, (_, i) => f.task(`part${i}`, [`AC${i}`])),
    { integrationCriteria: f.current().criteria.slice(25) }
  );
  const summary = f.run('plan_get', { issueId: f.root.id });
  assert.equal(summary.coverage.criteria.length, 20);
  assert.equal(summary.coverage.nextOffset, 20);
  assert.ok(!('tasks' in summary.plan));
  assert.ok(!('children' in summary));
  assert.equal(f.run('plan_get', { issueId: f.root.id, view: 'full' }).children.length, 25);
});
