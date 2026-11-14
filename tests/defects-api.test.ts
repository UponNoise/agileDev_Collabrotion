import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Actor, DomainError, Issue, Run, agentOperations } from '../src/contracts.js';
import { DefectRecord } from '../src/defect-contracts.js';
import { Store, canonical, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { acceptanceDigest } from '../src/qa-policy.js';
import { createServer } from '../src/http.js';

const finding = { severity: 'MAJOR', criterionIds: ['C1'], reproduce: 'Run the fixture input', expected: 'The criterion holds', actual: 'The fixture differs' };
const fails = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(),'defects-api-')); const source = join(directory,'source'); mkdirSync(source);
  const store = new Store(':memory:'); const flow = new Workflow(store); const { actor: human,token } = store.bootstrap();
  const workspace = (flow.execute(human,'workspace_register',{ root: source,name: 'Automated defect API fixture',prefix: 'DFA',idempotencyKey: randomUUID() }) as any).workspace;
  const reads = new Set(['issue_get','defect_get','defect_list','gap_list','issue_list']);
  const cmd = (op: string,input: object = {},actor = human) => flow.execute(actor,op,{ workspaceId: workspace.id,...(reads.has(op) ? {} : { idempotencyKey: randomUUID() }),...input }) as any;
  const enroll = (role: 'lead' | 'pm' | 'worker' | 'qa') => cmd('actor_enroll',{ role,name: `Fixture ${role}` });
  const lead = enroll('lead'); const pm = enroll('pm'); const worker = enroll('worker'); const qa = enroll('qa');
  const current = (id: string) => store.get<Issue>('issue',id);
  const issue = (parentId?: string) => cmd('issue_create',{ title: parentId ? '[Test] Defect: capture actual problem -> explicit triage' : 'Defect API fixture',description: 'Automated fixture scope only',criteria: ['C1'],artifactMode: 'artifact',artifactReason: 'Automated artifact fixture',...(parentId ? { parentId,expectedParentVersion: current(parentId).version } : {}) }).issue as Issue;
  const change = (op: string,id: string,input: object = {},actor = human) => cmd(op,{ issueId: id,expectedVersion: current(id).version,...input },actor);
  const db = () => canonical(['records','events','receipts'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const observation = (id: string) => cmd('issue_get',{ issueId: id }).defects.observation;
  const propose = (id: string,actor = lead.actor,input: object = {}) => change('defect_propose',id,{ ...finding,...input },actor).defect as DefectRecord;
  const report = (id: string) => change('defect_report',id,{ ...finding,observation: observation(id) }).defect as DefectRecord;
  const triage = (record: DefectRecord,action: string,input: object = {},actor = human) => cmd('defect_triage',{ defectId: record.id,expectedVersion: record.version,expectedIssueVersion: current(record.issueId).version,action,reason: 'Explicit automated human fixture decision',...input },actor);
  const reviewed = (id: string) => {
    change('design_set',id,{ content: 'Automated fixture design, not real user approval',criteria: ['C1'] }); change('design_submit',id);
    change('design_decide',id,{ designId: current(id).designId,decision: 'APPROVED',reason: 'Automated human fixture approval' });
    change('issue_assign',id,{ actorId: worker.actor.id,harness: 'codex' });
    const root = join(directory,randomUUID()); mkdirSync(root); const content = 'Automated sealed artifact fixture\n'; writeFileSync(join(root,'artifact.txt'),content);
    const files = [{ path: 'artifact.txt',hash: hash(content),bytes: Buffer.byteLength(content),mode: '100644' }];
    const runId = randomUUID(); const execution = { ...worker.actor,id: randomUUID(),principalId: worker.actor.id,runId,sessionId: randomUUID() } as Actor; store.token(execution);
    store.put('run',{ id: runId,workspaceId: workspace.id,issueId: id,actorId: worker.actor.id,executionActorId: execution.id,executionRoot: root,state: 'SUCCEEDED',kind: 'implementation',harness: 'codex',version: 1,createdAt: new Date().toISOString(),providerSessionId: 'synthetic-provider-no-model-run',designId: current(id).designId,scopeRevision: current(id).scopeRevision } as Run,workspace.id);
    const snapshotId = randomUUID(); const candidate = { id: randomUUID(),workerId: execution.id,sessionId: execution.sessionId,designId: current(id).designId!,files: files.map(({ path,hash }) => ({ path,hash })),hash: hash(canonical(files)),summary: 'Seeded artifact evidence, not independent native QA',executionRoot: root,runId,snapshotId,digestPolicy: 4 as const };
    store.put('snapshot',{ id: snapshotId,workspaceId: workspace.id,issueId: id,candidateId: candidate.id,root,files,hash: candidate.hash,createdAt: new Date().toISOString() },workspace.id); store.put('candidate',candidate,workspace.id);
    const qaRunId = randomUUID(); const reportId = randomUUID(); store.put('run',{ id: qaRunId,workspaceId: workspace.id,issueId: id,state: 'SUCCEEDED',kind: 'qa' },workspace.id);
    store.put('qa_report',{ id: reportId,workspaceId: workspace.id,issueId: id,runId: qaRunId,snapshotId,verdict: 'PASS',summary: 'Seeded evidence, not actual independent QA' },workspace.id);
    const review = (stage: string) => { const reviewId = randomUUID(); store.put('review',{ id: reviewId,issueId: id,candidateId: candidate.id,snapshotId,stage,verdict: 'PASS',...(stage === 'QA' ? { reportId } : {}) },workspace.id); return reviewId; };
    const value = current(id); value.candidate = candidate; value.initialReview = review('PRE_QA'); value.qaReview = review('QA'); value.finalReview = review('FINAL'); value.state = 'USER_ACCEPTANCE'; store.put('issue',value,workspace.id);
    return { candidateId: candidate.id,digest: acceptanceDigest(store,value) };
  };
  const decide = (id: string,input: object = {}) => change('delivery_decide',id,{ candidateId: current(id).candidate!.id,digest: acceptanceDigest(store,current(id)),decision: 'ACCEPT',reason: 'Automated fixture decision only',...input });
  t.after(() => { store.close(); assert.equal(dirname(directory),resolve(tmpdir())); rmSync(directory,{ recursive: true,force: true }); });
  return { directory,store,flow,human,token,workspace,cmd,enroll,lead,pm,worker,qa,current,issue,change,db,observation,propose,report,triage,reviewed,decide };
}

test('public proposals on unstarted readable issues are nonblocking, truthful and idempotent', t => {
  const f = fixture(t); const issue = f.issue(); const before = canonical(f.current(issue.id)); const packet = f.cmd('issue_get',{ issueId: issue.id });
  const input = { issueId: issue.id,expectedVersion: issue.version,...finding,idempotencyKey: randomUUID() };
  const record = f.cmd('defect_propose',input,f.lead.actor).defect; const after = f.db();
  assert.equal(record.state,'PROPOSED'); assert.equal(record.origin,null); assert.equal(record.observation.kind,'ISSUE_SCOPE'); assert.equal(record.observation.snapshotId,null); assert.equal(record.observation.digest,null);
  assert.equal(canonical(f.current(issue.id)),before); assert.deepEqual(f.cmd('issue_get',{ issueId: issue.id }).defects.decisionSet,packet.defects.decisionSet);
  assert.equal(f.cmd('defect_propose',input,f.lead.actor).replayed,true); assert.equal(f.db(),after);
  assert.throws(() => f.cmd('defect_propose',{ ...input,actual: 'Changed intent' },f.lead.actor),fails('IDEMPOTENCY_CONFLICT'));
  const gap = f.cmd('gap_list').gaps.find((value: any) => value.defectId === record.id); assert.equal(gap.code,'DEFECT_TRIAGE_PENDING'); assert.equal(gap.severity,'advisory');
});

test('proposal validation and stale versions roll back counters, sources, events and receipts', t => {
  const f = fixture(t); const issue = f.issue(); const before = f.db();
  assert.throws(() => f.propose(issue.id,f.lead.actor,{ expectedVersion: issue.version + 1 }),fails('VERSION_CONFLICT')); assert.equal(f.db(),before);
  assert.throws(() => f.propose(issue.id,f.lead.actor,{ criterionIds: ['UNMAPPED'] }),fails('CRITERIA_UNMAPPED')); assert.equal(f.db(),before);
  assert.throws(() => f.propose(issue.id,f.human),fails('ROLE_DENIED')); assert.equal(f.db(),before);
});

test('worker and run-scoped defect reads and proposals cannot escape assigned issue context', t => {
  const f = fixture(t); const parent = f.issue(); const mine = f.issue(parent.id); const hidden = f.issue(parent.id);
  f.change('issue_assign',mine.id,{ actorId: f.worker.actor.id,harness: 'codex' }); f.change('issue_assign',hidden.id,{ actorId: f.worker.actor.id,harness: 'codex' });
  const visible = f.propose(mine.id); const secret = f.propose(hidden.id); const runId = randomUUID(); const actor = { ...f.worker.actor,id: randomUUID(),principalId: f.worker.actor.id,runId } as Actor; f.store.token(actor);
  f.store.put('run',{ id: runId,workspaceId: f.workspace.id,issueId: mine.id,executionActorId: actor.id,state: 'RUNNING' },f.workspace.id);
  assert.deepEqual(f.cmd('defect_list',{},actor).defects.map((d: DefectRecord) => d.id),[visible.id]);
  const before = f.db(); assert.throws(() => f.cmd('defect_get',{ defectId: secret.id },actor),fails('SCOPE_DENIED')); assert.throws(() => f.propose(hidden.id,actor),fails('SCOPE_DENIED')); assert.equal(f.db(),before);
  assert.equal(f.cmd('defect_get',{ defectId: visible.id },actor).defect.id,visible.id); assert.equal(f.propose(parent.id,actor).state,'PROPOSED');
});

test('human proposal triage enforces both versions and converts without fabricated approval', t => {
  const f = fixture(t); const issue = f.issue(); const record = f.propose(issue.id); const before = f.db();
  for (const actor of [f.lead.actor,f.pm.actor,f.worker.actor,f.qa.actor]) assert.throws(() => f.triage(record,'REJECT',{},actor),fails('ROLE_DENIED'));
  assert.throws(() => f.triage(record,'REJECT',{ expectedIssueVersion: issue.version + 1 }),fails('VERSION_CONFLICT')); assert.equal(f.db(),before);
  assert.throws(() => f.triage(record,'CONFIRM',{ severity: 'MAJOR',observation: record.observation }),fails('DEFECT_OBSERVATION_REQUIRED')); assert.equal(f.db(),before);
  const converted = f.triage(record,'NEW_REQUIREMENT',{ requirement: { title: 'Explicit new scope',description: 'Plan separately',criteria: ['NEW-1'] } });
  assert.equal(converted.defect.state,'CONVERTED'); assert.equal(converted.defect.origin,null); assert.equal(converted.requirement.state,'NOT_STARTED'); assert.equal(converted.requirement.designId,null); assert.equal(converted.requirement.assignee,null);
  assert.equal(f.current(issue.id).version,issue.version); assert.equal(f.store.list('approval').length,0); assert.equal(f.store.list('defect_requirement').length,1);
});

test('delivery rejection classification is mandatory and DEFECT findings commit atomically', t => {
  const f = fixture(t); const issue = f.issue(); f.reviewed(issue.id); const before = f.db();
  assert.throws(() => f.decide(issue.id,{ decision: 'REJECT' }),fails('INVALID_INPUT')); assert.equal(f.db(),before);
  assert.throws(() => f.decide(issue.id,{ decision: 'REJECT',classification: 'DEFECT',findings: [finding,{ ...finding,criterionIds: ['MISSING'] }] }),fails('CRITERIA_UNMAPPED')); assert.equal(f.db(),before);
  const input = { expectedVersion: f.current(issue.id).version,decision: 'REJECT',classification: 'DEFECT',findings: [finding,{ ...finding,severity: 'MINOR' }],idempotencyKey: randomUUID() }; const result = f.decide(issue.id,input);
  assert.equal(result.issue.state,'USER_REJECTED'); const records = f.cmd('defect_list').defects; assert.equal(records.length,2); assert.ok(records.every((d: DefectRecord) => d.origin === 'USER_ACCEPTANCE' && d.observation.digest === result.approval.digest));
  const saved = f.db(); assert.equal(f.cmd('delivery_decide',{ workspaceId: f.workspace.id,issueId: issue.id,candidateId: result.approval.candidateId,digest: result.approval.digest,reason: 'Automated fixture decision only',...input }).replayed,true); assert.equal(f.db(),saved);
});

test('scope rejection blocks admission until a different current design is approved after rejection', t => {
  const f = fixture(t); const issue = f.issue(); f.reviewed(issue.id); f.decide(issue.id,{ decision: 'REJECT',classification: 'SCOPE_CHANGE' });
  assert.equal(f.cmd('defect_list').total,0); assert.ok(f.flow.readiness(f.current(issue.id)).blocking.includes('SCOPE_REVISION_REQUIRED'));
  const oldDesign = f.current(issue.id).designId; f.change('design_set',issue.id,{ content: 'A different explicit scope design',criteria: ['C1'] }); f.change('design_submit',issue.id);
  assert.ok(f.flow.readiness(f.current(issue.id)).blocking.includes('SCOPE_REVISION_REQUIRED')); assert.notEqual(f.current(issue.id).designId,oldDesign);
  f.change('design_decide',issue.id,{ designId: f.current(issue.id).designId,decision: 'APPROVED',reason: 'Actual later fixture approval event' });
  assert.ok(!f.flow.readiness(f.current(issue.id)).blocking.includes('SCOPE_REVISION_REQUIRED'));
});

test('CLARIFICATION creates no defects while ACCEPT rejects hidden rejection fields', t => {
  const f = fixture(t); const issue = f.issue(); f.reviewed(issue.id); const before = f.db();
  assert.throws(() => f.decide(issue.id,{ classification: 'CLARIFICATION' }),fails('INVALID_INPUT')); assert.equal(f.db(),before);
  f.decide(issue.id,{ decision: 'REJECT',classification: 'CLARIFICATION' }); assert.equal(f.cmd('defect_list').total,0);
});

test('human closed-delivery reports support explicit defer, linked requirement and authorized reopen', t => {
  const f = fixture(t); const issue = f.issue(); f.reviewed(issue.id); f.decide(issue.id); const closed = canonical(f.current(issue.id));
  const deferred = f.report(issue.id); const observation = f.observation(issue.id);
  f.triage(deferred,'DEFER',{ observation }); assert.equal(canonical(f.current(issue.id)),closed);
  const linked = f.triage(f.cmd('defect_get',{ defectId: deferred.id }).defect,'NEW_REQUIREMENT',{ observation,requirement: { title: 'Fix escaped behavior separately',description: 'Explicit separate scope',criteria: ['FIX-1'] } });
  assert.equal(linked.requirement.state,'NOT_STARTED'); assert.equal(linked.defect.state,'OPEN'); assert.equal(linked.defect.origin,'ESCAPED'); assert.equal(canonical(f.current(issue.id)),closed);
  const reopened = f.report(issue.id); f.triage(reopened,'REOPEN',{ observation: f.observation(issue.id) }); assert.equal(f.current(issue.id).state,'NOT_STARTED'); assert.equal(f.current(issue.id).candidate,null);
  assert.equal(f.cmd('defect_get',{ defectId: reopened.id }).defect.observation.digest,reopened.observation.digest); assert.ok(f.cmd('gap_list').gaps.some((g: any) => g.code === 'ESCAPED_DEFECT_OPEN'));
});

test('confirmation blocks closure, human withdrawal clears it, and saved acceptance remains explicit', t => {
  const f = fixture(t); const issue = f.issue(); f.reviewed(issue.id); const record = f.propose(issue.id);
  const confirmed = f.triage(record,'CONFIRM',{ severity: 'MAJOR',observation: f.observation(issue.id) }).defect; const accepted = f.decide(issue.id);
  assert.equal(accepted.issue.state,'USER_ACCEPTANCE'); assert.ok(accepted.closureBlocked.includes('UNRESOLVED_DEFECTS'));
  const before = f.db(); assert.throws(() => f.cmd('defect_withdraw',{ defectId: confirmed.id,expectedVersion: confirmed.version,reason: 'Not permitted' },f.lead.actor),fails('ROLE_DENIED')); assert.equal(f.db(),before);
  f.cmd('defect_withdraw',{ defectId: confirmed.id,expectedVersion: confirmed.version,reason: 'Explicit human correction to the reported finding' }); assert.equal(f.current(issue.id).state,'USER_ACCEPTANCE');
  f.change('delivery_complete',issue.id,{},f.lead.actor); assert.equal(f.current(issue.id).state,'DONE'); assert.equal(f.store.list('delivery_approval').length,1);
});

test('legacy migration preserves old records and evidence identities across service restarts', t => {
  const f = fixture(t); const issue = f.issue(); const record = { id: randomUUID(),workspaceId: f.workspace.id,issueId: issue.id,state: 'OPEN',severity: 'MAJOR',criterionId: 'C1',reproduce: 'Historical input',expected: 'Old expectation',actual: 'Old result',reportId: 'old-report',candidateId: 'old-candidate',snapshotId: 'old-snapshot' };
  f.store.put('defect',record,f.workspace.id); const issueBefore = canonical(f.current(issue.id)); const history = canonical(f.store.list('review'));
  const restarted = new Workflow(f.store); const migrated = (restarted.execute(f.human,'defect_get',{ workspaceId: f.workspace.id,defectId: record.id }) as any).defect;
  assert.equal(migrated.origin,'QA'); assert.equal(migrated.key,'DFA-D0001'); assert.equal(migrated.createdAt,null); assert.equal(migrated.reporterId,null);
  const before = f.db(); new Workflow(f.store); assert.equal(f.db(),before); assert.equal(canonical(f.current(issue.id)),issueBefore); assert.equal(canonical(f.store.list('review')),history);
  const next = f.propose(issue.id); assert.equal(next.key,'DFA-D0002'); assert.equal(f.cmd('defect_get',{ defectId: record.id }).defect.state,'OPEN');
});

test('all pending gap records remain scoped beyond one list page and reads remain pure', t => {
  const f = fixture(t); const issue = f.issue(); for (let index = 0; index < 103; index++) f.propose(issue.id,f.lead.actor,{ actual: `Distinct fixture problem ${index}` });
  const before = f.db(); assert.equal(f.cmd('defect_list',{ limit: 20 }).nextOffset,20); assert.equal(f.cmd('defect_list',{ offset: 100 }).defects.length,3);
  assert.equal(f.cmd('gap_list').gaps.filter((g: any) => g.code === 'DEFECT_TRIAGE_PENDING').length,103); assert.equal(f.db(),before);
});

test('real HTTP and stdio MCP expose only scoped proposals and reads, never human decisions', async t => {
  const f = fixture(t); const issue = f.issue(); const server = createServer(f.store); const endpoint = await server.listen({ host: '127.0.0.1',port: 0 });
  const client = new Client({ name: 'defect-source-fixture',version: '1.0' }); const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined));
  env.AGILEDEV_ENDPOINT = endpoint; env.AGILEDEV_TOKEN = f.lead.token;
  const transport = new StdioClientTransport({ command: process.execPath,args: [resolve('dist/cli.js'),'mcp'],env,stderr: 'pipe' });
  try {
    const record = f.propose(issue.id);
    for (const [op,input] of [
      ['defect_report',{ issueId: issue.id,expectedVersion: issue.version,observation: record.observation,...finding }],
      ['defect_triage',{ defectId: record.id,expectedVersion: record.version,expectedIssueVersion: issue.version,action: 'REJECT',reason: 'Denied agent decision' }],
      ['defect_withdraw',{ defectId: record.id,expectedVersion: record.version,reason: 'Denied agent withdrawal' }]
    ] as const) {
      assert.equal(agentOperations.includes(op),false); const before = f.db();
      const response = await server.inject({ method: 'POST',url: `/api/command/${op}`,headers: { host: new URL(endpoint).host,authorization: `Bearer ${f.lead.token}` },payload: { workspaceId: f.workspace.id,idempotencyKey: randomUUID(),...input } });
      assert.equal(response.statusCode,403); assert.equal(response.json().error.code,'ROLE_DENIED'); assert.equal(f.db(),before);
    }
    await client.connect(transport); const tools = (await client.listTools()).tools;
    for (const op of ['defect_propose','defect_list','defect_get']) assert.ok(tools.some(tool => tool.name === op));
    for (const op of ['defect_report','defect_triage','defect_withdraw','delivery_decide']) { assert.ok(!tools.some(tool => tool.name === op)); assert.equal((await client.callTool({ name: op,arguments: {} })).isError,true); }
    assert.equal(tools.find(tool => tool.name === 'defect_get')!.annotations!.readOnlyHint,true);
    const result = await client.callTool({ name: 'defect_propose',arguments: { workspaceId: f.workspace.id,issueId: issue.id,expectedVersion: issue.version,idempotencyKey: randomUUID(),...finding } }); assert.notEqual(result.isError,true);
    const readsBefore = f.db(); const listed = await client.callTool({ name: 'defect_list',arguments: { workspaceId: f.workspace.id } }); assert.notEqual(listed.isError,true); assert.equal(f.db(),readsBefore);
  } finally { await client.close(); await server.close(); }
});
