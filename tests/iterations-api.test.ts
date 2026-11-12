import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Actor, DomainError, Issue, Run, agentOperations } from '../src/contracts.js';
import { Iteration, MembershipPrecondition } from '../src/iteration-contracts.js';
import { Store, canonical, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { createServer } from '../src/http.js';
import { bindFixtureImplementation } from './fixtures.js';
import { acceptanceDigest } from '../src/qa-policy.js';
import { Coordinator } from '../src/runner.js';
import { AdapterContext, AdapterResult, ExecutionAdapter } from '../src/adapters.js';
import { LocalClient } from '../src/client.js';

const rejects = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'iterations-api-')); const source = join(directory,'source'); mkdirSync(source);
  const store = new Store(':memory:'); let now = Date.parse('2026-11-12T12:00:00Z'); const flow = new Workflow(store, () => now);
  const { actor: human, token } = store.bootstrap();
  const execute = (actor: Actor, op: string, input: object) => flow.execute(actor,op,input) as any;
  const workspace = execute(human,'workspace_register',{ root: source,name: 'Iteration API fixture',prefix: 'ITA',idempotencyKey: randomUUID() }).workspace;
  const readOps = new Set(['iteration_list','iteration_get','issue_get','gap_list','plan_get']);
  const cmd = (op: string,input: any = {},actor = human) => execute(actor,op,{ workspaceId: workspace.id,...(readOps.has(op) ? {} : { idempotencyKey: randomUUID() }),...input });
  const enroll = (role: 'lead' | 'pm' | 'worker' | 'qa') => cmd('actor_enroll',{ role,name: `Automated ${role}` });
  const pm = enroll('pm'); const lead = enroll('lead'); const worker = enroll('worker'); const qa = enroll('qa');
  const current = (id: string) => store.get<Issue>('issue',id);
  const iteration = (id: string) => store.get<Iteration>('iteration',id);
  const snapshot = (id: string): MembershipPrecondition => { const i = iteration(id); return { iterationId: id,expectedVersion: i.version,membershipRevision: i.membershipRevision,membershipHash: i.membershipHash }; };
  const create = (input: object = {}) => cmd('iteration_create',{ name: 'Sprint fixture',goal: 'Fixture advisory goal',startDate: '2026-11-01',endDate: '2026-11-10',timeZone: 'UTC',reason: 'Automated fixture planning only',...input }).iteration as Iteration;
  const issue = (parentId?: string) => cmd('issue_create',{ title: parentId ? '[Feature] API: preserve authority -> explicit planning' : 'Iteration workflow fixture',description: 'Automated source fixture',criteria: ['C1'],artifactMode: parentId ? undefined : 'artifact',artifactReason: parentId ? undefined : 'Automated fixture artifacts',...(parentId ? { parentId,expectedParentVersion: current(parentId).version } : {}) }).issue as Issue;
  const change = (op: string,id: string,input: object = {},actor = human) => cmd(op,{ issueId: id,expectedVersion: current(id).version,...input },actor);
  const move = (ids: string[],target: string | null,input: object = {},actor = human) => {
    const iterations = new Set(ids.flatMap(id => [current(id).iterationId,target].filter((id): id is string => !!id)));
    return cmd('iteration_membership_set',{ changes: ids.map(id => ({ issueId: id,expectedVersion: current(id).version,iterationId: target })),memberships: [...iterations].map(snapshot),reason: 'Automated explicit move',...input },actor);
  };
  const close = (id: string,dispositions?: { issueId: string; iterationId: string | null }[]) => {
    const members = store.list<Issue>('issue',workspace.id).filter(i => i.iterationId === id);
    const moves = dispositions ?? members.filter(i => !['DONE','ABANDONED'].includes(i.state)).map(i => ({ issueId: i.id,iterationId: null }));
    return { workspaceId: workspace.id,...snapshot(id),members: members.map(i => ({ issueId: i.id,expectedVersion: i.version })),dispositions: moves,destinations: [...new Set(moves.flatMap(m => m.iterationId ? [m.iterationId] : []))].map(snapshot),reason: 'Automated explicit close',idempotencyKey: randomUUID() };
  };
  const db = () => canonical(['records','events','receipts'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  t.after(() => { store.close(); assert.equal(dirname(resolve(directory)),resolve(tmpdir())); assert.ok(basename(directory).startsWith('iterations-api-')); rmSync(directory,{ recursive: true,force: true }); });
  return { directory,source,store,flow,human,token,workspace,cmd,execute,enroll,pm,lead,worker,qa,current,iteration,snapshot,create,issue,change,move,close,db,setNow: (value: string) => { now = Date.parse(value); } };
}

test('Workflow iteration writes use shared receipts, conflict detection and complete transaction rollback', t => {
  const f = fixture(t); const one = f.issue(); const two = f.issue(); const first = f.create(); const second = f.create();
  const args = { changes: [{ issueId: one.id,expectedVersion: one.version,iterationId: first.id }],memberships: [f.snapshot(first.id)],reason: 'Explicit fixture move',idempotencyKey: randomUUID() };
  const saved = f.cmd('iteration_membership_set',args,f.pm.actor); const after = f.db();
  assert.equal(f.cmd('iteration_membership_set',args,f.pm.actor).replayed,true); assert.equal(f.db(),after); assert.equal(saved.issues[0].iterationId,first.id);
  assert.throws(() => f.cmd('iteration_membership_set',{ ...args,reason: 'Conflicting input' },f.pm.actor),rejects('IDEMPOTENCY_CONFLICT'));
  const before = f.db();
  assert.throws(() => f.cmd('iteration_membership_set',{ changes: [{ issueId: one.id,expectedVersion: f.current(one.id).version,iterationId: second.id },{ issueId: two.id,expectedVersion: two.version + 1,iterationId: second.id }],memberships: [f.snapshot(first.id),f.snapshot(second.id)],reason: 'All or nothing' }),rejects('VERSION_CONFLICT'));
  assert.equal(f.db(),before);
  assert.throws(() => f.change('issue_update',one.id,{ iterationId: second.id,memberships: [f.snapshot(second.id)],title: 'Must roll back title' }),rejects('ITERATION_MEMBERSHIP_REQUIRED'));
  assert.equal(f.db(),before);
});

test('all planners write while workers and QA cannot bypass planning authority', t => {
  const f = fixture(t); const iteration = f.create(); const issue = f.issue();
  for (const actor of [f.pm.actor,f.lead.actor]) f.cmd('iteration_update',{ iterationId: iteration.id,expectedVersion: f.iteration(iteration.id).version,name: `Updated by ${actor.role}`,reason: 'Explicit planning role fixture' },actor);
  for (const actor of [f.worker.actor,f.qa.actor]) {
    const before = f.db();
    for (const op of ['iteration_create','iteration_update','iteration_start','iteration_close','iteration_membership_set']) {
      const input = op === 'iteration_create' ? { name: 'Denied',goal: '',startDate: '2026-11-01',endDate: '2026-11-10',timeZone: 'UTC',reason: 'Denied' } : op === 'iteration_membership_set' ? { changes: [{ issueId: issue.id,expectedVersion: issue.version,iterationId: iteration.id }],memberships: [f.snapshot(iteration.id)],reason: 'Denied' } : op === 'iteration_close' ? f.close(iteration.id) : { iterationId: iteration.id,expectedVersion: f.iteration(iteration.id).version,reason: 'Denied' };
      assert.throws(() => f.cmd(op,input,actor),rejects('ROLE_DENIED'));
    }
    assert.throws(() => f.change('issue_update',issue.id,{ iterationId: iteration.id,memberships: [f.snapshot(iteration.id)] },actor),(error: any) => ['ROLE_DENIED','SCOPE_DENIED'].includes(error.code));
    assert.equal(f.db(),before);
  }
});

test('scoped read projections hide unassigned members, full set hashes, adoption and Markdown', t => {
  const f = fixture(t); const root = f.issue(); const mine = f.issue(root.id); const hidden = f.issue(root.id); const iteration = f.create();
  f.change('issue_assign',mine.id,{ actorId: f.worker.actor.id,harness: 'codex' }); f.move([mine.id,hidden.id],iteration.id);
  const result = f.cmd('iteration_get',{ iterationId: iteration.id,view: 'full' },f.worker.actor);
  assert.deepEqual(result.members.map((i: any) => i.id),[mine.id]); assert.equal(result.total,1); assert.equal(result.iteration.partial,true);
  for (const key of ['version','membershipRevision','membershipHash','summaryId']) assert.equal(Object.hasOwn(result.iteration,key),false);
  assert.equal(Object.hasOwn(result,'summary'),false); assert.equal(Object.hasOwn(result,'representedRequirements'),false);
  assert.equal(result.progress.partial,true); assert.equal(result.progress.runCapacity.workspaceActiveRuns,null);
  assert.throws(() => f.cmd('iteration_get',{ iterationId: iteration.id,legacyLabel: 'Secret' },f.worker.actor),rejects('ROLE_DENIED'));
  assert.throws(() => f.cmd('iteration_get',{ iterationId: iteration.id,view: 'markdown' },f.worker.actor),rejects('ROLE_DENIED'));
  assert.equal(f.cmd('iteration_list',{},f.qa.actor).total,0);
  const runId = randomUUID(); const actor = { ...f.worker.actor,id: randomUUID(),principalId: f.worker.actor.id,runId } as Actor;
  f.store.token(actor); f.store.put('run',{ id: runId,issueId: mine.id,workspaceId: f.workspace.id,actorId: f.worker.actor.id,state: 'RUNNING',kind: 'implementation',harness: 'codex',version: 1,createdAt: new Date().toISOString(),designId: 'fixture',scopeRevision: 1,executionActorId: actor.id } as Run,f.workspace.id);
  assert.deepEqual(f.cmd('iteration_get',{ iterationId: iteration.id },actor).members.map((i: any) => i.id),[mine.id]);
});

test('approved ready plans and human grants survive issue_update and plan_apply membership metadata', t => {
  const f = fixture(t); const root = f.issue();
  f.change('design_set',root.id,{ content: 'Automated fixture design',criteria: ['C1'] }); f.change('design_submit',root.id);
  f.change('design_decide',root.id,{ designId: f.current(root.id).designId,decision: 'APPROVED',reason: 'Automated fixture approval only' });
  const task = { ref: 'task',title: '[Feature] API: preserve artifact scope -> stable approvals',description: 'Own C1',criteria: ['C1'],dependencies: [],assigneeId: f.worker.actor.id,harness: 'codex' };
  const apply = (tasks: object[],extra: object = {}) => f.change('plan_apply',root.id,{ expectedPlanId: f.current(root.id).planId ?? null,designId: f.current(root.id).designId,mode: 'READY',tasks,integrationCriteria: [],reason: 'Explicit fixture plan',...extra },f.pm.actor);
  const initial = apply([task]); const childId = initial.taskIds.task; const iteration = f.create();
  const hash = f.cmd('issue_get',{ issueId: childId }).authorizationScopeHash;
  const grant = f.change('grant_create',childId,{ granteeId: f.pm.actor.id,action: 'hold',scopeHash: hash,expiresAt: '2026-11-13T12:00:00Z',reason: 'Automated fixture authorization' }).grant;
  const originalDesign = canonical(f.store.get('design',f.current(root.id).designId!));
  f.change('issue_update',childId,{ iterationId: iteration.id,memberships: [f.snapshot(iteration.id)] },f.pm.actor);
  assert.equal(f.cmd('issue_get',{ issueId: childId }).authorizationScopeHash,hash); assert.equal(canonical(f.store.get('design',f.current(root.id).designId!)),originalDesign);
  assert.equal(f.cmd('plan_get',{ issueId: root.id }).coverage.ready,true);
  f.change('issue_update',childId,{ dueDate: '2026-11-14',estimate: { value: 2,unit: 'hours',confidence: 'low' } },f.pm.actor);
  assert.equal(f.current(childId).iterationId,iteration.id);
  apply([{ ...task,issueId: childId,expectedVersion: f.current(childId).version,plannedStart: '2026-11-12' }]);
  assert.equal(f.current(childId).iterationId,iteration.id);
  assert.equal(f.cmd('plan_get',{ issueId: root.id }).coverage.ready,true);
  const child = f.current(childId);
  apply([{ ...task,issueId: childId,expectedVersion: child.version,iterationId: null }],{ memberships: [f.snapshot(iteration.id)] });
  assert.equal(f.current(childId).iterationId,null); assert.equal(f.cmd('plan_get',{ issueId: root.id }).coverage.ready,true);
  assert.equal(f.cmd('issue_get',{ issueId: childId }).authorizationScopeHash,hash); assert.equal(canonical(f.store.get('grant',grant.id)),canonical(JSON.parse(JSON.stringify(grant))));
  f.change('issue_transition',childId,{ action: 'hold',grantId: grant.id,reason: 'Use unchanged exact scope authorization' },f.pm.actor);
  assert.equal(f.current(childId).state,'ON_HOLD');
});

test('plan_apply batches all membership changes once and failed destination CAS rolls back newly created tasks and plan', t => {
  const f = fixture(t); const root = f.issue(); const iteration = f.create(); const input = { expectedPlanId: null,designId: null,mode: 'DRAFT',tasks: ['a','b'].map(ref => ({ ref,title: `[Feature] ${ref}: plan scope -> explicit output`,description: 'Fixture task',criteria: ['C1'],dependencies: [],iterationId: iteration.id })),reason: 'Atomic fixture plan',memberships: [f.snapshot(iteration.id)] };
  const stale = { ...input,memberships: [{ ...f.snapshot(iteration.id),membershipHash: 'a'.repeat(64) }] }; const before = f.db();
  assert.throws(() => f.change('plan_apply',root.id,stale),rejects('ITERATION_MEMBERSHIP_STALE')); assert.equal(f.db(),before);
  const saved = f.change('plan_apply',root.id,input); assert.equal(f.iteration(iteration.id).membershipRevision,1);
  assert.equal(f.cmd('iteration_get',{ iterationId: iteration.id }).total,2); assert.equal(Object.keys(saved.taskIds).length,2);
});

test('legacy labels remain read-only, old fields name iterationId, and adoption rejects a newly eligible match atomically', t => {
  const f = fixture(t); const first = f.issue(); const iteration = f.create(); const stored = f.current(first.id); stored.iteration = 'Legacy sprint'; f.store.put('issue',stored,f.workspace.id);
  const view = f.cmd('issue_get',{ issueId: first.id }).issue; assert.equal(view.legacyIterationLabel,'Legacy sprint'); assert.equal(view.iterationId,null); assert.equal(Object.hasOwn(view,'iteration'),false); assert.equal(f.current(first.id).iteration,'Legacy sprint');
  for (const field of ['iteration','legacyIterationLabel']) assert.throws(() => f.change('issue_update',first.id,{ [field]: null }),(error: any) => error.code === 'ITERATION_FIELD_RETIRED' && error.message.includes('iterationId'));
  assert.throws(() => f.change('plan_apply',first.id,{ expectedPlanId: null,designId: null,mode: 'DRAFT',tasks: [{ ref: 'a',title: '[Feature] Scope: preserve labels -> reject old writes',iteration: null }],reason: 'Old plan write' }),rejects('ITERATION_FIELD_RETIRED'));
  const preview = f.cmd('iteration_list',{ legacyLabel: 'Legacy sprint' }).adoption;
  const second = f.issue(); const addition = f.current(second.id); addition.iteration = 'Legacy sprint'; f.store.put('issue',addition,f.workspace.id);
  const args = { changes: preview.matches.map((m: any) => ({ ...m,iterationId: iteration.id })),memberships: [f.snapshot(iteration.id)],adoption: preview,reason: 'Stale adoption fixture' }; const before = f.db();
  assert.throws(() => f.cmd('iteration_membership_set',args),rejects('ITERATION_ADOPTION_STALE')); assert.equal(f.db(),before);
  const latest = f.cmd('iteration_list',{ legacyLabel: 'Legacy sprint' }).adoption; f.cmd('iteration_membership_set',{ ...args,changes: latest.matches.map((m: any) => ({ ...m,iterationId: iteration.id })),adoption: latest });
  assert.equal(f.current(first.id).iteration,'Legacy sprint'); assert.equal(f.current(second.id).iterationId,iteration.id);
});

test('close races bind complete membership and destination sets, preserve receipts, then retain immutable history through authorized reopen', t => {
  const f = fixture(t); const source = f.create(); const destination = f.create({ name: 'Carry target' }); const first = f.issue(); const second = f.issue(); f.move([first.id,second.id],source.id);
  const stale = f.close(source.id,[{ issueId: first.id,iterationId: destination.id },{ issueId: second.id,iterationId: null }]);
  const third = f.issue(); f.move([third.id],destination.id); const before = f.db();
  assert.throws(() => f.cmd('iteration_close',stale),rejects('VERSION_CONFLICT')); assert.equal(f.db(),before);
  f.change('issue_transition',second.id,{ action: 'abandon',reason: 'Automated terminal member fixture' });
  const result = f.cmd('iteration_close',f.close(source.id,[{ issueId: first.id,iterationId: destination.id }]));
  assert.equal(f.current(first.id).iterationId,destination.id); assert.equal(f.current(second.id).iterationId,null); assert.equal(f.current(first.id).state,'NOT_STARTED');
  const history = canonical(result.summary); const membership = canonical(f.store.list<any>('iteration_membership').filter(m => m.iterationId === source.id));
  f.change('issue_transition',second.id,{ action: 'reopen',reason: 'Automated authorized reopen' });
  assert.equal(f.current(second.id).iterationId,null); assert.equal(f.current(second.id).state,'NOT_STARTED');
  assert.equal(canonical(f.cmd('iteration_get',{ iterationId: source.id,view: 'full' }).summary),history);
  assert.equal(canonical(f.store.list<any>('iteration_membership').filter(m => m.iterationId === source.id)),membership);
  const markdown = f.cmd('iteration_get',{ iterationId: source.id,view: 'markdown' }); assert.equal(markdown.mediaType,'text/markdown'); assert.ok(markdown.content.includes(second.key));
});

test('active iteration overdue gaps and context remain advisory with no timer lifecycle mutation', t => {
  const f = fixture(t); const issue = f.issue(); const iteration = f.create(); f.move([issue.id],iteration.id);
  const before = f.current(issue.id); f.cmd('iteration_start',{ iterationId: iteration.id,expectedVersion: f.iteration(iteration.id).version,reason: 'Explicit start' });
  assert.deepEqual(f.current(issue.id),before);
  const read = f.cmd('issue_get',{ issueId: issue.id }); assert.equal(read.iteration.advisory,true); assert.equal(read.iteration.name,iteration.name);
  const state = f.db(); f.setNow('2026-12-01T00:00:00Z'); const gaps = f.cmd('gap_list').gaps.filter((g: any) => g.code === 'ITERATION_OVERDUE');
  assert.equal(gaps.length,1); assert.equal(gaps[0].severity,'advisory'); assert.equal(f.db(),state); assert.equal(f.iteration(iteration.id).state,'ACTIVE');
  assert.equal(read.readiness.blocking.some((code: string) => code.startsWith('ITERATION')),false);
});

test('HTTP and real MCP enforce iteration roles and publish correct read-only annotations', async t => {
  const f = fixture(t); const server = createServer(f.store); await server.listen({ host: '127.0.0.1',port: 0 }); const address = server.server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`; const input = { workspaceId: f.workspace.id,name: 'Transport fixture',goal: 'Fixture planning',startDate: '2026-11-01',endDate: '2026-11-10',timeZone: 'UTC',reason: 'Automated transport fixture',idempotencyKey: randomUUID() };
  const client = new Client({ name: 'iteration-source-fixture',version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,args: [resolve('dist/cli.js'),'mcp'],env: { ...process.env,AGILEDEV_ENDPOINT: endpoint,AGILEDEV_TOKEN: f.pm.token } as Record<string,string>,stderr: 'pipe' });
  try {
    const denied = await server.inject({ method: 'POST',url: '/api/command/iteration_create',headers: { host: `127.0.0.1:${address.port}`,authorization: `Bearer ${f.worker.token}` },payload: input }); assert.equal(denied.statusCode,403); assert.equal(denied.json().error.code,'ROLE_DENIED');
    const saved = await server.inject({ method: 'POST',url: '/api/command/iteration_create',headers: { host: `127.0.0.1:${address.port}`,authorization: `Bearer ${f.pm.token}` },payload: input }); assert.equal(saved.statusCode,200); const iteration = saved.json().result.iteration;
    const replay = await server.inject({ method: 'POST',url: '/api/command/iteration_create',headers: { host: `127.0.0.1:${address.port}`,authorization: `Bearer ${f.pm.token}` },payload: input }); assert.equal(replay.json().result.replayed,true);
    await client.connect(transport); const tools = (await client.listTools()).tools;
    for (const op of ['iteration_create','iteration_update','iteration_start','iteration_close','iteration_membership_set','iteration_list','iteration_get']) { const tool = tools.find(tool => tool.name === op); assert.ok(tool); assert.equal((agentOperations as string[]).includes(op),true); assert.equal(tool.annotations?.readOnlyHint,['iteration_list','iteration_get'].includes(op)); }
    const oldWrite = await client.callTool({ name: 'issue_update',arguments: { workspaceId: f.workspace.id,issueId: 'fixture',expectedVersion: 1,idempotencyKey: randomUUID(),iteration: 'old field' } });
    assert.equal(oldWrite.isError,true); assert.ok(JSON.stringify(oldWrite).includes('iterationId'));
    const result = await client.callTool({ name: 'iteration_get',arguments: { workspaceId: f.workspace.id,iterationId: iteration.id } }); assert.equal(result.isError,undefined); assert.equal((result.structuredContent as any).iteration.id,iteration.id);
    const started = await client.callTool({ name: 'iteration_start',arguments: { workspaceId: f.workspace.id,iterationId: iteration.id,expectedVersion: iteration.version,idempotencyKey: randomUUID(),reason: 'Explicit fixture MCP start' } }); assert.equal(started.isError,undefined); assert.equal(f.iteration(iteration.id).state,'ACTIVE');
  } finally { await client.close(); await server.close(); }
});

test('membership metadata preserves a real managed execution lease and admitted scope through claim and heartbeat', t => {
  const f = fixture(t); const issue = f.issue(); const first = f.create(); const second = f.create();
  f.change('design_set',issue.id,{ content: 'Controlled provider fixture',criteria: ['C1'] }); f.change('design_submit',issue.id);
  f.change('design_decide',issue.id,{ designId: f.current(issue.id).designId,decision: 'APPROVED',reason: 'Automated design fixture only' });
  f.change('issue_assign',issue.id,{ actorId: f.worker.actor.id,harness: 'codex' });
  const execution = bindFixtureImplementation(f.flow,f.pm.actor,f.worker.actor,issue.id); t.after(() => execution.dispose());
  f.change('work_claim',issue.id,{ designId: f.current(issue.id).designId,scopeRevision: f.current(issue.id).scopeRevision },execution.actor); execution.activate();
  const before = f.current(issue.id); const runBefore = canonical(f.store.get('run',execution.runId));
  f.change('issue_update',issue.id,{ iterationId: first.id,memberships: [f.snapshot(first.id)] },f.pm.actor);
  const after = f.current(issue.id); assert.deepEqual(after.lease,before.lease); assert.equal(after.fence,before.fence); assert.equal(after.scopeRevision,before.scopeRevision); assert.equal(after.state,'IN_PROGRESS'); assert.equal(canonical(f.store.get('run',execution.runId)),runBefore);
  f.move([issue.id],second.id,{},f.lead.actor); f.change('work_heartbeat',issue.id,{ fence: f.current(issue.id).fence },execution.actor);
  assert.equal(f.current(issue.id).iterationId,second.id); assert.equal(f.current(issue.id).state,'IN_PROGRESS'); assert.ok(!f.flow.readiness(f.current(issue.id)).blocking.some(code => code.startsWith('ITERATION')));
});

test('reviewed delivery digest, report, reviews and saved acceptance survive all metadata membership paths', t => {
  const f = fixture(t); const issue = f.issue(); const first = f.create(); const second = f.create();
  f.change('design_set',issue.id,{ content: 'Controlled evidence fixture only',criteria: ['C1'] }); f.change('design_submit',issue.id);
  f.change('design_decide',issue.id,{ designId: f.current(issue.id).designId,decision: 'APPROVED',reason: 'Automated fixture approval' });
  const root = join(f.directory,'sealed-fixture'); mkdirSync(root); writeFileSync(join(root,'artifact.txt'),'Controlled artifact fixture\n');
  const runId = randomUUID(); const actor = { ...f.worker.actor,id: randomUUID(),principalId: f.worker.actor.id,runId,sessionId: randomUUID() } as Actor; f.store.token(actor);
  f.store.put('run',{ id: runId,issueId: issue.id,workspaceId: f.workspace.id,actorId: f.worker.actor.id,state: 'SUCCEEDED',kind: 'implementation',executionActorId: actor.id,executionRoot: root,providerSessionId: 'controlled-fixture-provider',harness: 'codex',version: 1,createdAt: new Date().toISOString(),designId: f.current(issue.id).designId,scopeRevision: 1 },f.workspace.id);
  const files = [{ path: 'artifact.txt',hash: hash('Controlled artifact fixture\n'),bytes: Buffer.byteLength('Controlled artifact fixture\n'),mode: '100644' }];
  const snapshotId = randomUUID(); const candidate = { id: randomUUID(),workerId: actor.id,sessionId: actor.sessionId,designId: f.current(issue.id).designId!,files: files.map(({ path,hash }) => ({ path,hash })),hash: hash(canonical(files)),summary: 'Source evidence fixture, not a native model run',executionRoot: root,runId,snapshotId,digestPolicy: 4 as const };
  f.store.put('snapshot',{ id: snapshotId,workspaceId: f.workspace.id,issueId: issue.id,candidateId: candidate.id,root,files,hash: hash(canonical(files)),createdAt: new Date().toISOString() },f.workspace.id); f.store.put('candidate',candidate,f.workspace.id);
  const qaRunId = randomUUID(); const reportId = randomUUID(); f.store.put('run',{ id: qaRunId,issueId: issue.id,state: 'SUCCEEDED',kind: 'qa' },f.workspace.id); f.store.put('qa_report',{ id: reportId,issueId: issue.id,runId: qaRunId,snapshotId,verdict: 'PASS',summary: 'Controlled evidence setup, not real independent QA' },f.workspace.id);
  const review = (stage: string) => { const id = randomUUID(); f.store.put('review',{ id,issueId: issue.id,candidateId: candidate.id,snapshotId,stage,verdict: 'PASS',...(stage === 'QA' ? { reportId } : {}) },f.workspace.id); return id; };
  const ready = f.current(issue.id); ready.candidate = candidate; ready.initialReview = review('PRE_QA'); ready.qaReview = review('QA'); ready.finalReview = review('FINAL'); ready.state = 'USER_ACCEPTANCE'; ready.acceptedDigest = acceptanceDigest(f.store,ready); f.store.put('issue',ready,f.workspace.id);
  const digest = ready.acceptedDigest; const records = () => canonical(['review','qa_report','candidate','snapshot','design','run'].map(type => f.store.list(type)));
  const before = records(); f.change('issue_update',issue.id,{ iterationId: first.id,memberships: [f.snapshot(first.id)] },f.pm.actor); f.move([issue.id],second.id); f.cmd('iteration_close',f.close(second.id));
  assert.equal(records(),before); assert.equal(acceptanceDigest(f.store,f.current(issue.id)),digest); assert.equal(f.current(issue.id).acceptedDigest,digest); assert.equal(f.current(issue.id).state,'USER_ACCEPTANCE'); assert.equal(f.current(issue.id).iterationId,null);
});

test('actual Workflow close detects concurrent source add/remove and member edits without partial results', t => {
  const f = fixture(t); const iteration = f.create(); const first = f.issue(); const second = f.issue(); f.move([first.id],iteration.id);
  const staleAdd = f.close(iteration.id); f.move([second.id],iteration.id); let before = f.db(); assert.throws(() => f.cmd('iteration_close',staleAdd),rejects('VERSION_CONFLICT')); assert.equal(f.db(),before);
  const staleRemove = f.close(iteration.id); f.move([second.id],null); before = f.db(); assert.throws(() => f.cmd('iteration_close',staleRemove),rejects('VERSION_CONFLICT')); assert.equal(f.db(),before);
  const staleMember = f.close(iteration.id); f.change('issue_update',first.id,{ dueDate: '2026-11-13' }); before = f.db(); assert.throws(() => f.cmd('iteration_close',staleMember),rejects('VERSION_CONFLICT')); assert.equal(f.db(),before);
  const saved = f.cmd('iteration_close',f.close(iteration.id)); assert.equal(saved.iteration.state,'CLOSED'); assert.equal(f.current(first.id).iterationId,null);
});

test('cross-workspace, terminal and closed membership requests reject at Workflow entry points', t => {
  const f = fixture(t); const issue = f.issue(); const source = join(f.directory,'other'); mkdirSync(source); const workspace = f.execute(f.human,'workspace_register',{ root: source,name: 'Other fixture',prefix: 'ITB',idempotencyKey: randomUUID() }).workspace;
  const foreign = f.cmd('iteration_create',{ workspaceId: workspace.id,name: 'Other iteration',goal: '',startDate: '2026-11-01',endDate: '2026-11-10',timeZone: 'UTC',reason: 'Fixture scope boundary' }).iteration;
  let before = f.db(); assert.throws(() => f.change('issue_update',issue.id,{ iterationId: foreign.id,memberships: [{ iterationId: foreign.id,expectedVersion: foreign.version,membershipRevision: 0,membershipHash: foreign.membershipHash }] }),rejects('SCOPE_DENIED')); assert.equal(f.db(),before);
  const iteration = f.create(); f.change('issue_transition',issue.id,{ action: 'abandon',reason: 'Fixture terminal issue' }); before = f.db(); assert.throws(() => f.move([issue.id],iteration.id),rejects('ISSUE_CLOSED')); assert.equal(f.db(),before);
  f.change('issue_transition',issue.id,{ action: 'reopen',reason: 'Explicit fixture reopen' }); f.cmd('iteration_close',f.close(iteration.id)); before = f.db(); assert.throws(() => f.move([issue.id],iteration.id),rejects('ITERATION_CLOSED')); assert.equal(f.db(),before);
});


for (const mode of ['failed','no-submission','cancelled','held-cancelled','submitted-failed','submitted-held-cancelled','abandoned-cancelled','transfer-failed','uncertain-reconcile'] as const) {
  test(`real Coordinator flow records ${mode} without inventing historical state or gate advancement`, { timeout: 15000 }, async t => {
    const f = fixture(t); f.setNow(new Date().toISOString()); const issue = f.issue(); writeFileSync(join(f.source,'source.txt'),'Controlled run source fixture\n');
    f.change('design_set',issue.id,{ content: 'Controlled run fixture; not real project approval',criteria: ['C1'] }); f.change('design_submit',issue.id);
    f.change('design_decide',issue.id,{ designId: f.current(issue.id).designId,decision: 'APPROVED',reason: 'Automated fixture approval only' });
    f.change('issue_assign',issue.id,{ actorId: f.worker.actor.id,harness: 'codex' });
    const today = new Date().toISOString().slice(0,10); const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0,10);
    const iteration = f.create({ startDate: yesterday,endDate: today,timeZone: 'UTC' }); f.move([issue.id],iteration.id);
    const run = f.change('work_dispatch',issue.id,{ designId: f.current(issue.id).designId,scopeRevision: f.current(issue.id).scopeRevision }).run as Run;
    const contexts: AdapterContext[] = []; let finish!: (result: AdapterResult) => void;
    const adapter: ExecutionAdapter = { async start(context) { contexts.push(context); context.onProvider(`controlled-flow-fixture-${randomUUID()}`); return { result: new Promise<AdapterResult>(done => { finish = done; }),interrupt: async () => { finish({ outcome: 'cancelled',errorCode: 'CONTROLLED_STOP' }); return true; } }; } };
    const server = createServer(f.store); const endpoint = await server.listen({ host: '127.0.0.1',port: 0 });
    const coordinator = new Coordinator(f.store,{ endpoint,directory: join(f.directory,'runs'),bridgeScript: resolve('dist/cli.js'),adapter });
    const until = async (predicate: () => boolean) => { const deadline = Date.now() + 10000; while (!predicate()) { assert.ok(Date.now() < deadline,'Controlled Coordinator did not reach its expected state'); await new Promise(done => setTimeout(done,10)); } };
    const flow = (id = iteration.id,actor = f.human) => f.cmd('iteration_get',{ iterationId: id,view: 'flow' },actor);
    try {
      await coordinator.start(); await until(() => contexts.length === 1 && f.current(issue.id).state === 'IN_PROGRESS');
      assert.equal(flow().points.at(-1).counts.IN_PROGRESS,1);
      const context = contexts[0]!;
      if (mode.startsWith('submitted-')) {
        writeFileSync(join(context.cwd,'delivery.txt'),'Controlled submitted fixture\n');
        const current = f.current(issue.id); await new LocalClient(endpoint,context.token).command('work_submit',{ workspaceId: f.workspace.id,issueId: issue.id,expectedVersion: current.version,fence: current.fence,summary: 'Controlled source fixture, not a native model run',files: ['delivery.txt'],idempotencyKey: randomUUID() });
        assert.equal(f.current(issue.id).state,'LEAD_REVIEW'); assert.ok(f.current(issue.id).candidate);
      }
      let destination: Iteration | null = null;
      if (mode === 'transfer-failed') {
        destination = f.create({ name: 'Transfer target',startDate: yesterday,endDate: today,timeZone: 'UTC' });
        const hidden = f.issue(); f.move([issue.id,hidden.id],destination.id);
      }
      if (mode.includes('held')) f.change('issue_transition',issue.id,{ action: 'hold',reason: 'Explicit fixture hold before controlled stop' });
      if (mode === 'abandoned-cancelled') f.change('issue_transition',issue.id,{ action: 'abandon',reason: 'Explicit fixture abandonment before controlled stop' });
      if (mode.includes('cancelled')) {
        const currentRun = f.store.get<Run>('run',run.id); f.cmd('run_interrupt',{ runId: run.id,expectedVersion: currentRun.version,reason: 'Explicit controlled stop, not a timer gate transition' }); await coordinator.tick();
      } else finish({ outcome: mode === 'no-submission' ? 'succeeded' : mode === 'uncertain-reconcile' ? 'uncertain' : 'failed',errorCode: 'CONTROLLED_FLOW_FIXTURE' });
      await until(() => ['FAILED','CANCELLED','UNCERTAIN'].includes(f.store.get<Run>('run',run.id).state));
      if (mode === 'uncertain-reconcile') {
        assert.equal(f.current(issue.id).state,'IN_PROGRESS'); assert.equal(flow().points.at(-1).counts.IN_PROGRESS,1);
        const currentRun = f.store.get<Run>('run',run.id); f.cmd('run_reconcile',{ runId: run.id,expectedVersion: currentRun.version,confirmStopped: true,reason: 'Controlled adapter owns no OS process; explicit automated fixture stop confirmation' });
      }
      const expected = mode.includes('held') ? 'ON_HOLD' : mode === 'abandoned-cancelled' ? 'ABANDONED' : 'NOT_STARTED';
      assert.equal(f.current(issue.id).state,expected); assert.equal(f.current(issue.id).candidate,null); assert.equal(f.current(issue.id).acceptedDigest,undefined); assert.equal(f.store.list('delivery_approval').length,0);
      if (mode.includes('held')) assert.equal(f.current(issue.id).savedState?.state,mode.startsWith('submitted-') ? 'NOT_STARTED' : 'IN_PROGRESS');
      const before = f.db(); const points = flow(destination?.id).points; const last = points.at(-1);
      assert.equal(last.counts[expected],destination ? 2 : 1); assert.equal(last.counts.IN_PROGRESS,0); assert.equal(last.counts.LEAD_REVIEW,0); assert.equal(last.counts.DONE,0); assert.equal(f.db(),before);
      if (destination) {
        assert.equal(Object.values(flow().points.at(-1).counts).reduce((sum: any,value: any) => sum + value,0),0);
        const scoped = flow(destination.id,f.worker.actor); assert.equal(scoped.partial,true); assert.equal(scoped.points.at(-1).counts.NOT_STARTED,1); assert.equal(scoped.points.at(-1).counts.IN_PROGRESS,0);
      }
      if (mode === 'failed') {
        const ended = f.store.db.prepare("SELECT sequence FROM events WHERE target_id=? AND operation='run_finished'").get(run.id) as { sequence: number };
        f.store.db.prepare('UPDATE events SET at=? WHERE workspace_id=? AND sequence<?').run(`${yesterday}T12:00:00Z`,f.workspace.id,ended.sequence);
        f.store.db.prepare('UPDATE events SET at=? WHERE sequence=?').run(`${today}T12:00:00Z`,ended.sequence);
        for (const record of f.store.list<any>('iteration_membership',f.workspace.id)) { record.at = `${yesterday}T12:00:00Z`; f.store.put('iteration_membership',record,f.workspace.id); }
        const history = flow().points; assert.equal(history[0].counts.IN_PROGRESS,1); assert.equal(history[0].counts.NOT_STARTED,0); assert.equal(history.at(-1).counts.NOT_STARTED,1);
        const sourceRun = f.store.get<Run>('run',run.id); f.store.put('run',{ ...sourceRun,workspaceId: 'foreign-workspace' },f.workspace.id);
        assert.equal(flow().points.at(-1).counts.IN_PROGRESS,1); f.store.put('run',sourceRun,f.workspace.id);
        f.store.db.prepare('UPDATE events SET actor_id=? WHERE sequence=?').run(f.human.id,ended.sequence);
        assert.equal(flow().points.at(-1).counts.IN_PROGRESS,1);
      }
    } finally { await coordinator.close(); await server.close(); }
  });
}
