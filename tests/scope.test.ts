import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Actor, DomainError, Issue, Run, ScopeDecision, agentOperations } from '../src/contracts.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { planCoverage } from '../src/planning.js';
import { scopeState } from '../src/scope.js';
import { applyFixturePlan } from './fixtures.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const fails = (fn: () => unknown, code: string) => assert.throws(fn,(e: unknown) => e instanceof DomainError && e.code === code);
function fixture() {
  const store = new Store(':memory:'); cleanup.push(() => store.close());
  const flow = new Workflow(store); const human = store.bootstrap().actor;
  const invoke = (actor: Actor, op: string, input: object) => flow.execute(actor,op,{ ...input,idempotencyKey: randomUUID() }) as any;
  const workspace = invoke(human,'workspace_register',{ root: tmpdir(),name: 'Scope fixture',prefix: 'SCOPE' }).workspace;
  const run = (op: string,input: object,actor = human) => invoke(actor,op,{ workspaceId: workspace.id,...input });
  const root = run('issue_create',{ title: 'Scoped delivery',description: 'Deliver both approved criteria',criteria: ['A','B'] }).issue as Issue;
  const current = (id = root.id) => store.get<Issue>('issue',id);
  const change = (op: string,id: string,input: object = {},actor = human) => run(op,{ issueId: id,expectedVersion: current(id).version,...input },actor);
  change('design_set',root.id,{ content: 'Deliver and independently check A and B',criteria: ['A','B'] });
  change('design_submit',root.id);
  change('design_decide',root.id,{ designId: current().designId,decision: 'APPROVED',reason: 'Automated fixture only' });
  const pm = run('actor_enroll',{ role: 'pm',name: 'Fixture PM' }).actor as Actor;
  const worker = run('actor_enroll',{ role: 'worker',name: 'Fixture worker' }).actor as Actor;
  const create = (title: string,criteria: string[]) => run('issue_create',{ parentId: root.id,expectedParentVersion: current().version,title,description: `Implement ${title}`,criteria }).issue as Issue;
  const obsolete = create('[Feature] Old: deliver A -> output',['A']);
  const replacement = create('[Feature] New: deliver A -> output',['A']);
  const other = create('[Feature] B: deliver B -> output',['B']);
  change('issue_transition',obsolete.id,{ action: 'abandon',reason: 'Obsolete implementation route' });
  applyFixturePlan(flow,pm,root.id);
  const view = () => flow.execute(human,'scope_get',{ workspaceId: workspace.id,issueId: root.id,limit: 100 }) as any;
  const packet = (action = 'REPLACE',extra: object = {}) => {
    const data = view(); const target = data.children.find((v: any) => v.issue.id === obsolete.id);
    const next = data.children.find((v: any) => v.issue.id === replacement.id);
    return { workspaceId: workspace.id,issueId: obsolete.id,expectedVersion: target.issue.version,expectedParentVersion: data.issue.version,designId: data.design.id,expectedDecisionId: target.issue.scopeDecisionId ?? null,scopeHash: data.scopeHash,childScopeHash: target.scopeHash,action,replacements: action === 'REPLACE' ? [{ issueId: next.issue.id,expectedVersion: next.issue.version,scopeHash: next.scopeHash }] : [],reason: 'Automated human fixture scope decision',idempotencyKey: randomUUID(),...extra };
  };
  const decide = (action = 'REPLACE',extra: object = {}) => flow.execute(human,'scope_decide',packet(action,extra)) as any;
  return { store,flow,human,pm,worker,workspace,root,obsolete,replacement,other,current,change,create,view,packet,decide };
}
test('abandonment is unresolved until an exact human decision; MCP and grants cannot manufacture scope authority',() => {
  const f = fixture();
  assert.equal(planCoverage(f.store,f.current()).children.abandoned,1);
  assert.equal(planCoverage(f.store,f.current()).children.excluded,0);
  assert.equal(f.flow.readiness(f.current()).blocking.includes('CHILDREN_INCOMPLETE'),true);
  assert.equal(agentOperations.includes('scope_decide'),false);
  fails(() => f.flow.execute(f.pm,'scope_decide',f.packet()),'ROLE_DENIED');
  fails(() => f.flow.execute(f.worker,'scope_get',{ workspaceId: f.workspace.id,issueId: f.root.id }),'ROLE_DENIED');
  const decision = f.decide();
  assert.equal(decision.decision.actorId,f.human.id);
  assert.equal(f.current(f.obsolete.id).state,'ABANDONED');
  assert.deepEqual(decision.coverage.children,{ total: 3,inScope: 2,done: 0,abandoned: 0,excluded: 1,staleExclusions: 0 });
  assert.equal(decision.coverage.blocking.includes('PLAN_STALE'),true);
  fails(() => f.change('issue_transition',f.obsolete.id,{ action: 'reopen',reason: 'Try generic bypass' }),'SCOPE_RESTORE_REQUIRED');
  const grantScope = (f.flow.execute(f.human,'issue_get',{ workspaceId: f.workspace.id,issueId: f.obsolete.id }) as any).authorizationScopeHash;
  const grant = f.change('grant_create',f.obsolete.id,{ granteeId: f.pm.id,action: 'reopen',scopeHash: grantScope,expiresAt: new Date(Date.now()+60000).toISOString(),reason: 'Negative fixture: lifecycle authority cannot restore delivery scope' }).grant;
  fails(() => f.change('issue_transition',f.obsolete.id,{ action: 'reopen',reason: 'Delegated bypass attempt',grantId: grant.id },f.pm),'SCOPE_RESTORE_REQUIRED');
  assert.equal(f.store.get<any>('grant',grant.id).uses,0);
  applyFixturePlan(f.flow,f.pm,f.root.id);
  assert.equal(planCoverage(f.store,f.current()).ready,true);
});
test('scope decisions compare parent, target, replacement, scope hash and predecessor without partial writes',() => {
  const f = fixture(); const cases = [
    ['VERSION_CONFLICT',{ expectedParentVersion: 1 }],
    ['VERSION_CONFLICT',{ expectedVersion: 1 }],
    ['SCOPE_CONTEXT_STALE',{ scopeHash: 'changed' }],
    ['SCOPE_CONTEXT_STALE',{ childScopeHash: 'changed' }],
    ['SCOPE_CONTEXT_STALE',{ expectedDecisionId: 'other' }],
    ['APPROVAL_STALE',{ designId: 'other' }],
    ['VERSION_CONFLICT',{ replacements: [{ issueId: f.replacement.id,expectedVersion: 999,scopeHash: 'changed' }] }],
    ['SCOPE_CONTEXT_STALE',{ replacements: [{ issueId: f.replacement.id,expectedVersion: f.current(f.replacement.id).version,scopeHash: 'changed' }] }]
  ] as const;
  const before = f.current();
  for (const [code,extra] of cases) fails(() => f.decide('REPLACE',extra),code);
  assert.deepEqual(f.current(),before);
  assert.equal(f.store.list('scope_decision').length,0);
  const packet = f.packet(); const result = f.flow.execute(f.human,'scope_decide',packet) as any;
  assert.equal((f.flow.execute(f.human,'scope_decide',packet) as any).replayed,true);
  assert.equal(f.store.list('scope_decision').length,1);
  assert.equal(f.current().version,before.version+1);
  assert.equal(result.decision.target.title,f.current(f.obsolete.id).title);
  assert.equal((f.flow.execute(f.human,'evidence_get',{ workspaceId: f.workspace.id,issueId: f.obsolete.id,kind: 'scope_decision',evidenceId: result.decision.id }) as any).evidence.hash,result.decision.hash);
});
test('exclusion does not waive criteria and an all-excluded aggregate cannot become ready',() => {
  const f = fixture();
  f.change('issue_update',f.replacement.id,{ criteria: ['B'] });
  fails(() => f.decide(),'REPLACEMENT_COVERAGE_REQUIRED');
  f.decide('EXCLUDE');
  let coverage = planCoverage(f.store,f.current());
  assert.equal(coverage.blocking.includes('PLAN_CRITERIA_UNMAPPED'),true);
  for (const child of [f.replacement,f.other]) {
    f.change('issue_transition',child.id,{ action: 'abandon',reason: 'Automated all-excluded negative fixture' });
    const view = f.view(); const target = view.children.find((v: any) => v.issue.id === child.id);
    f.flow.execute(f.human,'scope_decide',{ ...f.packet('EXCLUDE'),issueId: child.id,expectedVersion: target.issue.version,expectedDecisionId: null,childScopeHash: target.scopeHash });
  }
  coverage = planCoverage(f.store,f.current());
  assert.equal(coverage.children.inScope,0);
  assert.equal(coverage.children.done,0);
  assert.equal(coverage.blocking.includes('DELIVERY_SCOPE_REQUIRED'),true);
});
test('replacement scope changes stale exclusion; metadata does not; restoring retains immutable history',() => {
  const f = fixture(); const first = f.decide().decision as ScopeDecision;
  f.change('issue_update',f.replacement.id,{ title: '[Feature] Renamed: deliver A -> observable output',plannedStart: '2026-11-09',estimate: { value: 3,unit: 'hours',confidence: 'low' } });
  assert.equal(scopeState(f.store,f.current(f.obsolete.id)).status,'EXCLUDED');
  f.change('issue_update',f.replacement.id,{ description: 'Changed actual replacement scope' });
  assert.equal(scopeState(f.store,f.current(f.obsolete.id)).status,'STALE');
  assert.equal(planCoverage(f.store,f.current()).children.staleExclusions,1);
  fails(() => applyFixturePlan(f.flow,f.pm,f.root.id),'PLAN_NOT_READY');
  const restored = f.decide('RESTORE',{ reopenChild: true });
  assert.equal(restored.decision.previousDecisionId,first.id);
  assert.equal(f.current(f.obsolete.id).state,'NOT_STARTED');
  assert.equal(scopeState(f.store,f.current(f.obsolete.id)).status,'INCLUDED');
  assert.deepEqual(f.store.get('scope_decision',first.id),first);
  assert.equal(f.store.list('scope_decision').length,2);
});
test('closed-parent scope changes need explicit reopen and retain holds without disturbing unrelated children',() => {
  const f = fixture(); f.decide();
  const before = f.current(f.other.id);
  const terminal = f.current(); terminal.state = 'DONE'; terminal.acceptedDigest = 'seeded-terminal-precondition';
  f.store.put('issue',terminal,terminal.workspaceId);
  fails(() => f.decide('RESTORE',{ reopenChild: true }),'PARENT_REOPEN_REQUIRED');
  f.decide('RESTORE',{ reopenParent: true,reopenChild: true });
  assert.equal(f.current().state,'IN_PROGRESS');
  assert.equal(f.current().acceptedDigest,undefined);
  assert.deepEqual(f.current(f.other.id),before);
  f.change('issue_transition',f.obsolete.id,{ action: 'abandon',reason: 'Fixture repeated scope review' });
  f.change('issue_transition',f.root.id,{ action: 'hold',reason: 'Human fixture hold' });
  f.decide(); assert.equal(f.current().state,'ON_HOLD');
  assert.equal(f.current().savedState?.state,'NOT_STARTED');
});
test('live and uncertain target/parent runs block scope mutation; cross-parent replacements and unresolved dependencies stay blocked',() => {
  const f = fixture();
  for (const issueId of [f.root.id,f.obsolete.id]) {
    const run: Run = { id: randomUUID(),issueId,workspaceId: f.workspace.id,actorId: f.worker.id,harness: 'codex',state: 'UNCERTAIN',version: 1,createdAt: new Date().toISOString(),designId: f.current().designId!,scopeRevision: 1 };
    f.store.put('run',run,f.workspace.id);
    fails(() => f.decide(),'RUN_EXISTS');
    run.state = 'CANCELLED'; f.store.put('run',run,f.workspace.id);
  }
  f.decide();
  f.change('dependency_set',f.other.id,{ dependsOn: [f.obsolete.id] });
  assert.equal(f.flow.readiness(f.current(f.other.id)).blocking.includes('DEPENDENCY_BLOCKED'),true);
  const foreign = { ...f.current(f.replacement.id),id: randomUUID(),parentId: null };
  f.store.put('issue',foreign,f.workspace.id);
  fails(() => f.decide('REPLACE',{ replacements: [{ issueId: foreign.id,expectedVersion: foreign.version,scopeHash: 'wrong' }] }),'REPLACEMENT_INVALID');
});
