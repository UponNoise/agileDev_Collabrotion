import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Actor, Candidate, Design, GitSubmission, Issue, Run, Snapshot, Workspace, agentOperations } from '../src/contracts.js';
import { Store, canonical, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { acceptanceDigest } from '../src/qa-policy.js';
import { createServer } from '../src/http.js';
import { GitVerifier } from '../src/git-verifier.js';
import { snapshotGitTree } from '../src/git.js';

const now = Date.UTC(2026, 10, 11, 12);
const day = 86400000;
const iso = (value: number) => new Date(value).toISOString();

function fixture(t: TestContext, git = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-inbox-')); const source = join(directory, 'source'); mkdirSync(source);
  if (git) { execFileSync('git', ['init', '--quiet'], { cwd: source, windowsHide: true }); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/inbox.git'], { cwd: source, windowsHide: true }); }
  const store = new Store(':memory:'); const flow = new Workflow(store, () => now); const { actor: owner, token } = store.bootstrap();
  const workspace = (flow.execute(owner, 'workspace_register', { root: source, name: 'Inbox fixture', prefix: 'INB', idempotencyKey: randomUUID() }) as any).workspace as Workspace;
  if (git) flow.execute(owner, 'workspace_git_bind', { workspaceId: workspace.id, expectedBindingId: null, idempotencyKey: randomUUID() });
  const cmd = (operation: string, args: any = {}, actor = owner): any => flow.execute(actor, operation, { workspaceId: workspace.id, idempotencyKey: randomUUID(), ...args });
  const current = (id: string) => store.get<Issue>('issue', id);
  const change = (operation: string, id: string, args: any = {}, actor = owner) => cmd(operation, { issueId: id, expectedVersion: current(id).version, ...args }, actor);
  const issue = (parentId?: string) => cmd('issue_create', parentId ? { parentId, expectedParentVersion: current(parentId).version, title: '[Feature] Fixture: inspect evidence -> preserve human control', description: 'Automated fixture task', criteria: ['C1'] } : { title: 'Automated inbox fixture', description: 'Automated source verification, not actual user approval', criteria: ['C1'] }).issue as Issue;
  const design = (id: string, approved = false) => {
    change('design_set', id, { content: 'Automated fixture design; no real product approval', criteria: ['C1'] });
    change('design_submit', id);
    if (approved) change('design_decide', id, { designId: current(id).designId, decision: 'APPROVED', reason: 'Explicit automated fixture setup only' });
    return store.get<Design>('design', current(id).designId!);
  };
  const list = (query: any = {}) => flow.execute(owner, 'inbox_list', query) as any;
  const pin = (targetId: string, operation: string, at: number) => {
    const row = store.db.prepare('SELECT sequence FROM events WHERE target_id=? AND operation=? ORDER BY sequence DESC LIMIT 1').get(targetId, operation) as { sequence: number };
    assert.ok(row); store.db.prepare('UPDATE events SET at=? WHERE sequence=?').run(iso(at), row.sequence); return row.sequence;
  };
  const enroll = (role: 'lead' | 'pm' | 'worker' | 'qa') => cmd('actor_enroll', { role, name: `Automated ${role} fixture` });
  t.after(() => { store.close(); const path = resolve(directory); assert.equal(dirname(path), resolve(tmpdir())); assert.ok(basename(path).startsWith('agiledev-inbox-')); rmSync(path, { recursive: true, force: true }); });
  return { directory, source, store, flow, owner, token, workspace, cmd, current, change, issue, design, list, pin, enroll };
}
type Fixture = ReturnType<typeof fixture>;
function database(store: Store) { return canonical(['records', 'events', 'receipts', 'credentials'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())); }
function delivery(f: Fixture) {
  const issue = f.issue(); const design = f.design(issue.id, true); const worker = f.enroll('worker').actor as Actor; const lead = f.enroll('lead').actor as Actor;
  const root = join(f.directory, `delivery-${randomUUID()}`); mkdirSync(root); writeFileSync(join(root, 'delivery.txt'), 'Automated fixture artifact\n');
  const runId = randomUUID(); const execution: Actor = { ...worker, id: randomUUID(), principalId: worker.id, runId, sessionId: randomUUID() }; f.store.token(execution);
  f.store.put('run', { id: runId, workspaceId: f.workspace.id, issueId: issue.id, actorId: worker.id, harness: 'codex', kind: 'implementation', state: 'SUCCEEDED', version: 1, createdAt: iso(now), designId: design.id, scopeRevision: 1, providerSessionId: `automated-provider-double-${runId}`, executionActorId: execution.id, executionRoot: root }, f.workspace.id);
  const files = [{ path: 'delivery.txt', hash: hash('Automated fixture artifact\n'), bytes: Buffer.byteLength('Automated fixture artifact\n'), mode: '100644' }];
  const candidate: Candidate = { id: randomUUID(), workerId: execution.id, sessionId: execution.sessionId, designId: design.id, files: files.map(({ path, hash }) => ({ path, hash })), hash: hash(canonical(files)), summary: 'Automated fixture, no native model run', executionRoot: root, runId, digestPolicy: 4 };
  const snapshot: Snapshot = { id: randomUUID(), workspaceId: f.workspace.id, issueId: issue.id, candidateId: candidate.id, root, files, hash: hash(canonical(files)), createdAt: iso(now) }; candidate.snapshotId = snapshot.id;
  f.store.put('snapshot', snapshot, f.workspace.id); f.store.put('candidate', candidate, f.workspace.id);
  const qaRunId = randomUUID(); const reportId = randomUUID();
  f.store.put('run', { id: qaRunId, issueId: issue.id, workspaceId: f.workspace.id, actorId: 'automated-qa-double', harness: 'dsh', kind: 'qa', state: 'SUCCEEDED', version: 1, createdAt: iso(now), designId: design.id, scopeRevision: 1, candidateId: candidate.id, snapshotId: snapshot.id }, f.workspace.id);
  f.store.put('qa_report', { id: reportId, workspaceId: f.workspace.id, issueId: issue.id, runId: qaRunId, candidateId: candidate.id, snapshotId: snapshot.id, verdict: 'PASS', results: [], findings: [], summary: 'Explicit automated evidence fixture, not actual independent QA' }, f.workspace.id);
  const review = (stage: string, extra = {}) => { const id = randomUUID(); f.store.put('review', { id, issueId: issue.id, workspaceId: f.workspace.id, candidateId: candidate.id, snapshotId: snapshot.id, stage, verdict: 'PASS', ...extra }, f.workspace.id); return id; };
  const ready = f.current(issue.id); ready.candidate = candidate; ready.initialReview = review('PRE_QA'); ready.qaReview = review('QA', { reportId }); ready.state = 'LEAD_REVIEW'; ready.stage = 'FINAL'; f.store.put('issue', ready, f.workspace.id);
  f.change('review_submit', issue.id, { candidateId: candidate.id, verdict: 'PASS', reason: 'Automated source fixture lead action' }, lead);
  const digest = () => acceptanceDigest(f.store, f.current(issue.id));
  return { issueId: issue.id, candidate, snapshot, digest, accept: () => f.change('delivery_decide', issue.id, { candidateId: candidate.id, digest: digest(), decision: 'ACCEPT', reason: 'Explicit automated fixture acceptance, not user delivery approval' }) };
}

test('human inbox derives current design target, preserves metadata age and resets a resubmission epoch', t => {
  const f = fixture(t); const issue = f.issue(); const design = f.design(issue.id); const first = f.pin(issue.id, 'design_submit', now - 3 * day);
  const before = database(f.store); const entry = f.list().entries[0];
  assert.equal(entry.kind, 'DESIGN_REVIEW'); assert.equal(entry.target.designId, design.id); assert.equal(entry.target.designHash, design.hash); assert.equal(entry.pendingSequence, first); assert.equal(entry.ageMs, 3 * day);
  assert.equal(database(f.store), before);
  f.change('issue_update', issue.id, { title: 'Renamed fixture', priority: 1 });
  assert.equal(f.list().entries[0].id, entry.id); assert.equal(f.list().entries[0].pendingSequence, first); assert.equal(f.list().entries[0].target.issueVersion, f.current(issue.id).version);
  f.change('design_decide', issue.id, { designId: design.id, decision: 'CHANGES_REQUESTED', reason: 'Automated rejection fixture' }); assert.equal(f.list().total, 0);
  f.change('design_submit', issue.id); const second = f.pin(issue.id, 'design_submit', now - day);
  assert.equal(f.list().entries[0].pendingSequence, second); assert.equal(f.list().entries[0].ageMs, day); assert.notEqual(f.list().entries[0].id, entry.id);
});

test('superseded design revisions do not duplicate the current inbox target', t => {
  const f = fixture(t); const issue = f.issue(); const old = f.design(issue.id); const next = f.design(issue.id);
  assert.equal(f.store.get<Design>('design', old.id).status, 'IN_REVIEW');
  assert.equal(f.list().total, 1); assert.equal(f.list().entries[0].target.designId, next.id);
});

test('missing or malformed audit timestamps remain explicitly unknown', t => {
  const f = fixture(t); const issue = f.issue(); f.design(issue.id);
  f.store.db.prepare("UPDATE events SET at='unknown' WHERE target_id=? AND operation='design_submit'").run(issue.id);
  const entry = f.list().entries[0]; assert.equal(entry.pendingSince, null); assert.equal(entry.ageMs, null); assert.equal(entry.ageProvenance, 'UNAVAILABLE');
  f.store.db.prepare("DELETE FROM events WHERE target_id=? AND operation='design_submit'").run(issue.id);
  assert.equal(f.list().entries[0].pendingSequence, null);
  assert.equal((f.flow.execute(f.owner, 'gap_list', { workspaceId: f.workspace.id }) as any).gaps.some((gap: any) => gap.code === 'HUMAN_DECISION_AGING'), false);
});

test('abandoned-child scope stays pending through parent holds and metadata, then follows explicit scope cycles', t => {
  const f = fixture(t); const parent = f.issue(); f.design(parent.id, true); const child = f.issue(parent.id);
  f.change('issue_transition', child.id, { action: 'abandon', reason: 'Automated scope fixture' }); const first = f.pin(child.id, 'issue_transition', now - 2 * day);
  const pending = f.list().entries.find((entry: any) => entry.kind === 'SCOPE_DECISION'); assert.equal(pending.pendingSequence, first);
  f.change('issue_transition', parent.id, { action: 'hold', reason: 'Automated hold fixture' }); f.change('issue_update', parent.id, { title: 'Held parent renamed' });
  assert.equal(f.list().entries.find((entry: any) => entry.kind === 'SCOPE_DECISION').id, pending.id);
  const decide = (action: 'EXCLUDE' | 'RESTORE') => {
    const packet = f.flow.execute(f.owner, 'scope_get', { workspaceId: f.workspace.id, issueId: child.id }) as any; const target = packet.children.find((item: any) => item.issue.id === child.id);
    return f.change('scope_decide', child.id, { expectedParentVersion: f.current(parent.id).version, designId: f.current(parent.id).designId, expectedDecisionId: f.current(child.id).scopeDecisionId ?? null, scopeHash: packet.scopeHash, childScopeHash: target.scopeHash, action, reason: 'Automated explicit human scope fixture' });
  };
  decide('EXCLUDE'); assert.equal(f.list().entries.some((entry: any) => entry.kind === 'SCOPE_DECISION'), false);
  decide('RESTORE'); assert.equal(f.list().entries.some((entry: any) => entry.kind === 'SCOPE_DECISION'), false);
  f.change('issue_transition', child.id, { action: 'reopen', reason: 'Automated reopened scope fixture' });
  f.change('issue_transition', child.id, { action: 'abandon', reason: 'New automated abandonment cycle' }); const second = f.pin(child.id, 'issue_transition', now - day);
  assert.equal(f.list().entries.find((entry: any) => entry.kind === 'SCOPE_DECISION').pendingSequence, second);
});

test('a stale exclusion binds the new material scope without resetting on later metadata', t => {
  const f = fixture(t); const parent = f.issue(); f.design(parent.id, true); const child = f.issue(parent.id);
  f.change('issue_transition', child.id, { action: 'abandon', reason: 'Automated scope fixture' });
  const packet = f.flow.execute(f.owner, 'scope_get', { workspaceId: f.workspace.id, issueId: child.id }) as any;
  f.change('scope_decide', child.id, { expectedParentVersion: f.current(parent.id).version, designId: f.current(parent.id).designId, expectedDecisionId: null, scopeHash: packet.scopeHash, childScopeHash: packet.children[0].scopeHash, action: 'EXCLUDE', reason: 'Automated exclusion fixture' });
  f.change('design_set', parent.id, { content: 'New material fixture design', criteria: ['C1'] }); const changed = f.pin(parent.id, 'design_set', now - 2 * day);
  const entry = f.list().entries.find((value: any) => value.kind === 'SCOPE_DECISION'); assert.equal(entry.pendingSequence, changed); assert.ok(entry.blockers.includes('SCOPE_DECISION_STALE'));
  f.change('issue_update', parent.id, { priority: 0 }); assert.equal(f.list().entries.find((value: any) => value.kind === 'SCOPE_DECISION').id, entry.id);
});

test('unrelated repository binding changes do not replace an artifact scope decision target', t => {
  const f = fixture(t, true);
  const parent = f.cmd('issue_create', { title: 'Artifact scope fixture', description: 'Explicit non-Git fixture scope', criteria: ['C1'], artifactMode: 'artifact', artifactReason: 'Fixture document delivery' }).issue as Issue;
  f.design(parent.id, true); const child = f.issue(parent.id);
  f.change('issue_transition', child.id, { action: 'abandon', reason: 'Automated artifact scope fixture' }); f.pin(child.id, 'issue_transition', now - day);
  const before = f.list().entries.find((entry: any) => entry.kind === 'SCOPE_DECISION');
  const bindingId = f.store.get<Workspace>('workspace', f.workspace.id).gitBindingId;
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/fixture/other.git'], { cwd: f.source, windowsHide: true });
  f.cmd('workspace_git_bind', { expectedBindingId: bindingId });
  const after = f.list().entries.find((entry: any) => entry.kind === 'SCOPE_DECISION');
  assert.equal(after.id, before.id); assert.equal(after.pendingSequence, before.pendingSequence);
});

test('uncertain execution uses the uncertainty event rather than run creation and preserves its first epoch', t => {
  const f = fixture(t); const issue = f.issue(); const id = randomUUID();
  const run: Run = { id, workspaceId: f.workspace.id, issueId: issue.id, actorId: f.owner.id, harness: 'codex', state: 'UNCERTAIN', version: 2, createdAt: iso(now - 30 * day), designId: 'automated-design', scopeRevision: 1 };
  f.store.put('run', run, f.workspace.id); f.store.event(f.workspace.id, f.owner, 'run_uncertain', id, { reason: 'Automated lost-coordinator fixture' }); const first = f.pin(id, 'run_uncertain', now - day);
  f.store.event(f.workspace.id, f.owner, 'run_uncertain', id, { reason: 'Repeated observation fixture' });
  const entry = f.list().entries[0]; assert.equal(entry.target.runId, id); assert.equal(entry.pendingSequence, first); assert.equal(entry.ageMs, day);
  f.cmd('run_reconcile', { runId: id, expectedVersion: 2, confirmStopped: true, reason: 'Automated fixture has no external process' }); assert.equal(f.list().total, 0);
  const orphan = { ...run, id: randomUUID(), version: 1 }; f.store.put('run', orphan, f.workspace.id);
  assert.equal(f.list().entries[0].pendingSince, null);
});

test('legacy work reconciliation is actionable while held but not on historical DONE records', t => {
  const f = fixture(t); const issue = f.issue(); const legacy = f.current(issue.id); legacy.unmanagedExecution = true;
  f.store.put('issue', legacy, f.workspace.id); f.store.event(f.workspace.id, f.owner, 'legacy_work_detected', legacy.id, { changes: { unmanagedExecution: { before: undefined, after: true } } }); const first = f.pin(legacy.id, 'legacy_work_detected', now - day);
  const entry = f.list().entries[0]; assert.equal(entry.nextAction, 'work_reconcile'); assert.equal(entry.pendingSequence, first);
  f.change('issue_transition', issue.id, { action: 'hold', reason: 'Automated held legacy fixture' }); assert.equal(f.list().entries[0].id, entry.id);
  const done = f.current(issue.id); done.state = 'DONE'; f.store.put('issue', done, f.workspace.id); assert.equal(f.list().total, 0);
});

test('current acceptance remains actionable through Git recovery and closes only on explicit completion', async t => {
  const f = fixture(t, true); const d = delivery(f);
  const submission = f.change('git_submit', d.issueId, { candidateId: d.candidate.id, commitUrl: `https://github.com/fixture/inbox/commit/${'1'.repeat(40)}` }).git as GitSubmission;
  d.accept(); const acceptedAt = f.pin(d.issueId, 'delivery_decide', now - 3 * day);
  const accepted = f.list().entries.find((entry: any) => entry.kind === 'CLOSURE_BLOCKED'); assert.equal(accepted.pendingSequence, acceptedAt); assert.equal(accepted.status, 'BLOCKED');
  const verifier = new GitVerifier(f.store, { resolve: async () => ({ rootTreeSha: snapshotGitTree(d.snapshot), treeSha: snapshotGitTree(d.snapshot) }), resolveEntry: async () => { throw new Error('No secondary entry in fixture'); } });
  try { verifier.tick(); for (let count = 0; count < 100 && f.store.get<GitSubmission>('git_submission', submission.id).state !== 'VERIFIED'; count++) await new Promise(resolve => setTimeout(resolve, 10)); }
  finally { await verifier.close(); }
  assert.equal(f.store.get<GitSubmission>('git_submission', submission.id).state, 'VERIFIED'); assert.equal(f.current(d.issueId).state, 'USER_ACCEPTANCE');
  const ready = f.list().entries.find((entry: any) => entry.kind === 'CLOSURE_BLOCKED'); assert.equal(ready.id, accepted.id); assert.equal(ready.pendingSequence, acceptedAt); assert.equal(ready.status, 'READY_TO_COMPLETE'); assert.equal(ready.nextAction, 'delivery_complete');
  const approvalCount = f.store.list('delivery_approval', f.workspace.id).length;
  f.change('delivery_complete', d.issueId); assert.equal(f.current(d.issueId).state, 'DONE'); assert.equal(f.list().total, 0); assert.equal(f.store.list('delivery_approval', f.workspace.id).length, approvalCount);
});

test('delivery target replacement requires the current decision and starts its exact new epoch', t => {
  const f = fixture(t, true); const d = delivery(f);
  f.change('git_submit', d.issueId, { candidateId: d.candidate.id, commitUrl: `https://github.com/fixture/inbox/commit/${'1'.repeat(40)}` }); d.accept();
  const old = f.list().entries.find((entry: any) => entry.kind === 'CLOSURE_BLOCKED');
  f.change('git_submit', d.issueId, { candidateId: d.candidate.id, commitUrl: `https://github.com/fixture/inbox/commit/${'2'.repeat(40)}` }); const replaced = f.pin(d.issueId, 'git_submit', now - day);
  const current = f.list().entries.find((entry: any) => entry.kind === 'DELIVERY_ACCEPTANCE'); assert.equal(current.pendingSequence, replaced); assert.notEqual(current.target.digest, old.target.digest); assert.notEqual(current.id, old.id);
});

test('versioned settings are human-only and idempotent without changing workspace, issue, approval, or grant data', t => {
  const f = fixture(t); const d = delivery(f); const grant = { id: randomUUID(), version: 1, fixture: 'Unrelated authority must remain unchanged' }; f.store.put('grant', grant, f.workspace.id);
  const protectedRows = () => canonical(['workspace', 'issue', 'approval', 'delivery_approval', 'grant'].map(kind => f.store.list(kind)));
  const before = protectedRows(); const digest = d.digest(); const readBefore = database(f.store);
  assert.equal((f.flow.execute(f.owner, 'inbox_settings_get', { workspaceId: f.workspace.id }) as any).settings.version, 0); assert.equal(database(f.store), readBefore);
  const key = randomUUID(); const args = { workspaceId: f.workspace.id, expectedVersion: 0, agingThresholdHours: 1, idempotencyKey: key };
  const saved = f.flow.execute(f.owner, 'inbox_settings_update', args) as any; assert.equal(saved.settings.version, 1);
  assert.equal((f.flow.execute(f.owner, 'inbox_settings_update', args) as any).replayed, true);
  assert.equal(f.store.list('inbox_settings').length, 1); assert.equal(protectedRows(), before); assert.equal(d.digest(), digest);
  assert.throws(() => f.cmd('inbox_settings_update', { expectedVersion: 0, agingThresholdHours: 2 }), (error: any) => error.code === 'VERSION_CONFLICT');
  for (const hours of [0, 169, 1.5]) assert.throws(() => f.cmd('inbox_settings_update', { expectedVersion: 1, agingThresholdHours: hours }), (error: any) => error.code === 'INVALID_INPUT');
  assert.equal(f.store.list<any>('inbox_settings')[0].version, 1);
  for (const role of ['lead', 'pm', 'worker', 'qa'] as const) {
    const agent = f.enroll(role).actor as Actor;
    for (const [operation, input] of [['inbox_list', {}], ['inbox_settings_get', { workspaceId: f.workspace.id }], ['inbox_settings_update', { ...args, idempotencyKey: randomUUID() }]] as const) assert.throws(() => f.flow.execute(agent, operation, input), (error: any) => error.code === 'ROLE_DENIED');
  }
  for (const operation of ['inbox_list', 'inbox_settings_get', 'inbox_settings_update']) assert.equal((agentOperations as string[]).includes(operation), false);
});

test('aging gaps are strictly older-than-threshold and remain scoped to readable issue rows', t => {
  const f = fixture(t); const root = f.issue(); f.design(root.id); f.pin(root.id, 'design_submit', now - day);
  const gaps = (actor = f.owner) => (f.flow.execute(actor, 'gap_list', { workspaceId: f.workspace.id }) as any).gaps.filter((gap: any) => gap.code === 'HUMAN_DECISION_AGING');
  assert.equal(gaps().length, 0);
  f.pin(root.id, 'design_submit', now - day - 1); assert.equal(gaps().length, 1); assert.equal(gaps()[0].severity, 'advisory'); assert.equal(gaps()[0].kind, 'DESIGN_REVIEW');
  const worker = f.enroll('worker').actor as Actor; assert.equal(gaps(worker).length, 0);
  const parent = f.issue(); f.design(parent.id, true); const child = f.issue(parent.id); f.change('issue_transition', child.id, { action: 'abandon', reason: 'Automated scope aging fixture' }); f.pin(child.id, 'issue_transition', now - 2 * day);
  assert.ok(gaps().some((gap: any) => gap.kind === 'SCOPE_DECISION' && gap.issueId === child.id));
  f.cmd('inbox_settings_update', { expectedVersion: 0, agingThresholdHours: 168 }); assert.equal(gaps().length, 0);
});

test('workspace/kind filters and stable pagination preserve global summary within the selected scope', t => {
  const f = fixture(t); for (let index = 0; index < 4; index++) { const issue = f.issue(); f.design(issue.id); f.pin(issue.id, 'design_submit', now - day); }
  const otherRoot = join(f.directory, 'other'); mkdirSync(otherRoot); const other = (f.flow.execute(f.owner, 'workspace_register', { root: otherRoot, name: 'Second fixture', prefix: 'OTH', idempotencyKey: randomUUID() }) as any).workspace;
  const issue = f.cmd('issue_create', { workspaceId: other.id, title: 'Second workspace design', description: 'Fixture' }).issue;
  f.flow.execute(f.owner, 'design_set', { workspaceId: other.id, issueId: issue.id, expectedVersion: issue.version, content: 'Fixture', criteria: ['C1'], idempotencyKey: randomUUID() });
  f.flow.execute(f.owner, 'design_submit', { workspaceId: other.id, issueId: issue.id, expectedVersion: f.current(issue.id).version, idempotencyKey: randomUUID() });
  const before = database(f.store); const first = f.list({ limit: 2 }); const second = f.list({ offset: 2, limit: 2 });
  assert.equal(first.total, 5); assert.equal(first.summary.blocking, 5); assert.equal(new Set([...first.entries, ...second.entries].map((entry: any) => entry.id)).size, 4); assert.equal(first.nextOffset, 2);
  assert.deepEqual(f.list({ limit: 2 }).entries.map((entry: any) => entry.id), first.entries.map((entry: any) => entry.id));
  assert.equal(f.list({ workspaceId: f.workspace.id, kind: 'DESIGN_REVIEW' }).total, 4); assert.equal(f.list({ kind: 'CLOSURE_BLOCKED' }).total, 0); assert.equal(database(f.store), before);
});

test('representative event volume remains a bounded read with no materialized queue', t => {
  const f = fixture(t); const issue = f.issue(); f.design(issue.id); f.pin(issue.id, 'design_submit', now - day);
  f.store.db.transaction(() => { for (let index = 0; index < 2000; index++) f.store.event(f.workspace.id, f.owner, 'fixture_observation', `unrelated-${index % 100}`, { index }); }).immediate();
  const before = database(f.store); const started = performance.now(); const result = f.list({ limit: 1 }); const elapsed = performance.now() - started;
  assert.equal(result.entries.length, 1); assert.equal(result.total, 1); assert.equal(database(f.store), before); assert.equal(f.store.list('inbox_entry').length, 0);
  t.diagnostic(`One pending target with 2,000 unrelated audit events: ${elapsed.toFixed(2)} ms; not full AC37 acceptance.`);
});

test('HTTP and real MCP transport cannot bypass human-only inbox commands', async t => {
  const f = fixture(t); const issue = f.issue(); f.design(issue.id); const enrolled = f.enroll('lead'); const server = createServer(f.store); await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address(); assert.ok(address && typeof address !== 'string'); const endpoint = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: 'inbox-source-fixture', version: '1.0' });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.AGILEDEV_ENDPOINT = endpoint; env.AGILEDEV_TOKEN = enrolled.token;
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'mcp'], env, stderr: 'pipe' });
  try {
    const denied = await server.inject({ method: 'POST', url: '/api/command/inbox_list', headers: { host: `127.0.0.1:${address.port}`, authorization: `Bearer ${enrolled.token}` }, payload: {} }); assert.equal(denied.statusCode, 403); assert.equal(denied.json().error.code, 'ROLE_DENIED');
    const allowed = await server.inject({ method: 'POST', url: '/api/command/inbox_list', headers: { host: `127.0.0.1:${address.port}`, authorization: `Bearer ${f.token}` }, payload: {} }); assert.equal(allowed.statusCode, 200); assert.equal(allowed.json().result.total, 1);
    await client.connect(transport); const tools = (await client.listTools()).tools.map(tool => tool.name);
    for (const operation of ['inbox_list', 'inbox_settings_get', 'inbox_settings_update']) { assert.equal(tools.includes(operation), false); assert.equal((await client.callTool({ name: operation, arguments: {} })).isError, true); }
    for (let count = 0; count < 100 && !f.store.list('connection', f.workspace.id).length; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.store.list('connection', f.workspace.id).length, 1);
    const readsBefore = database(f.store); await client.callTool({ name: 'gap_list', arguments: { workspaceId: f.workspace.id } }); assert.equal(database(f.store), readsBefore);
  } finally { await client.close(); await server.close(); }
});
