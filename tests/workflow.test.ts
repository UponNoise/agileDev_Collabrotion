import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Actor, DomainError, Issue, Run, agentOperations } from '../src/contracts.js';
import { Store, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { applyFixturePlan, bindFixtureImplementation } from './fixtures.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-test-'));
  const store = new Store(join(root, 'data.sqlite'));
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const human = store.bootstrap();
  let clock = Date.now();
  const workflow = new Workflow(store, () => clock);
  const call = (actor: Actor, op: string, input: object = {}) => workflow.execute(actor, op, { ...(['workspace_list', 'issue_get', 'issue_list', 'run_get', 'run_list', 'gap_list', 'event_list', 'grant_list'].includes(op) ? {} : { idempotencyKey: randomUUID() }), ...input }) as any;
  const workspace = call(human.actor, 'workspace_register', { root, name: 'Test workspace', prefix: 'TEST' }).workspace;
  const enroll = (role: string) => call(human.actor, 'actor_enroll', { workspaceId: workspace.id, role, name: `${role} test` });
  const lead = enroll('lead'); const pm = enroll('pm'); const worker = enroll('worker'); const qa = enroll('qa');
  const run = (actor: Actor, op: string, input: object = {}) => call(actor, op, { workspaceId: workspace.id, ...input });
  const parent = run(lead.actor, 'issue_create', { title: 'Deliver workspace binding', description: 'Preserve the active workspace across harnesses', criteria: ['AC-1'] }).issue as Issue;
  const current = (id: string) => store.get<Issue>('issue', id);
  const change = (actor: Actor, op: string, issueId: string, input: object = {}) => run(actor, op, { issueId, expectedVersion: current(issueId).version, ...(op === 'grant_create' ? { scopeHash: run(human.actor,'issue_get',{ issueId }).authorizationScopeHash } : {}), ...input });
  const approve = () => {
    change(lead.actor, 'design_set', parent.id, { content: 'Explicit active workspace binding and cross-harness state', criteria: ['AC-1'] });
    change(lead.actor, 'design_submit', parent.id);
    change(human.actor, 'design_decide', parent.id, { designId: current(parent.id).designId, decision: 'APPROVED', reason: 'Approve this exact test design' });
    if (store.list<Issue>('issue',workspace.id).some(i => i.parentId === parent.id)) applyFixturePlan(workflow,pm.actor,parent.id);
  };
  const task = () => { const issue = run(pm.actor, 'issue_create', { parentId: parent.id, expectedParentVersion: current(parent.id).version, title: '[Feature] Binding: select active root -> scoped commands', description: 'Implement explicit root binding', criteria: ['AC-1'] }).issue as Issue; applyFixturePlan(workflow,pm.actor,parent.id); return issue; };
  const assign = (i: Issue) => change(pm.actor, 'issue_assign', i.id, { actorId: worker.actor.id, harness: 'codex' });
  const executions = new Map<string,ReturnType<typeof bindFixtureImplementation>>();
  const claim = (i: Issue) => {
    if (!workflow.readiness(current(i.id)).ready) return change(worker.actor,'work_claim',i.id,{ designId: current(parent.id).designId ?? 'unapproved',scopeRevision: current(i.id).scopeRevision });
    const binding = bindFixtureImplementation(workflow,pm.actor,worker.actor,i.id); cleanup.push(binding.dispose); executions.set(i.id,binding);
    const result = change(binding.actor,'work_claim',i.id,{ designId: current(parent.id).designId,scopeRevision: current(i.id).scopeRevision }); binding.activate(); return result;
  };
  const execution = (id: string) => executions.get(id)!;
  return { root, store, human, lead, pm, worker, qa, run, call, parent, current, change, approve, task, assign, claim,execution,advance: () => { clock += 300001; } };
}
function rejects(code: string) { return (error: unknown) => error instanceof DomainError && error.code === code; }

test('human grants constrain actor, issue, action and use count with exactly-once retries', () => {
  const f = setup(); const task = f.task();
  const request = { granteeId: f.pm.actor.id,action: 'hold',expiresAt: new Date(Date.now()+3600000).toISOString(),maxUses: 1,reason: 'Automated fixture authorization for this task only' };
  assert.throws(() => f.change(f.lead.actor,'grant_create',task.id,request),rejects('ROLE_DENIED'));
  assert.throws(() => f.change(f.human.actor,'grant_create',task.id,{ ...request,granteeId: f.worker.actor.id }),rejects('GRANTEE_INVALID'));
  const grant = f.change(f.human.actor,'grant_create',task.id,request).grant;
  assert.equal(f.run(f.pm.actor,'grant_list',{ issueId: task.id }).grants[0].status,'AVAILABLE');
  assert.equal(f.run(f.lead.actor,'grant_list',{ issueId: task.id }).total,0);
  f.change(f.human.actor,'grant_create',task.id,{ ...request,granteeId: f.lead.actor.id });
  const firstPage = f.run(f.human.actor,'grant_list',{ issueId: task.id,limit: 1 });
  assert.equal(firstPage.total,2); assert.equal(firstPage.grants.length,1); assert.equal(firstPage.nextOffset,1);
  assert.notEqual(f.run(f.human.actor,'grant_list',{ issueId: task.id,limit: 1,offset: 1 }).grants[0].id,firstPage.grants[0].id);
  assert.equal(f.run(f.pm.actor,'grant_list',{ issueId: task.id }).total,1);
  assert.throws(() => f.run(f.worker.actor,'grant_list',{ issueId: task.id }),rejects('ROLE_DENIED'));
  assert.throws(() => f.change(f.lead.actor,'issue_transition',task.id,{ action: 'hold',grantId: grant.id,reason: 'Wrong agent' }),rejects('GRANT_DENIED'));
  assert.throws(() => f.change(f.pm.actor,'issue_transition',f.parent.id,{ action: 'hold',grantId: grant.id,reason: 'Wrong issue' }),rejects('GRANT_DENIED'));
  assert.throws(() => f.change(f.pm.actor,'issue_transition',task.id,{ action: 'abandon',grantId: grant.id,reason: 'Wrong action' }),rejects('GRANT_DENIED'));
  const input = { workspaceId: task.workspaceId,issueId: task.id,expectedVersion: f.current(task.id).version,action: 'hold',grantId: grant.id,reason: 'Apply the exact fixture grant',idempotencyKey: randomUUID() };
  assert.equal(f.call(f.pm.actor,'issue_transition',input).issue.state,'ON_HOLD');
  assert.equal(f.call(f.pm.actor,'issue_transition',input).replayed,true);
  assert.equal(f.store.get<any>('grant',grant.id).uses,1);
  f.change(f.human.actor,'issue_transition',task.id,{ action: 'resume',reason: 'Resume fixture without delegating another action' });
  assert.throws(() => f.change(f.pm.actor,'issue_transition',task.id,{ action: 'hold',grantId: grant.id,reason: 'Exhausted authorization' }),rejects('GRANT_EXHAUSTED'));
  const used = f.run(f.human.actor,'event_list').events.filter((event: any) => event.operation === 'grant_used');
  assert.equal(used.length,1); assert.equal(used[0].actorId,f.pm.actor.id);
});

test('failed delegated actions roll back grant use and revocation persists across service access', () => {
  const f = setup(); f.task();
  const grant = f.change(f.human.actor,'grant_create',f.parent.id,{ granteeId: f.lead.actor.id,action: 'abandon',expiresAt: new Date(Date.now()+3600000).toISOString(),reason: 'Fixture delegation cannot hide unresolved children' }).grant;
  assert.throws(() => f.change(f.lead.actor,'issue_transition',f.parent.id,{ action: 'abandon',grantId: grant.id,reason: 'Attempt unresolved parent cancellation' }),rejects('CHILD_DISPOSITION_REQUIRED'));
  assert.equal(f.store.get<any>('grant',grant.id).uses,0);
  assert.ok(!f.run(f.human.actor,'event_list').events.some((event: any) => event.operation === 'grant_used'));
  const revoked = f.change(f.human.actor,'grant_revoke',f.parent.id,{ grantId: grant.id,expectedGrantVersion: 1,reason: 'Human fixture revokes unused authority' }).grant;
  assert.equal(revoked.revokedBy,f.human.actor.id);
  const secondStore = new Store(join(f.root,'data.sqlite'));
  try {
    const reconnected = new Workflow(secondStore);
    assert.equal((reconnected.execute(f.lead.actor,'grant_list',{ workspaceId: f.parent.workspaceId,issueId: f.parent.id }) as any).grants[0].status,'REVOKED');
    assert.throws(() => f.change(f.lead.actor,'issue_transition',f.parent.id,{ action: 'abandon',grantId: grant.id,reason: 'Revoked authority' }),rejects('GRANT_REVOKED'));
  } finally { secondStore.close(); }
});

test('grant expiry, stale scope and metadata are evaluated independently', () => {
  const f = setup(); const task = f.task(); f.approve();
  const grant = (issueId: string,expiresAt = new Date(Date.now()+3600000).toISOString()) => f.change(f.human.actor,'grant_create',issueId,{ granteeId: f.pm.actor.id,action: 'hold',expiresAt,maxUses: 2,reason: 'Exact-scope fixture grant' }).grant;
  assert.throws(() => grant(task.id,new Date(Date.now()-1000).toISOString()),rejects('GRANT_EXPIRY_INVALID'));
  assert.throws(() => grant(task.id,new Date(Date.now()+8*86400000).toISOString()),rejects('GRANT_EXPIRY_INVALID'));
  const valid = grant(task.id);
  f.change(f.pm.actor,'issue_update',task.id,{ dueDate: '2026-12-01',priority: 1 });
  f.change(f.pm.actor,'issue_transition',task.id,{ action: 'hold',grantId: valid.id,reason: 'Metadata retained scoped authority' });
  assert.throws(() => f.change(f.human.actor,'grant_revoke',task.id,{ grantId: valid.id,expectedGrantVersion: 1,reason: 'Stale revocation must reload' }),rejects('VERSION_CONFLICT'));
  f.change(f.human.actor,'issue_transition',task.id,{ action: 'resume',reason: 'Resume fixture' });
  f.change(f.lead.actor,'design_set',f.parent.id,{ content: 'Materially revised fixture design',criteria: ['AC-1'] });
  assert.throws(() => f.change(f.pm.actor,'issue_transition',task.id,{ action: 'hold',grantId: valid.id,reason: 'Old design authority' }),rejects('GRANT_STALE'));
  const parentGrant = grant(f.parent.id); f.task();
  assert.throws(() => f.change(f.pm.actor,'issue_transition',f.parent.id,{ action: 'hold',grantId: parentGrant.id,reason: 'New child changed authorized scope' }),rejects('GRANT_STALE'));
  const capturedHash = f.run(f.human.actor,'issue_get',{ issueId: f.parent.id }).authorizationScopeHash;
  f.change(f.pm.actor,'issue_update',task.id,{ description: 'Changed child scope without a parent metadata edit' });
  assert.throws(() => f.change(f.human.actor,'grant_create',f.parent.id,{ granteeId: f.pm.actor.id,action: 'hold',scopeHash: capturedHash,expiresAt: new Date(Date.now()+3600000).toISOString(),reason: 'An unseen child change cannot inherit authorization' }),rejects('GRANT_SCOPE_STALE'));
  const expiring = grant(task.id,new Date(Date.now()+60000).toISOString()); f.advance();
  assert.throws(() => f.change(f.pm.actor,'issue_transition',task.id,{ action: 'hold',grantId: expiring.id,reason: 'Expired authority' }),rejects('GRANT_EXPIRED'));
});

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
  assert.equal(claim.state, 'IN_PROGRESS'); assert.equal(claim.lease.actorId, f.execution(task.id).actor.id);
  assert.equal(f.current(f.parent.id).state, 'IN_PROGRESS');
  f.advance();
  assert.throws(() => f.change(f.execution(task.id).actor, 'work_heartbeat', task.id, { fence: claim.fence }), rejects('LEASE_EXPIRED'));
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

test('bound submissions are hashed but unsealed or live producer output cannot enter review', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task); f.claim(task);
  writeFileSync(join(f.execution(task.id).root, 'output.txt'), 'version one');
  f.change(f.execution(task.id).actor, 'work_submit', task.id, { fence: f.current(task.id).fence, summary: 'Implemented unit fixture output', files: ['output.txt'] });
  const submitted = f.current(task.id);
  assert.equal(submitted.stage, 'PRE_QA'); assert.equal(submitted.candidate!.files.length, 1);
  assert.equal(submitted.candidate!.files[0]!.hash,hash('version one'));
  writeFileSync(join(f.execution(task.id).root, 'output.txt'), 'version two');
  assert.throws(() => f.change(f.lead.actor, 'review_submit', task.id, { candidateId: submitted.candidate!.id, verdict: 'PASS', reason: 'reviewed' }), rejects('RUN_STILL_LIVE'));
});

test('historical unbound candidates stay readable but cannot advance a lead or QA gate', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task);
  const issue = f.current(task.id); const candidateId = randomUUID();
  issue.state = 'LEAD_REVIEW'; issue.stage = 'PRE_QA'; issue.candidate = { id: candidateId,workerId: f.worker.actor.id,sessionId: f.worker.actor.sessionId,designId: f.current(f.parent.id).designId!,files: [],hash: hash('legacy'),summary: 'Seeded legacy unit fixture, not completed execution evidence' }; f.store.put('issue',issue,issue.workspaceId);
  assert.equal(f.run(f.lead.actor,'issue_get',{ issueId: task.id }).executionRecovery.required,true);
  assert.throws(() => f.change(f.lead.actor,'review_submit',task.id,{ candidateId,verdict: 'PASS',reason: 'Cannot approve legacy output' }),rejects('EXECUTION_BINDING_REQUIRED'));
  assert.equal(f.current(task.id).state,'LEAD_REVIEW');
});

test('human legacy recovery is exact, idempotent, retains history and clears ownership without inventing execution evidence', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task);
  const issue = f.current(task.id); issue.state = 'IN_PROGRESS'; issue.fence = 7; issue.lease = { actorId: f.worker.actor.id,fence: 7,expiresAt: Date.now()+300000 };
  f.store.put('issue',issue,issue.workspaceId);
  assert.equal(agentOperations.includes('work_reconcile'),false);
  assert.throws(() => f.change(f.worker.actor,'work_heartbeat',task.id,{ fence: 7 }),rejects('EXECUTION_BINDING_REQUIRED'));
  assert.throws(() => f.change(f.worker.actor,'work_submit',task.id,{ fence: 7,summary: 'Unbound source checkout',files: ['never-read.txt'] }),rejects('EXECUTION_BINDING_REQUIRED'));
  const request = { workspaceId: task.workspaceId,issueId: task.id,expectedVersion: issue.version,fence: 7,candidateId: null,confirmStopped: true,reason: 'Automated human fixture confirms the untracked worker stopped',idempotencyKey: randomUUID() };
  assert.throws(() => f.call(f.pm.actor,'work_reconcile',request),rejects('ROLE_DENIED'));
  assert.throws(() => f.call(f.human.actor,'work_reconcile',{ ...request,confirmStopped: false }),rejects('INVALID_INPUT'));
  assert.throws(() => f.call(f.human.actor,'work_reconcile',{ ...request,fence: 6 }),rejects('EVIDENCE_STALE'));
  assert.deepEqual(f.current(task.id),issue);
  assert.equal(f.call(f.human.actor,'work_reconcile',request).issue.state,'NOT_STARTED');
  assert.equal(f.call(f.human.actor,'work_reconcile',request).replayed,true);
  const restored = f.current(task.id);
  assert.equal(restored.fence,8); assert.equal(restored.lease,null); assert.equal(restored.unmanagedExecution,undefined);
  assert.equal(f.run(f.human.actor,'issue_get',{ issueId: task.id }).executionRecovery.required,false);
  assert.equal(f.run(f.human.actor,'event_list').events.filter((e: any) => e.operation === 'work_reconcile').length,1);
  assert.equal(f.store.list('run',task.workspaceId).length,0);
  assert.equal(f.claim(task).issue.state,'IN_PROGRESS');
});

test('legacy holds and scope resets preserve the recovery requirement; old candidates remain immutable evidence', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task);
  const issue = f.current(task.id); const candidate = { id: randomUUID(),workerId: f.worker.actor.id,sessionId: f.worker.actor.sessionId,designId: f.current(f.parent.id).designId!,files: [],hash: hash('legacy-test'),summary: 'Explicit legacy fixture candidate' };
  issue.state = 'LEAD_REVIEW'; issue.stage = 'PRE_QA'; issue.candidate = candidate; f.store.put('issue',issue,issue.workspaceId);
  f.change(f.human.actor,'issue_transition',task.id,{ action: 'hold',reason: 'Pause legacy work' });
  assert.equal(f.current(task.id).unmanagedExecution,true);
  f.change(f.lead.actor,'design_set',f.parent.id,{ content: 'Revised test design',criteria: ['AC-1'] });
  assert.equal(f.current(task.id).candidate,null);
  assert.equal(f.run(f.human.actor,'issue_get',{ issueId: task.id }).executionRecovery.required,true);
  f.change(f.human.actor,'work_reconcile',task.id,{ fence: f.current(task.id).fence,candidateId: null,confirmStopped: true,reason: 'Old fixture worker was explicitly stopped' });
  assert.equal(f.current(task.id).state,'ON_HOLD');
  assert.equal(f.current(task.id).savedState?.state,'NOT_STARTED');
  assert.equal(f.run(f.human.actor,'issue_get',{ issueId: task.id }).executionRecovery.required,false);
  assert.deepEqual(f.store.get<any>('candidate',candidate.id),candidate);
});

test('legacy reset cannot clear uncertain managed execution or rewrite completion and preserves abandonment', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task);
  const issue = f.current(task.id); issue.unmanagedExecution = true; f.store.put('issue',issue,issue.workspaceId);
  const run: Run = { id: randomUUID(),issueId: task.id,workspaceId: task.workspaceId,actorId: f.worker.actor.id,harness: 'codex',state: 'UNCERTAIN',version: 1,createdAt: new Date().toISOString(),designId: f.current(f.parent.id).designId!,scopeRevision: issue.scopeRevision };
  f.store.put('run',run,issue.workspaceId);
  const reset = () => f.change(f.human.actor,'work_reconcile',task.id,{ fence: issue.fence,confirmStopped: true,reason: 'Negative fixture recovery' });
  assert.throws(reset,rejects('RUN_EXISTS'));
  run.state = 'CANCELLED'; f.store.put('run',run,issue.workspaceId);
  const terminal = f.current(task.id); terminal.state = 'DONE'; f.store.put('issue',terminal,terminal.workspaceId);
  assert.throws(reset,rejects('ISSUE_CLOSED'));
  terminal.state = 'ABANDONED'; f.store.put('issue',terminal,terminal.workspaceId);
  reset();
  assert.equal(f.current(task.id).state,'ABANDONED');
  assert.equal(f.current(task.id).unmanagedExecution,undefined);
});

test('ancestor holds stop submission and material design changes invalidate active ownership', () => {
  const f = setup(); const task = f.task(); f.approve(); f.assign(task); f.claim(task);
  f.change(f.human.actor, 'issue_transition', f.parent.id, { action: 'hold', reason: 'Pause requirement' });
  assert.throws(() => f.change(f.execution(task.id).actor, 'work_heartbeat', task.id, { fence: f.current(task.id).fence }), rejects('NOT_READY'));
  f.change(f.human.actor, 'issue_transition', f.parent.id, { action: 'resume', reason: 'Continue requirement' });
  f.execution(task.id).stop(f.human.actor);
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
  assert.throws(() => f.change(f.pm.actor,'issue_update',f.parent.id,{ description: 'Must reconcile active execution first' }),rejects('RUN_EXISTS'));
  f.execution(task.id).stop(f.human.actor);
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
  assert.throws(() => f.claim(task),rejects('NOT_READY'));
  applyFixturePlan(new Workflow(f.store),f.pm.actor,f.parent.id);
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
