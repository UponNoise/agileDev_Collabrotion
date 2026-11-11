import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Actor, DomainError, Issue, Run, ScopeDecision, Workspace } from '../src/contracts.js';
import { IterationService, iterationIssueView, iterationMembershipHash, rejectLegacyIterationWrite } from '../src/iterations.js';
import { Iteration, IterationIssue, IterationMembershipEvent, IterationSummary } from '../src/iteration-contracts.js';
import { Store, canonical, hash } from '../src/store.js';
import { scopeBinding, scopeState } from '../src/scope.js';
import { Workflow } from '../src/workflow.js';
import { Coordinator } from '../src/runner.js';
import { AdapterContext, AdapterResult, ExecutionAdapter } from '../src/adapters.js';
import { createServer } from '../src/http.js';
import { LocalClient } from '../src/client.js';
import { applyFixturePlan } from './fixtures.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const rejects = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

function fixture() {
  const store = new Store(':memory:');
  cleanup.push(() => store.close());
  const human = store.bootstrap().actor;
  const workspace: Workspace = { id: randomUUID(), name: 'Iteration core fixture', root: '/unused-iteration-fixture', prefix: 'ITER', sequence: 0, commonDir: null };
  store.put('workspace', workspace, workspace.id);
  let clock = Date.now();
  const service = new IterationService(store, () => clock);
  const actor = (role: Actor['role']) => {
    const value: Actor = { id: randomUUID(), name: `Iteration fixture ${role}`, role, workspaceIds: [workspace.id], sessionId: randomUUID() };
    store.token(value);
    return value;
  };
  const pm = actor('pm');
  const worker = actor('worker');
  const qa = actor('qa');
  const issue = (extra: Partial<IterationIssue> = {}) => {
    workspace.sequence++;
    const value: IterationIssue = { id: randomUUID(), workspaceId: workspace.id, key: `ITER-${workspace.sequence}`, parentId: null, title: 'Iteration fixture issue', description: 'Core planning metadata fixture, not a human product approval', state: 'NOT_STARTED', stage: null, version: 1, scopeRevision: 1, criteria: ['A'], assignee: worker.id, harness: 'codex', dependencies: [], priority: 2, plannedStart: null, dueDate: null, designId: null, fence: 0, lease: null, candidate: null, initialReview: null, qaReview: null, finalReview: null, savedState: null, ...extra };
    store.put('issue', value, value.workspaceId);
    return value;
  };
  const current = (id: string) => store.get<Iteration>('iteration', id);
  const currentIssue = (id: string) => store.get<IterationIssue>('issue', id);
  const create = (extra: object = {}) => service.mutate(pm, 'iteration_create', { workspaceId: workspace.id, idempotencyKey: randomUUID(), name: 'Deliver the slice', goal: 'Traceable iteration core fixture', startDate: '2026-11-01', endDate: '2026-11-14', timeZone: 'Asia/Taipei', reason: 'Explicit iteration planning fixture', ...extra }).iteration as Iteration;
  const move = (issues: IterationIssue[], target: Iteration | null, extraSnapshots: Iteration[] = []) => {
    const ids = new Set(issues.flatMap(value => [currentIssue(value.id).iterationId, target?.id].filter((id): id is string => !!id)));
    const memberships = [...new Map([...ids].map(id => [id, current(id)])).values(), ...extraSnapshots].map(iteration => service.precondition(iteration));
    return service.mutate(pm, 'iteration_membership_set', { workspaceId: workspace.id, idempotencyKey: randomUUID(), changes: issues.map(value => ({ issueId: value.id, expectedVersion: currentIssue(value.id).version, iterationId: target?.id ?? null })), memberships, reason: 'Explicit membership fixture' });
  };
  const closeInput = (iteration: Iteration, targets = new Map<string, Iteration | null>()) => {
    const item = current(iteration.id);
    const members = store.list<IterationIssue>('issue', workspace.id).filter(value => value.iterationId === item.id);
    return { workspaceId: workspace.id, idempotencyKey: randomUUID(), ...service.precondition(item), members: members.map(value => ({ issueId: value.id, expectedVersion: value.version })), dispositions: members.filter(value => !['DONE', 'ABANDONED'].includes(value.state)).map(value => ({ issueId: value.id, iterationId: targets.get(value.id)?.id ?? null })), destinations: [...new Map([...targets.values()].filter((value): value is Iteration => !!value).map(value => [value.id, current(value.id)])).values()].map(value => service.precondition(value)), reason: 'Explicit close fixture with complete membership' };
  };
  const view = (iteration: Iteration, who = human, extra: object = {}) => service.read(who, 'iteration_get', { workspaceId: workspace.id, iterationId: iteration.id, ...extra }) as any;
  const eventCount = () => (store.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count;
  return { store, service, human, pm, worker, qa, workspace, actor, issue, current, currentIssue, create, move, closeInput, view, eventCount, setClock: (value: string) => { clock = Date.parse(value); } };
}

test('iteration core validates calendar dates, time zone, immutable close, and one active record per workspace', () => {
  const f = fixture();
  assert.throws(() => f.create({ startDate: '2026-02-30' }), rejects('INVALID_INPUT'));
  assert.throws(() => f.create({ timeZone: 'Not/A_TimeZone' }), rejects('INVALID_INPUT'));
  assert.throws(() => f.create({ startDate: '2026-11-15' }), rejects('ITERATION_DATES_INVALID'));
  const first = f.create();
  const second = f.create({ name: 'A later iteration' });
  assert.equal(first.state, 'PLANNED');
  assert.equal(first.membershipRevision, 0);
  assert.equal(first.membershipHash, iterationMembershipHash([]));
  f.service.mutate(f.pm, 'iteration_start', { workspaceId: f.workspace.id, iterationId: first.id, expectedVersion: first.version, idempotencyKey: randomUUID(), reason: 'Explicit start' });
  assert.throws(() => f.service.mutate(f.pm, 'iteration_start', { workspaceId: f.workspace.id, iterationId: second.id, expectedVersion: second.version, idempotencyKey: randomUUID(), reason: 'Competing start' }), rejects('ITERATION_ACTIVE_EXISTS'));
  f.service.mutate(f.human, 'iteration_close', f.closeInput(first));
  assert.throws(() => f.service.mutate(f.pm, 'iteration_update', { workspaceId: f.workspace.id, iterationId: first.id, expectedVersion: f.current(first.id).version, idempotencyKey: randomUUID(), name: 'Rewrite closed work', reason: 'Must be rejected' }), rejects('ITERATION_CLOSED'));
  f.service.mutate(f.pm, 'iteration_start', { workspaceId: f.workspace.id, iterationId: second.id, expectedVersion: second.version, idempotencyKey: randomUUID(), reason: 'Start after explicit close' });
});

test('membership is issue-local, scope-checked planning metadata and preserves existing artifact and authorization fields', () => {
  const f = fixture();
  const parent = f.issue({ title: 'Parent planning fixture', state: 'USER_ACCEPTANCE', acceptedDigest: 'unchanged-fixture-digest', initialReview: 'initial', qaReview: 'qa', finalReview: 'final', planId: 'retained-plan' });
  const child = f.issue({ parentId: parent.id, title: '[Feature] Child: plan work -> explicit membership' });
  const iteration = f.create();
  const before = f.currentIssue(parent.id);
  f.move([parent], iteration);
  const after = f.currentIssue(parent.id);
  const { version: _beforeVersion, iterationId: _beforeIteration, ...previousArtifact } = before;
  const { version: _afterVersion, iterationId: _afterIteration, ...nextArtifact } = after;
  assert.deepEqual(nextArtifact, previousArtifact);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.iterationId, iteration.id);
  assert.equal(f.currentIssue(child.id).iterationId, undefined);
  const moved = f.current(iteration.id);
  assert.equal(moved.membershipRevision, 1);
  assert.equal(moved.membershipHash, createHash('sha256').update(JSON.stringify([parent.id].sort())).digest('hex'));
  assert.equal(f.store.list('run', f.workspace.id).length, 0);
  const eventCount = f.eventCount();
  assert.throws(() => f.service.mutate(f.worker, 'iteration_membership_set', { workspaceId: f.workspace.id }), rejects('ROLE_DENIED'));
  assert.equal(f.eventCount(), eventCount);
});

test('cross-workspace and terminal additions fail without partially moving earlier members', () => {
  const f = fixture();
  const iteration = f.create();
  const one = f.issue();
  const done = f.issue({ state: 'DONE' });
  assert.throws(() => f.move([one, done], iteration), rejects('ISSUE_CLOSED'));
  assert.equal(f.currentIssue(one.id).iterationId, undefined);
  assert.equal(f.current(iteration.id).membershipRevision, 0);
  const foreign: Workspace = { ...f.workspace, id: randomUUID(), name: 'Unrelated fixture workspace' };
  f.store.put('workspace', foreign, foreign.id);
  const wrong = f.issue({ workspaceId: foreign.id });
  assert.throws(() => f.move([one, wrong], iteration), rejects('SCOPE_DENIED'));
  assert.equal(f.currentIssue(one.id).iterationId, undefined);
});

test('membership revision and complete sets reject close races including newly added or omitted members', () => {
  const f = fixture();
  const iteration = f.create();
  const one = f.issue();
  f.move([one], iteration);
  const stale = f.closeInput(iteration);
  const two = f.issue();
  f.move([two], iteration);
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', stale), rejects('VERSION_CONFLICT'));
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', { ...stale, expectedVersion: f.current(iteration.id).version }), rejects('ITERATION_MEMBERSHIP_STALE'));
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', { ...f.closeInput(iteration), members: [{ issueId: one.id, expectedVersion: f.currentIssue(one.id).version }] }), rejects('ITERATION_MEMBERSHIP_STALE'));
  const complete = f.closeInput(iteration);
  f.move([two], null);
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', complete), rejects('VERSION_CONFLICT'));
  assert.equal(f.current(iteration.id).state, 'PLANNED');
  assert.equal(f.currentIssue(one.id).iterationId, iteration.id);
});

test('a failed nested membership writer rolls back every record, revision, and audit event', () => {
  const f = fixture();
  const iteration = f.create();
  const one = f.issue();
  const two = f.issue();
  const before = canonical({ iteration: f.current(iteration.id), issues: [f.currentIssue(one.id), f.currentIssue(two.id)], events: f.eventCount() });
  let writes = 0;
  assert.throws(() => f.service.changeMembership(f.pm, f.workspace.id, [one, two].map(issue => ({ issueId: issue.id, expectedVersion: issue.version, iterationId: iteration.id })), [f.service.precondition(iteration)], 'Rollback fixture', issue => {
    if (++writes === 2) throw new DomainError('FIXTURE_REJECTED', 'Explicit second-write fixture failure');
    issue.version++;
    f.store.put('issue', issue, issue.workspaceId);
    f.store.event(issue.workspaceId, f.pm, 'fixture_metadata_write', issue.id, { version: issue.version });
  }), rejects('FIXTURE_REJECTED'));
  assert.equal(canonical({ iteration: f.current(iteration.id), issues: [f.currentIssue(one.id), f.currentIssue(two.id)], events: f.eventCount() }), before);
});

test('close binds destination sets, requires every unfinished disposition, and preserves immutable history after reopen', () => {
  const f = fixture();
  const iteration = f.create();
  const target = f.create({ name: 'Carry-over destination' });
  const done = f.issue();
  const abandoned = f.issue();
  const carry = f.issue();
  const backlog = f.issue();
  f.move([done, abandoned, carry, backlog], iteration);
  f.store.put('issue', { ...f.currentIssue(done.id), state: 'DONE', version: 3 }, f.workspace.id);
  f.store.put('issue', { ...f.currentIssue(abandoned.id), state: 'ABANDONED', version: 3 }, f.workspace.id);
  const targets = new Map([[carry.id, target]]);
  const input = f.closeInput(iteration, targets);
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', { ...input, dispositions: input.dispositions.slice(0, 1) }), rejects('ITERATION_DISPOSITION_REQUIRED'));
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', { ...input, destinations: [] }), rejects('ITERATION_MEMBERSHIP_REQUIRED'));
  const added = f.issue();
  f.move([added], target);
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', input), rejects('VERSION_CONFLICT'));
  const closed = f.service.mutate(f.pm, 'iteration_close', f.closeInput(iteration, targets));
  const summary = closed.summary as IterationSummary;
  assert.deepEqual({ done: summary.counts.done, abandoned: summary.counts.abandoned, carried: summary.counts.carried, returned: summary.counts.returned }, { done: 1, abandoned: 1, carried: 1, returned: 1 });
  assert.equal(f.currentIssue(done.id).iterationId, null);
  assert.equal(f.currentIssue(abandoned.id).iterationId, null);
  assert.equal(f.currentIssue(carry.id).iterationId, target.id);
  assert.equal(f.currentIssue(backlog.id).iterationId, null);
  const frozen = canonical(f.store.get('iteration_summary', summary.id));
  f.store.put('issue', { ...f.currentIssue(done.id), state: 'NOT_STARTED', version: f.currentIssue(done.id).version + 1 }, f.workspace.id);
  assert.equal(f.currentIssue(done.id).iterationId, null);
  assert.equal(canonical(f.store.get('iteration_summary', summary.id)), frozen);
  assert.equal(f.view(iteration).progress.counts.DONE, 1);
  const historicalRow = f.view(iteration).members.find((value: any) => value.id === done.id);
  assert.equal(historicalRow.state, 'NOT_STARTED');
  assert.equal(historicalRow.stateAtClose, 'DONE');
  const exported = f.view(iteration, f.human, { view: 'markdown' });
  assert.equal(exported.mediaType, 'text/markdown');
  assert.match(exported.content, /CARRIED/);
  assert.doesNotMatch(exported.content, /unused-iteration-fixture/);
});

test('carry-over to active, closed, same, or another workspace cannot alter source membership', () => {
  const f = fixture();
  const iteration = f.create();
  const target = f.create({ name: 'Target' });
  const issue = f.issue();
  f.move([issue], iteration);
  f.service.mutate(f.pm, 'iteration_start', { workspaceId: f.workspace.id, iterationId: target.id, expectedVersion: target.version, idempotencyKey: randomUUID(), reason: 'Active fixture target' });
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', f.closeInput(iteration, new Map([[issue.id, target]]))), rejects('ITERATION_CARRY_OVER_INVALID'));
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', f.closeInput(iteration, new Map([[issue.id, iteration]]))), rejects('ITERATION_CARRY_OVER_INVALID'));
  f.service.mutate(f.pm, 'iteration_close', f.closeInput(target));
  assert.throws(() => f.service.mutate(f.pm, 'iteration_close', f.closeInput(iteration, new Map([[issue.id, target]]))), rejects('ITERATION_CARRY_OVER_INVALID'));
  assert.equal(f.currentIssue(issue.id).iterationId, iteration.id);
});

test('legacy labels are a non-destructive read projection and adoption binds the complete eligible version set', () => {
  const f = fixture();
  const old = f.issue({ iteration: 'Legacy label' });
  const historical = f.issue({ state: 'DONE', iteration: 'Legacy label' });
  const original = canonical(f.currentIssue(old.id));
  assert.equal(iterationIssueView(old).legacyIterationLabel, 'Legacy label');
  assert.equal(Object.hasOwn(iterationIssueView(old), 'iteration'), false);
  assert.equal(canonical(f.currentIssue(old.id)), original);
  assert.equal(f.store.list('iteration', f.workspace.id).length, 0);
  const preview = f.service.adoptionPreview(f.pm, f.workspace.id, 'Legacy label');
  assert.deepEqual(preview.matches.map(match => match.issueId), [old.id]);
  const added = f.issue({ iteration: 'Legacy label' });
  assert.throws(() => f.create({ adoption: { ...preview, memberships: [] } }), rejects('ITERATION_ADOPTION_STALE'));
  assert.equal(f.store.list('iteration', f.workspace.id).length, 0);
  const current = f.service.adoptionPreview(f.pm, f.workspace.id, 'Legacy label');
  const adopted = f.create({ adoption: { ...current, memberships: [] } });
  assert.equal(f.currentIssue(old.id).iterationId, adopted.id);
  assert.equal(f.currentIssue(added.id).iterationId, adopted.id);
  assert.equal(f.currentIssue(old.id).iteration, 'Legacy label');
  assert.equal(f.currentIssue(historical.id).iterationId, undefined);
  assert.equal(f.currentIssue(old.id).scopeRevision, old.scopeRevision);
  assert.throws(() => rejectLegacyIterationWrite({ iteration: null }), error => error instanceof DomainError && error.code === 'ITERATION_FIELD_RETIRED' && error.message.includes('iterationId'));
});

test('legacy adoption detects a newly reopened match, version edits, and destination membership races', () => {
  const f = fixture();
  const iteration = f.create();
  const old = f.issue({ iteration: 'Legacy' });
  const done = f.issue({ iteration: 'Legacy', state: 'DONE' });
  const initial = f.service.adoptionPreview(f.pm, f.workspace.id, 'Legacy');
  f.store.put('issue', { ...done, state: 'NOT_STARTED', version: 2 }, f.workspace.id);
  assert.throws(() => f.create({ adoption: { ...initial, memberships: [] } }), rejects('ITERATION_ADOPTION_STALE'));
  const preview = f.service.adoptionPreview(f.pm, f.workspace.id, 'Legacy');
  const snapshot = f.service.precondition(f.current(iteration.id));
  f.move([f.issue()], iteration);
  assert.throws(() => f.service.mutate(f.pm, 'iteration_membership_set', { workspaceId: f.workspace.id, idempotencyKey: randomUUID(), adoption: preview, changes: preview.matches.map(match => ({ ...match, iterationId: iteration.id })), memberships: [snapshot], reason: 'Stale destination must reject' }), rejects('VERSION_CONFLICT'));
  assert.equal(f.currentIssue(old.id).iterationId, undefined);
  f.store.put('issue', { ...f.currentIssue(old.id), title: 'A concurrent metadata edit', version: 2 }, f.workspace.id);
  assert.throws(() => f.create({ adoption: { ...preview, memberships: [] } }), rejects('ITERATION_ADOPTION_STALE'));
});

test('worker and QA projections expose only existing assigned/parent read scope, never hidden members or adoption sets', () => {
  const f = fixture();
  const iteration = f.create();
  const visible = f.issue({ qaAssignee: f.qa.id, estimate: { value: 2, unit: 'hours', confidence: 'low' } });
  const hidden = f.issue({ assignee: randomUUID(), qaAssignee: randomUUID(), title: 'Hidden unrelated work', estimate: { value: 99, unit: 'points', confidence: 'high' }, iteration: 'Private label' });
  f.move([visible, hidden], iteration);
  for (const who of [f.worker, f.qa]) {
    const view = f.view(iteration, who, { view: 'full' });
    assert.equal(view.total, 1);
    assert.deepEqual(view.members.map((issue: Issue) => issue.id), [visible.id]);
    assert.equal(view.iteration.partial, true);
    assert.equal(view.iteration.membershipHash, undefined);
    assert.equal(view.summary, undefined);
    assert.equal(view.progress.estimates.points, 0);
    assert.equal(view.progress.runCapacity.workspaceActiveRuns, null);
    assert.equal(view.progress.runCapacity.installationActiveRuns, undefined);
    assert.throws(() => f.view(iteration, who, { legacyLabel: 'Private label' }), rejects('ROLE_DENIED'));
    assert.throws(() => f.view(iteration, who, { view: 'markdown' }), rejects('ROLE_DENIED'));
  }
  const unrelated = f.create({ name: 'Unrelated empty iteration' });
  assert.throws(() => f.view(unrelated, f.worker), rejects('SCOPE_DENIED'));
  const list = f.service.read(f.worker, 'iteration_list', { workspaceId: f.workspace.id }) as any;
  assert.deepEqual(list.iterations.map((item: Iteration) => item.id), [iteration.id]);
  assert.equal(list.total, 1);
});

test('overdue and capacity projections are advisory and do not change lifecycle, member metadata, or timers', () => {
  const f = fixture();
  const iteration = f.create({ endDate: '2026-11-02', goal: 'x'.repeat(2000) });
  const issue = f.issue();
  f.move([issue], iteration);
  f.service.mutate(f.pm, 'iteration_start', { workspaceId: f.workspace.id, iterationId: iteration.id, expectedVersion: f.current(iteration.id).version, idempotencyKey: randomUUID(), reason: 'Explicit start, no dispatch' });
  f.setClock('2026-11-03T12:00:00Z');
  const before = canonical(f.currentIssue(issue.id));
  assert.deepEqual(f.service.gaps(f.worker, f.workspace.id), []);
  assert.equal(f.service.gaps(f.pm, f.workspace.id)[0]?.code, 'ITERATION_OVERDUE');
  const progress = f.view(iteration).progress;
  assert.equal(progress.advisory, true);
  assert.equal(progress.overdue, true);
  assert.equal(progress.runCapacity.scope, 'installation');
  const packet = f.service.packet(f.worker, f.currentIssue(issue.id))!;
  assert.equal(packet.advisory, true);
  assert.equal(Array.from(packet.goal).length, 201);
  assert.equal(canonical(f.currentIssue(issue.id)), before);
  assert.equal(f.current(iteration.id).state, 'ACTIVE');
  assert.equal(f.store.list('run', f.workspace.id).length, 0);
});

test('cumulative flow reconstructs local-day membership and state history across DST with paginated complete days', () => {
  const f = fixture();
  const iteration = f.create({ startDate: '2026-11-01', endDate: '2026-11-03', timeZone: 'America/Los_Angeles' });
  const issue = f.issue();
  f.move([issue], iteration);
  const joined = f.store.list<IterationMembershipEvent>('iteration_membership', f.workspace.id).find(event => event.kind === 'ADD')!;
  const shift = (sequence: number, at: string) => f.store.db.prepare('UPDATE events SET at=? WHERE sequence=?').run(at, sequence);
  joined.at = '2026-10-31T22:00:00Z';
  f.store.put('iteration_membership', joined, f.workspace.id);
  shift(joined.sequence, joined.at);
  f.store.event(f.workspace.id, f.human, 'fixture_state', issue.id, { state: 'USER_ACCEPTANCE' });
  const accepted = (f.store.db.prepare('SELECT MAX(sequence) AS sequence FROM events').get() as { sequence: number }).sequence;
  shift(accepted, '2026-11-02T07:30:00Z');
  f.store.event(f.workspace.id, f.human, 'fixture_state', issue.id, { state: 'DONE' });
  const completed = (f.store.db.prepare('SELECT MAX(sequence) AS sequence FROM events').get() as { sequence: number }).sequence;
  shift(completed, '2026-11-02T08:30:00Z');
  f.move([issue], null);
  const removed = f.store.list<IterationMembershipEvent>('iteration_membership', f.workspace.id).find(event => event.kind === 'REMOVE')!;
  removed.at = '2026-11-03T10:00:00Z';
  f.store.put('iteration_membership', removed, f.workspace.id);
  shift(removed.sequence, removed.at);
  f.setClock('2026-11-04T12:00:00Z');
  const first = f.view(iteration, f.human, { view: 'flow', flowLimit: 2 });
  assert.deepEqual(first.points.map((point: any) => point.date), ['2026-11-01', '2026-11-02']);
  assert.equal(first.points[0].counts.USER_ACCEPTANCE, 1);
  assert.equal(first.points[0].waitingOnHuman, 1);
  assert.equal(first.points[1].counts.DONE, 1);
  assert.equal(first.nextDate, '2026-11-03');
  const last = f.view(iteration, f.human, { view: 'flow', flowFrom: first.nextDate });
  assert.equal(last.points.length, 1);
  assert.equal(Object.values(last.points[0].counts).reduce((sum: any, count: any) => sum + count, 0), 0);
  assert.equal(last.nextDate, null);
});

test('closed summary derives human/run facts and keeps excluded abandonment separate from delivered scope', () => {
  const f = fixture();
  const iteration = f.create();
  const root = f.issue({ artifactMode: 'artifact' });
  const child = f.issue({ parentId: root.id, artifactMode: 'artifact' });
  f.move([root, child], iteration);
  const design = { id: randomUUID(), issueId: root.id, content: 'Automated scope fixture', criteria: ['A'], status: 'APPROVED', hash: 'fixture-design-hash', requirementDescription: root.description };
  f.store.put('design', design, f.workspace.id);
  f.store.put('issue', { ...f.currentIssue(root.id), designId: design.id }, f.workspace.id);
  const excluded = { ...f.currentIssue(child.id), state: 'ABANDONED' as const };
  f.store.put('issue', excluded, f.workspace.id);
  const body: Omit<ScopeDecision, 'hash'> = { id: randomUUID(), workspaceId: f.workspace.id, issueId: root.id, childId: child.id, designId: design.id, designHash: design.hash, action: 'EXCLUDE', actorId: f.human.id, reason: 'Explicit automated scope fixture, not actual user approval', createdAt: new Date().toISOString(), previousDecisionId: null, target: scopeBinding(f.store, excluded), replacements: [] };
  f.store.put('scope_decision', { ...body, hash: hash(canonical(body)) }, f.workspace.id);
  f.store.put('issue', { ...excluded, scopeDecisionId: body.id }, f.workspace.id);
  assert.equal(scopeState(f.store, f.currentIssue(child.id)).status, 'EXCLUDED');
  f.store.event(f.workspace.id, f.human, 'delivery_decide', root.id, { decision: 'ACCEPT', fixture: true });
  f.store.event(f.workspace.id, f.pm, 'delivery_complete', root.id, { delegated: true, fixture: true });
  const run: Run = { id: randomUUID(), issueId: root.id, workspaceId: f.workspace.id, actorId: f.worker.id, harness: 'codex', state: 'SUCCEEDED', version: 1, createdAt: new Date().toISOString(), designId: design.id, scopeRevision: root.scopeRevision };
  f.store.put('run', run, f.workspace.id);
  f.store.event(f.workspace.id, f.worker, 'run_starting', run.id, {});
  const noTerminalProof = f.service.mutate(f.pm, 'iteration_close', f.closeInput(iteration)).summary as IterationSummary;
  assert.equal(noTerminalProof.counts.excluded, 1);
  assert.equal(noTerminalProof.counts.abandoned, 1);
  assert.equal(noTerminalProof.counts.done, 0);
  assert.equal(noTerminalProof.humanDecisions.length, 1);
  assert.equal(noTerminalProof.runs[0]?.state, 'STARTING');
  assert.equal(scopeState(f.store, f.currentIssue(child.id)).status, 'EXCLUDED');
});

test('scoped default projections are compact and expose no candidate, raw evidence, hidden run counts or unrelated history', () => {
  const f = fixture();
  const iteration = f.create({ goal: 'g'.repeat(2000) });
  const parent = f.issue({ assignee: null });
  const child = f.issue({ parentId: parent.id, qaAssignee: f.qa.id });
  const hidden = f.issue({ assignee: randomUUID() });
  f.move([parent, child, hidden], iteration);
  const run: Run = { id: randomUUID(), issueId: parent.id, workspaceId: f.workspace.id, actorId: randomUUID(), harness: 'dsh', state: 'RUNNING', version: 1, createdAt: new Date().toISOString(), designId: 'fixture', scopeRevision: 1 };
  f.store.put('run', run, f.workspace.id);
  const related = f.view(iteration, f.worker);
  assert.equal(related.members.length, 2);
  assert.equal(related.progress.activeRuns, 0);
  assert.equal(related.members[0].candidate, undefined);
  assert.equal(related.members[0].description, undefined);
  assert.equal(related.iteration.goal.length, 200);
  assert.equal(related.iteration.goalTruncated, true);
  assert.equal(related.progress.runCapacity.workspaceActiveRuns, null);
  assert.equal(f.view(iteration).progress.runCapacity.workspaceActiveRuns, 1);
  f.move([child, parent], null);
  f.service.mutate(f.pm, 'iteration_close', f.closeInput(iteration));
  const historical = f.view(iteration, f.worker, { view: 'flow' });
  assert.equal(historical.iteration.partial, true);
  assert.equal(historical.iteration.membershipHash, undefined);
});

test('managed worker and independent QA receive the same bounded advisory context through their actual prompt paths', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-iteration-prompt-'));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'delivery.txt'), 'original fixture content');
  const store = new Store(join(root, 'fixture.sqlite'));
  const flow = new Workflow(store);
  const human = store.bootstrap().actor;
  const call = (actor: Actor, operation: string, input: object) => flow.execute(actor, operation, { idempotencyKey: randomUUID(), ...input }) as any;
  const workspace = call(human, 'workspace_register', { root: source, name: 'Advisory prompt fixture', prefix: 'PROMPT' }).workspace as Workspace;
  const run = (operation: string, input: object) => call(human, operation, { workspaceId: workspace.id, ...input });
  const parent = run('issue_create', { title: 'Independent prompt fixture', description: 'Capture bounded advisory context without a real model', criteria: ['A'] }).issue as Issue;
  const change = (operation: string, id: string, input: object, actor = human) => call(actor, operation, { workspaceId: workspace.id, issueId: id, expectedVersion: store.get<Issue>('issue', id).version, ...input });
  change('design_set', parent.id, { content: 'Deliver fixture content; planning context never authorizes a gate', criteria: ['A'] });
  change('design_submit', parent.id, {});
  change('design_decide', parent.id, { designId: store.get<Issue>('issue', parent.id).designId, decision: 'APPROVED', reason: 'Automated fixture only, not human project acceptance' });
  const child = run('issue_create', { parentId: parent.id, expectedParentVersion: store.get<Issue>('issue', parent.id).version, title: '[Test] Prompt: capture context -> no workflow bypass', description: 'Capture worker and QA fixture prompts', criteria: ['A'] }).issue as Issue;
  const worker = run('actor_enroll', { role: 'worker', name: 'Prompt worker fixture' }).actor as Actor;
  const qa = run('actor_enroll', { role: 'qa', name: 'Prompt QA fixture' }).actor as Actor;
  const lead = run('actor_enroll', { role: 'lead', name: 'Prompt lead fixture' }).actor as Actor;
  const profile = run('check_profile_create', { name: 'Unused approved prompt-fixture check', command: process.execPath, args: ['.qa/check.mjs'], criteria: ['A'], timeoutMs: 1000 }).profile;
  change('issue_assign', child.id, { actorId: worker.id, harness: 'codex' });
  change('qa_configure', child.id, { actorId: qa.id, harness: 'dsh', checkProfileIds: [profile.id] });
  applyFixturePlan(flow, human, parent.id);
  const iterations = new IterationService(store);
  const iteration = iterations.mutate(human, 'iteration_create', { workspaceId: workspace.id, idempotencyKey: randomUUID(), name: 'Bounded advisory goal', goal: 'g'.repeat(2000), startDate: '2026-11-01', endDate: '2026-11-14', timeZone: 'Asia/Taipei', reason: 'Automated metadata fixture' }).iteration as Iteration;
  iterations.changeMembership(human, workspace.id, [{ issueId: child.id, expectedVersion: store.get<Issue>('issue', child.id).version, iterationId: iteration.id }], [iterations.precondition(iteration)], 'Fixture planning metadata');
  assert.equal((flow.execute(human, 'plan_get', { workspaceId: workspace.id, issueId: parent.id }) as any).coverage.ready, true);
  change('work_dispatch', child.id, { designId: store.get<Issue>('issue', parent.id).designId, scopeRevision: child.scopeRevision });
  const contexts: AdapterContext[] = [];
  const finish = new Map<string, (value: AdapterResult) => void>();
  const adapter: ExecutionAdapter = { async start(context) { contexts.push(context); context.onProvider(`controlled-prompt-fixture-${randomUUID()}`); return { result: new Promise<AdapterResult>(done => finish.set(context.cwd, done)), interrupt: async () => { finish.get(context.cwd)?.({ outcome: 'cancelled' }); return true; } }; } };
  const app = createServer(store);
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const coordinator = new Coordinator(store, { endpoint, directory: join(root, 'runs'), bridgeScript: resolve('dist/cli.js'), adapter });
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!check()) { if (Date.now() > deadline) throw new Error('Prompt fixture did not reach its expected state'); await new Promise(done => setTimeout(done, 20)); }
  };
  try {
    await coordinator.start();
    await until(() => contexts.length === 1);
    const workerContext = contexts[0]!;
    const actor = store.authenticate(workerContext.token);
    writeFileSync(join(workerContext.cwd, 'delivery.txt'), 'delivered fixture content');
    const current = store.get<Issue>('issue', child.id);
    await new LocalClient(endpoint, workerContext.token).command('work_submit', { workspaceId: workspace.id, issueId: child.id, expectedVersion: current.version, fence: current.fence, summary: 'Controlled provider fixture, not a model run', files: ['delivery.txt'], idempotencyKey: randomUUID() });
    finish.get(workerContext.cwd)!({ outcome: 'succeeded' });
    await until(() => store.get<Run>('run', actor.runId!).state === 'SUCCEEDED');
    change('review_submit', child.id, { candidateId: store.get<Issue>('issue', child.id).candidate!.id, verdict: 'PASS', reason: 'Automated independent initial review fixture' }, lead);
    await until(() => contexts.length === 2);
    const qaContext = contexts[1]!;
    assert.notEqual(workerContext.cwd, qaContext.cwd);
    assert.equal(store.authenticate(qaContext.token).role, 'qa');
    for (const context of contexts) {
      const advisoryLine = context.prompt.split('\n').find(line => line.startsWith('Advisory iteration context'))!;
      assert.match(advisoryLine, /does not authorize scope or gate changes/);
      const packet = JSON.parse(advisoryLine.slice(advisoryLine.indexOf('{')));
      assert.equal(packet.id, iteration.id);
      assert.equal(packet.name, iteration.name);
      assert.equal(packet.endDate, iteration.endDate);
      assert.equal(packet.goal.length, 201);
      assert.equal(packet.advisory, true);
      assert.ok(advisoryLine.length < 600);
    }
    assert.equal(readFileSync(join(source, 'delivery.txt'), 'utf8'), 'original fixture content');
  } finally {
    await coordinator.close();
    await app.close();
    store.close();
    const childPath = relative(realpathSync(tmpdir()), realpathSync(root));
    assert.ok(!isAbsolute(childPath) && !childPath.startsWith('..') && !childPath.includes(sep) && childPath.startsWith('agiledev-iteration-prompt-'));
    rmSync(root, { recursive: true, force: true });
  }
});
