import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Actor, type Issue, type QaReport, type Snapshot, DomainError } from '../src/contracts.js';
import { type DefectFinding, type DefectRecord } from '../src/defect-contracts.js';
import { DefectRegistry } from '../src/defects.js';
import { canonical, hash, Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const fails = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
const finding: DefectFinding = { severity: 'MAJOR', criterionIds: ['AC-1'], reproduce: 'Run the recorded automated fixture input', expected: 'Fixture output matches its criterion', actual: 'Fixture output differs' };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-defect-core-'));
  const store = new Store(':memory:');
  cleanup.push(() => { store.close(); assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const flow = new Workflow(store);
  const human = store.bootstrap().actor;
  const write = (actor: Actor, operation: string, input: object) => flow.execute(actor, operation, { idempotencyKey: randomUUID(), ...input }) as any;
  const workspace = write(human, 'workspace_register', { root, name: 'Automated defect fixture', prefix: 'DF' }).workspace;
  const agent = (role: string) => write(human, 'actor_enroll', { workspaceId: workspace.id, role, name: `Fixture ${role}` }).actor as Actor;
  const worker = agent('worker'); const qa = agent('qa'); const lead = agent('lead'); const pm = agent('pm');
  const issue = (title = 'Track exact fixture behavior', parentId?: string) => write(human, 'issue_create', { workspaceId: workspace.id, title: parentId ? '[Test] Defect: verify behavior -> trace a concrete finding' : title, description: 'Automated fixture only', criteria: ['AC-1'], ...(parentId ? { parentId, expectedParentVersion: store.get<Issue>('issue', parentId).version } : {}) }).issue as Issue;
  const current = (id: string) => store.get<Issue>('issue', id);
  const digest = (value: Issue) => {
    if (!value.candidate) throw new DomainError('SNAPSHOT_REQUIRED', 'Fixture has no sealed candidate');
    return hash(canonical({ candidate: value.candidate.id, artifact: value.candidate.hash, scope: value.scopeRevision }));
  };
  const registry = new DefectRegistry(store, {
    deliveryDigest: digest,
    reopen: (actor, value, reason) => { write(actor, 'issue_transition', { workspaceId: value.workspaceId, issueId: value.id, expectedVersion: value.version, action: 'reopen', reason }); },
    createRequirement: (actor, value, input) => write(actor, 'issue_create', { workspaceId: value.workspaceId, ...input }).issue
  });
  const seedDelivery = (id: string, state: 'DONE' | 'USER_ACCEPTANCE' | 'QA_TEST' = 'DONE') => {
    const value = current(id); const candidateId = randomUUID(); const snapshotId = randomUUID();
    const snapshot: Snapshot = { id: snapshotId, workspaceId: workspace.id, issueId: id, candidateId, root, files: [], hash: hash('automated registry fixture artifact'), createdAt: new Date().toISOString() };
    store.put('snapshot', snapshot, workspace.id);
    value.candidate = { id: candidateId, workerId: worker.id, sessionId: worker.sessionId, designId: 'fixture-design', files: [], hash: snapshot.hash, summary: 'Manually seeded core fixture, not a native execution', snapshotId, runId: 'fixture-core-producer' };
    value.state = state; value.version++;
    if (state === 'DONE') {
      value.acceptedDigest = digest(value);
      store.put('delivery_approval', { id: randomUUID(), issueId: id, actorId: human.id, candidateId, digest: value.acceptedDigest, decision: 'ACCEPT', reason: 'Automated fixture decision only', at: new Date().toISOString() }, workspace.id);
    }
    store.put('issue', value, workspace.id); return value;
  };
  const proposal = (value: Issue, actor = lead) => registry.propose(actor, { workspaceId: workspace.id, issueId: value.id, expectedVersion: current(value.id).version, ...finding });
  const report = (value: Issue) => registry.report(human, { workspaceId: workspace.id, issueId: value.id, expectedVersion: current(value.id).version, observation: registry.observe(current(value.id)), ...finding });
  const seedQa = (value: Issue, severity: DefectFinding['severity'] = 'MAJOR', verdict: QaReport['verdict'] = 'FAIL') => {
    const input = current(value.id); input.qaAssignee = qa.id; store.put('issue', input, workspace.id);
    const qaReport: QaReport = { id: randomUUID(), workspaceId: workspace.id, issueId: value.id, runId: 'fixture-qa-registry-source', actorId: qa.id, sessionId: qa.sessionId, candidateId: input.candidate!.id, snapshotId: input.candidate!.snapshotId!, verdict, results: [], findings: verdict === 'PASS' ? [] : [{ criterionId: 'AC-1', severity, reproduce: finding.reproduce, expected: finding.expected, actual: finding.actual }], summary: 'Manually seeded registry source, not independent QA evidence' };
    store.put('qa_report', qaReport, workspace.id); return qaReport;
  };
  return { store, flow, human, workspace, worker, qa, lead, pm, issue, current, registry, write, seedDelivery, proposal, report, seedQa, digest };
}

test('pending problems on readable unstarted issues have no confirmed origin or fabricated artifact', () => {
  const f = fixture(); const issue = f.issue();
  const before = canonical(f.current(issue.id));
  const initialSet = f.registry.confirmedSet(f.human, f.workspace.id, issue.id);
  const proposed = f.proposal(issue);
  assert.equal(proposed.state, 'PROPOSED'); assert.equal(proposed.origin, null);
  assert.deepEqual(proposed.observation, { kind: 'ISSUE_SCOPE', issueVersion: issue.version, scopeRevision: issue.scopeRevision, designId: issue.designId, candidateId: null, snapshotId: null, snapshotHash: null, digest: null });
  assert.equal(canonical(f.current(issue.id)), before);
  assert.deepEqual(f.registry.confirmedSet(f.human, f.workspace.id, issue.id), initialSet);
  assert.throws(() => f.registry.triage(f.human, { workspaceId: f.workspace.id, defectId: proposed.id, expectedVersion: proposed.version, expectedIssueVersion: issue.version, action: 'CONFIRM', severity: 'MAJOR', reason: 'No artifact is available', observation: proposed.observation }), fails('DEFECT_OBSERVATION_REQUIRED'));
});

test('proposal and registry reads preserve assigned-issue and workspace boundaries', () => {
  const f = fixture(); const own = f.issue(); const hidden = f.issue('Another fixture');
  f.write(f.human, 'issue_assign', { workspaceId: f.workspace.id, issueId: own.id, expectedVersion: own.version, actorId: f.worker.id, harness: 'codex' });
  const visible = f.proposal(own, f.worker); const other = f.proposal(hidden);
  assert.deepEqual(f.registry.list(f.worker, { workspaceId: f.workspace.id }).defects.map(value => value.id), [visible.id]);
  assert.throws(() => f.registry.get(f.worker, f.workspace.id, other.id), fails('SCOPE_DENIED'));
  assert.throws(() => f.proposal(hidden, f.worker), fails('SCOPE_DENIED'));
  assert.throws(() => f.registry.list({ ...f.lead, workspaceIds: [] }, { workspaceId: f.workspace.id }), fails('SCOPE_DENIED'));
  assert.throws(() => f.registry.propose(f.human, { workspaceId: f.workspace.id, issueId: own.id, expectedVersion: f.current(own.id).version, ...finding }), fails('ROLE_DENIED'));
  const parent = f.issue('Readable parent'); const child = f.issue('child', parent.id);
  f.write(f.human, 'issue_assign', { workspaceId: f.workspace.id, issueId: child.id, expectedVersion: child.version, actorId: f.worker.id, harness: 'codex' });
  assert.equal(f.proposal(parent, f.worker).issueId, parent.id);
});

test('a human converts an unsealed proposal into a linked unapproved requirement', () => {
  const f = fixture(); const source = f.issue(); const problem = f.proposal(source);
  const before = canonical(f.current(source.id)); const observation = canonical(problem.initialObservation);
  const result = f.registry.triage(f.human, { workspaceId: f.workspace.id, defectId: problem.id, expectedVersion: 1, expectedIssueVersion: source.version, action: 'NEW_REQUIREMENT', reason: 'Plan this reported problem separately', requirement: { title: 'Make the fixture behavior explicit', description: 'Resolve the reported scope question', criteria: ['NEW-1'] } });
  assert.equal(result.defect.state, 'CONVERTED'); assert.equal(result.defect.origin, null);
  assert.equal(result.requirement!.state, 'NOT_STARTED'); assert.equal(result.requirement!.parentId, null);
  assert.equal(result.requirement!.designId, null); assert.equal(result.requirement!.assignee, null);
  assert.equal(canonical(result.defect.initialObservation), observation); assert.equal(canonical(f.current(source.id)), before);
  assert.equal(f.store.get<any>('defect_requirement', problem.id).requirementId, result.requirement!.id);
  assert.equal(f.registry.confirmedSet(f.human, f.workspace.id, source.id).members.length, 0);
  assert.throws(() => f.registry.triage(f.human, { workspaceId: f.workspace.id, defectId: problem.id, expectedVersion: result.defect.version, expectedIssueVersion: source.version, action: 'REJECT', reason: 'A converted record is historical' }), fails('INVALID_TRANSITION'));
});

test('triage enforces human authority and exact issue and proposal versions without partial writes', () => {
  const f = fixture(); const issue = f.issue(); const problem = f.proposal(issue);
  const request = { workspaceId: f.workspace.id, defectId: problem.id, expectedVersion: 1, expectedIssueVersion: issue.version, action: 'REJECT' as const, reason: 'Fixture human triage' };
  for (const actor of [f.lead, f.pm, f.worker, f.qa]) assert.throws(() => f.registry.triage(actor, request), fails('ROLE_DENIED'));
  const before = f.store.db.prepare('SELECT COUNT(*) AS count FROM events').get();
  assert.throws(() => f.registry.triage(f.human, { ...request, expectedIssueVersion: issue.version + 1 }), fails('VERSION_CONFLICT'));
  assert.throws(() => f.registry.triage(f.human, { ...request, expectedVersion: 2 }), fails('VERSION_CONFLICT'));
  assert.deepEqual(f.store.db.prepare('SELECT COUNT(*) AS count FROM events').get(), before);
  const rejected = f.registry.triage(f.human, request).defect;
  assert.equal(rejected.state, 'REJECTED'); assert.equal(rejected.origin, null); assert.equal(rejected.version, 2);
});

test('confirmation records later immutable evidence without rewriting the original unsealed observation', () => {
  const f = fixture(); const issue = f.issue(); const problem = f.proposal(issue);
  const initial = canonical(problem.initialObservation); f.seedDelivery(issue.id, 'USER_ACCEPTANCE');
  const value = f.current(issue.id); const observation = f.registry.observe(value);
  const confirmed = f.registry.triage(f.human, { workspaceId: f.workspace.id, defectId: problem.id, expectedVersion: 1, expectedIssueVersion: value.version, action: 'CONFIRM', severity: 'MINOR', observation, reason: 'Confirm the actual current delivery problem' }).defect;
  assert.equal(confirmed.origin, 'USER_ACCEPTANCE'); assert.equal(confirmed.state, 'OPEN');
  assert.equal(confirmed.observation.digest, f.digest(value)); assert.equal(canonical(confirmed.initialObservation), initial);
  assert.equal(confirmed.confirmedBy, f.human.id); assert.equal(confirmed.reporterId, f.lead.id);
  assert.equal(f.current(issue.id).state, 'USER_ACCEPTANCE');
  assert.equal(f.registry.confirmedSet(f.human, f.workspace.id, issue.id).revision, 1);
  assert.equal(f.registry.confirmedSet(f.human, f.workspace.id, issue.id).members[0]!.version, 2);
});

test('closed escaped confirmation can defer or use the existing reopen and parent invalidation', () => {
  const f = fixture(); const parent = f.issue('Closed aggregate'); const child = f.issue('child', parent.id);
  f.seedDelivery(parent.id); const closed = f.seedDelivery(child.id);
  const approvals = canonical(f.store.list('delivery_approval', f.workspace.id)); const problem = f.proposal(closed);
  const deferred = f.registry.triage(f.human, { workspaceId: f.workspace.id, defectId: problem.id, expectedVersion: 1, expectedIssueVersion: closed.version, action: 'CONFIRM', severity: 'MAJOR', disposition: 'DEFER', observation: f.registry.observe(closed), reason: 'Explicitly retain the closed fixture while tracking its defect' }).defect;
  assert.equal(deferred.origin, 'ESCAPED'); assert.equal(f.current(child.id).state, 'DONE'); assert.equal(f.current(parent.id).state, 'DONE');
  const second = f.proposal(closed);
  const reopened = f.registry.triage(f.human, { workspaceId: f.workspace.id, defectId: second.id, expectedVersion: 1, expectedIssueVersion: closed.version, action: 'CONFIRM', severity: 'MAJOR', disposition: 'REOPEN', observation: f.registry.observe(closed), reason: 'Explicit human reopening of this fixture' }).defect;
  assert.equal(reopened.origin, 'ESCAPED'); assert.equal(f.current(child.id).state, 'NOT_STARTED'); assert.equal(f.current(parent.id).state, 'IN_PROGRESS');
  assert.equal(f.current(child.id).candidate, null); assert.equal(f.current(parent.id).candidate, null);
  assert.equal(canonical(f.store.list('delivery_approval', f.workspace.id)), approvals);
});

test('escaped reports require a real recorded closed approval and preserve the closed issue', () => {
  const f = fixture(); const issue = f.seedDelivery(f.issue().id); const before = canonical(f.current(issue.id));
  const report = f.report(issue); assert.equal(report.origin, 'ESCAPED'); assert.equal(report.state, 'OPEN');
  assert.equal(canonical(f.current(issue.id)), before);
  assert.throws(() => f.registry.report(f.lead, { workspaceId: f.workspace.id, issueId: issue.id, expectedVersion: issue.version, observation: f.registry.observe(issue), ...finding }), fails('ROLE_DENIED'));
  assert.throws(() => f.registry.report(f.human, { workspaceId: f.workspace.id, issueId: issue.id, expectedVersion: issue.version, observation: { ...f.registry.observe(issue), digest: 'invented-digest' }, ...finding }), fails('DEFECT_OBSERVATION_REQUIRED'));
  const broken = f.current(issue.id); broken.acceptedDigest = 'no-actual-approval'; f.store.put('issue', broken, f.workspace.id);
  assert.throws(() => f.report(broken), fails('DEFECT_OBSERVATION_REQUIRED'));
});

test('migration assigns separate creation-order keys without changing QA resolution or closure history', () => {
  const f = fixture(); const issue = f.seedDelivery(f.issue().id); const sourceIssue = canonical(issue);
  const old = { id: 'old-one', workspaceId: f.workspace.id, issueId: issue.id, candidateId: issue.candidate!.id, snapshotId: issue.candidate!.snapshotId!, reportId: 'old-report', ownerId: f.worker.id, state: 'RESOLVED', criterionId: 'AC-1', severity: 'MAJOR', reproduce: 'Old fixture input', expected: 'Expected', actual: 'Actual', resolutionReportId: 'old-resolution' };
  f.store.put('defect', old, f.workspace.id); f.store.put('defect', { ...old, id: 'old-two', state: 'OPEN' }, f.workspace.id);
  const beforeRead = f.store.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all('defect');
  const preview = f.registry.list(f.human, { workspaceId: f.workspace.id }).defects;
  assert.deepEqual(preview.map(value => value.key), ['DF-D0001', 'DF-D0002']);
  assert.deepEqual(f.store.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all('defect'), beforeRead);
  assert.equal(preview[0]!.observation.issueVersion, null); assert.equal(preview[0]!.observation.scopeRevision, null); assert.equal(preview[0]!.reporterId, null);
  const migrated = f.registry.migrate(f.workspace.id);
  assert.equal(migrated[0]!.origin, 'QA'); assert.equal(migrated[0]!.state, 'RESOLVED'); assert.equal(migrated[0]!.resolutionReportId, 'old-resolution');
  assert.equal(canonical(f.current(issue.id)), sourceIssue);
  assert.equal(f.proposal(issue).key, 'DF-D0003');
  assert.equal(f.store.get<any>('workspace', f.workspace.id).sequence, 1);
  assert.deepEqual(f.registry.migrate(f.workspace.id).map(value => value.key), ['DF-D0001', 'DF-D0002', 'DF-D0003']);
});

test('modern partial records cannot be reinterpreted as old QA defects', () => {
  const f = fixture(); const issue = f.issue();
  f.store.put('defect', { id: randomUUID(), workspaceId: f.workspace.id, issueId: issue.id, state: 'OPEN', origin: 'ESCAPED', criterionId: 'AC-1', severity: 'MAJOR', reportId: 'not-qa', candidateId: 'not-a-candidate', snapshotId: 'not-a-snapshot' }, f.workspace.id);
  assert.throws(() => f.registry.migrate(f.workspace.id), fails('DEFECT_RECORD_INVALID'));
  assert.equal(f.store.list<any>('defect', f.workspace.id)[0].origin, 'ESCAPED');
  assert.equal(f.store.list('defect_sequence', f.workspace.id).length, 0);
});

test('QA findings and rejection findings retain actual sources and are internally replay-safe', () => {
  const f = fixture(); const issue = f.seedDelivery(f.issue().id, 'QA_TEST'); const report = f.seedQa(issue);
  const qa = f.registry.recordQaFindings(f.qa, report.id);
  assert.equal(qa.length, 1); assert.equal(qa[0]!.origin, 'QA'); assert.equal(qa[0]!.reporterId, f.qa.id);
  assert.equal(f.current(issue.id).state, 'QA_TEST');
  assert.equal(f.registry.recordQaFindings(f.qa, report.id)[0]!.id, qa[0]!.id);
  assert.throws(() => f.registry.recordQaFindings(f.lead, report.id), fails('ROLE_DENIED'));
  const rejected = f.current(issue.id); rejected.state = 'USER_REJECTED'; f.store.put('issue', rejected, f.workspace.id);
  const approval = { id: randomUUID(), issueId: issue.id, actorId: f.human.id, candidateId: issue.candidate!.id, digest: f.digest(issue), decision: 'REJECT', at: new Date().toISOString() };
  f.store.put('delivery_approval', approval, f.workspace.id);
  const defects = f.registry.recordRejection(f.human, f.workspace.id, issue.id, approval.id, [finding]);
  assert.equal(defects[0]!.origin, 'USER_ACCEPTANCE'); assert.equal(defects[0]!.source.id, approval.id);
  assert.equal(f.registry.recordRejection(f.human, f.workspace.id, issue.id, approval.id, [finding])[0]!.id, defects[0]!.id);
  assert.throws(() => f.registry.recordRejection(f.human, f.workspace.id, issue.id, approval.id, [{ ...finding, actual: 'Changed payload' }]), fails('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.store.list('defect', f.workspace.id).length, 2);
});

test('legacy passing QA resolves only QA-origin defects and never new human-confirmed problems', () => {
  const f = fixture(); const issue = f.seedDelivery(f.issue().id); const humanDefect = f.report(issue);
  const qaInput = f.current(issue.id); qaInput.state = 'QA_TEST'; f.store.put('issue', qaInput, f.workspace.id);
  const prior = f.seedQa(qaInput); const qaDefect = f.registry.recordQaFindings(f.qa, prior.id)[0]!;
  const pass = f.seedQa(qaInput, 'MAJOR', 'PASS');
  const result = f.registry.resolveLegacyQaPass(f.qa, pass.id);
  assert.deepEqual(result.map(value => value.id), [qaDefect.id]);
  assert.equal(f.registry.get(f.human, f.workspace.id, humanDefect.id).state, 'OPEN');
  assert.equal(f.registry.get(f.human, f.workspace.id, qaDefect.id).resolutionReportId, pass.id);
  assert.throws(() => f.registry.withdraw(f.human, { workspaceId: f.workspace.id, defectId: qaDefect.id, expectedVersion: result[0]!.version, reason: 'Cannot retract a QA finding through the human-origin path' }), fails('DEFECT_WITHDRAWAL_DENIED'));
});

test('withdrawal is human-only and preserves observation, source and previous report identities', () => {
  const f = fixture(); const issue = f.seedDelivery(f.issue().id); const record = f.report(issue);
  const request = { workspaceId: f.workspace.id, defectId: record.id, expectedVersion: record.version, reason: 'The human retracts this fixture report' };
  for (const actor of [f.lead, f.pm, f.worker, f.qa]) assert.throws(() => f.registry.withdraw(actor, request), fails('ROLE_DENIED'));
  const before = f.registry.confirmedSet(f.human, f.workspace.id, issue.id);
  const withdrawn = f.registry.withdraw(f.human, request);
  assert.equal(withdrawn.state, 'WITHDRAWN'); assert.deepEqual(withdrawn.observation, record.observation); assert.deepEqual(withdrawn.source, record.source);
  const after = f.registry.confirmedSet(f.human, f.workspace.id, issue.id);
  assert.equal(after.members.length, 0); assert.equal(after.revision, before.revision + 1);
  assert.throws(() => f.registry.withdraw(f.human, request), fails('VERSION_CONFLICT'));
});

test('conversion and rejection creation roll back counters, sources, requirements and events on failure', () => {
  const f = fixture(); const issue = f.issue(); const problem = f.proposal(issue);
  const count = () => f.store.db.prepare('SELECT COUNT(*) AS count FROM records').get();
  const before = count(); const events = f.store.db.prepare('SELECT COUNT(*) AS count FROM events').get();
  const broken = new DefectRegistry(f.store, { deliveryDigest: f.digest, createRequirement: (actor, source, input) => {
    f.write(actor, 'issue_create', { workspaceId: source.workspaceId, ...input });
    throw new DomainError('TEST_EFFECT_FAILURE', 'Automated rollback fixture');
  } });
  assert.throws(() => broken.triage(f.human, { workspaceId: f.workspace.id, defectId: problem.id, expectedVersion: 1, expectedIssueVersion: issue.version, action: 'NEW_REQUIREMENT', reason: 'Rollback the failed conversion', requirement: { title: 'Temporary fixture requirement', description: 'Must not survive', criteria: [] } }), fails('TEST_EFFECT_FAILURE'));
  assert.deepEqual(count(), before); assert.deepEqual(f.store.db.prepare('SELECT COUNT(*) AS count FROM events').get(), events);
  assert.equal(f.registry.get(f.human, f.workspace.id, problem.id).state, 'PROPOSED');
  assert.throws(() => f.registry.propose(f.lead, { workspaceId: f.workspace.id, issueId: issue.id, expectedVersion: issue.version, ...finding, criterionIds: ['UNKNOWN'] }), fails('CRITERIA_UNMAPPED'));
  assert.deepEqual(count(), before); assert.deepEqual(f.store.db.prepare('SELECT COUNT(*) AS count FROM events').get(), events);
});

test('list pagination, severity and confirmed-origin filters expose no fabricated problem origin', () => {
  const f = fixture(); const closed = f.seedDelivery(f.issue().id);
  const one = f.report(closed); const pending = f.proposal(closed); const two = f.report(closed);
  const first = f.registry.list(f.human, { workspaceId: f.workspace.id, limit: 2 });
  assert.deepEqual(first.defects.map(value => value.id), [one.id, pending.id]); assert.equal(first.nextOffset, 2); assert.equal(first.total, 3);
  assert.deepEqual(f.registry.list(f.human, { workspaceId: f.workspace.id, offset: 2 }).defects.map(value => value.id), [two.id]);
  assert.deepEqual(f.registry.list(f.human, { workspaceId: f.workspace.id, origin: 'ESCAPED' }).defects.map(value => value.id), [one.id, two.id]);
  assert.deepEqual(f.registry.list(f.human, { workspaceId: f.workspace.id, state: 'PROPOSED' }).defects.map(value => value.id), [pending.id]);
  const raw = canonical(f.store.list<DefectRecord>('defect', f.workspace.id));
  const receipts = f.store.db.prepare('SELECT COUNT(*) AS count FROM receipts').get();
  f.registry.list(f.human, { workspaceId: f.workspace.id }); f.registry.get(f.human, f.workspace.id, one.id);
  assert.equal(canonical(f.store.list('defect', f.workspace.id)), raw);
  assert.deepEqual(f.store.db.prepare('SELECT COUNT(*) AS count FROM receipts').get(), receipts);
});

test('rejection classifications create only their intended facts and cannot be replayed as another class', () => {
  const f = fixture(); const value = f.seedDelivery(f.issue().id, 'USER_ACCEPTANCE');
  const approval = { id: randomUUID(), issueId: value.id, actorId: f.human.id, candidateId: value.candidate!.id, digest: f.digest(value), decision: 'REJECT', at: new Date().toISOString() };
  f.store.put('delivery_approval', approval, f.workspace.id);
  const before = canonical(f.current(value.id));
  const classified = f.registry.classifyRejection(f.human, f.workspace.id, value.id, approval.id, { classification: 'CLARIFICATION' });
  assert.equal(classified.classification, 'CLARIFICATION'); assert.equal(classified.defectIds.length, 0);
  assert.equal(f.registry.needsScopeRevision(value), false); assert.equal(f.store.list('defect', f.workspace.id).length, 0);
  const eventCount = f.store.db.prepare('SELECT COUNT(*) AS count FROM events').get();
  assert.deepEqual(f.registry.classifyRejection(f.human, f.workspace.id, value.id, approval.id, { classification: 'CLARIFICATION' }), classified);
  assert.deepEqual(f.store.db.prepare('SELECT COUNT(*) AS count FROM events').get(), eventCount);
  assert.throws(() => f.registry.classifyRejection(f.human, f.workspace.id, value.id, approval.id, { classification: 'SCOPE_CHANGE' }), fails('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.registry.classifyRejection(f.lead, f.workspace.id, value.id, approval.id, { classification: 'CLARIFICATION' }), fails('ROLE_DENIED'));
  assert.equal(canonical(f.current(value.id)), before);
  const nextApproval = { ...approval, id: randomUUID() }; f.store.put('delivery_approval', nextApproval, f.workspace.id);
  const defects = f.registry.classifyRejection(f.human, f.workspace.id, value.id, nextApproval.id, { classification: 'DEFECT', findings: [finding, { ...finding, severity: 'MINOR', actual: 'Second distinct fixture problem' }] });
  assert.equal(defects.defectIds.length, 2);
  for (const id of defects.defectIds) assert.equal(f.registry.get(f.human, f.workspace.id, id).origin, 'USER_ACCEPTANCE');
  assert.throws(() => f.registry.classifyRejection(f.human, f.workspace.id, value.id, 'nonexistent-approval', { classification: 'DEFECT', findings: [] }), fails('INVALID_INPUT'));
});

test('scope-change rework waits for an actual newer approved requirement revision after rejection', () => {
  const f = fixture(); const parent = f.issue('Scope revision fixture');
  const change = (op: string, input: object = {}) => f.write(f.human, op, { workspaceId: f.workspace.id, issueId: parent.id, expectedVersion: f.current(parent.id).version, ...input });
  change('design_set', { content: 'The initial fixture design', criteria: ['AC-1'] });
  change('design_submit');
  change('design_decide', { designId: f.current(parent.id).designId, decision: 'APPROVED', reason: 'Automated initial fixture approval' });
  const oldDesign = f.current(parent.id).designId;
  const source = f.seedDelivery(parent.id, 'USER_ACCEPTANCE');
  const approval = { id: randomUUID(), issueId: source.id, actorId: f.human.id, candidateId: source.candidate!.id, digest: f.digest(source), decision: 'REJECT', at: new Date().toISOString() };
  f.store.put('delivery_approval', approval, f.workspace.id);
  const request = f.registry.classifyRejection(f.human, f.workspace.id, source.id, approval.id, { classification: 'SCOPE_CHANGE' });
  assert.equal(request.designId, oldDesign); assert.equal(f.registry.needsScopeRevision(f.current(source.id)), true);
  assert.equal(f.store.list('defect', f.workspace.id).length, 0);
  change('design_set', { content: 'The revised fixture design', criteria: ['AC-1'] });
  assert.notEqual(f.current(parent.id).designId, oldDesign);
  assert.equal(f.registry.needsScopeRevision(f.current(source.id)), true);
  change('design_submit');
  assert.equal(f.registry.needsScopeRevision(f.current(source.id)), true);
  change('design_decide', { designId: f.current(parent.id).designId, decision: 'APPROVED', reason: 'Automated approval of the newer exact revision' });
  assert.equal(f.registry.needsScopeRevision(f.current(source.id)), false);
  const unchanged = canonical(f.store.list('delivery_rejection', f.workspace.id));
  assert.equal(f.registry.needsScopeRevision(f.current(source.id)), false);
  assert.equal(canonical(f.store.list('delivery_rejection', f.workspace.id)), unchanged);
});

test('a requirement scope-change request also protects its descendants without granting new authority', () => {
  const f = fixture(); const parent = f.issue('Parent revision scope'); const child = f.issue('child', parent.id);
  const source = f.seedDelivery(parent.id, 'USER_ACCEPTANCE');
  const approval = { id: randomUUID(), issueId: source.id, actorId: f.human.id, candidateId: source.candidate!.id, digest: f.digest(source), decision: 'REJECT', at: new Date().toISOString() };
  f.store.put('delivery_approval', approval, f.workspace.id);
  f.registry.classifyRejection(f.human, f.workspace.id, source.id, approval.id, { classification: 'SCOPE_CHANGE' });
  assert.equal(f.registry.needsScopeRevision(f.current(parent.id)), true);
  assert.equal(f.registry.needsScopeRevision(f.current(child.id)), true);
  assert.equal(f.current(child.id).state, 'NOT_STARTED');
  assert.equal(f.store.list('grant', f.workspace.id).length, 0);
  assert.equal(f.store.list('approval', f.workspace.id).length, 0);
});
