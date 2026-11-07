import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Actor, CheckRun, Issue, Run, Snapshot } from '../src/contracts.js';
import { Coordinator } from '../src/runner.js';
import { AdapterContext, AdapterResult, ExecutionAdapter } from '../src/adapters.js';
import { createServer } from '../src/http.js';
import { LocalClient } from '../src/client.js';
import { GitHubProvider } from '../src/git.js';
import { GitVerifier } from '../src/git-verifier.js';
import { GitSubmission } from '../src/contracts.js';

async function until(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Expected state did not arrive'); await new Promise(done => setTimeout(done,20)); }
}
class ProviderDouble implements ExecutionAdapter {
  contexts: AdapterContext[] = [];
  finish = new Map<string,(result: AdapterResult) => void>();
  async start(context: AdapterContext) {
    this.contexts.push(context); context.onProvider(`test-session-${randomUUID()}`);
    return { result: new Promise<AdapterResult>(done => this.finish.set(context.cwd,done)), interrupt: async () => { this.finish.get(context.cwd)?.({ outcome: 'cancelled' }); return true; } };
  }
}
async function fixture(mode: 'artifact' | 'git' = 'artifact') {
  const root = mkdtempSync(join(tmpdir(),'agiledev-qa-')); const source = join(root,'source'); mkdirSync(source);
  writeFileSync(join(source,'source.txt'),'original'); writeFileSync(join(source,'contract.txt'),'preserve this independent file');
  const git = (...args: string[]) => execFileSync('git',args,{ cwd: source, windowsHide: true, stdio: 'ignore' });
  git('init'); git('add','.'); git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=/dev/null','commit','-m','fixture');
  const store = new Store(join(root,'workflow.sqlite')); const flow = new Workflow(store); const human = store.bootstrap().actor;
  const call = (actor: Actor,op: string,input: object) => flow.execute(actor,op,{ idempotencyKey: randomUUID(), ...input }) as any;
  const workspace = call(human,'workspace_register',{ root: source, name: 'Independent QA fixture',prefix: 'QA' }).workspace;
  const run = (op: string,input: object) => call(human,op,{ workspaceId: workspace.id,...input });
  const current = (id: string) => store.get<Issue>('issue',id);
  const change = (op: string,id: string,input: object = {},actor = human) => call(actor,op,{ workspaceId: workspace.id,issueId: id,expectedVersion: current(id).version,...(op === 'grant_create' ? { scopeHash: (flow.execute(human,'issue_get',{ workspaceId: workspace.id,issueId: id }) as any).authorizationScopeHash } : {}),...input });
  const parent = run('issue_create',{ title: 'QA pipeline',description: 'Deliver exact content',criteria: ['FILE'],artifactMode: mode,artifactReason: mode === 'artifact' ? 'Disposable test of non-code artifact delivery' : undefined }).issue;
  change('design_set',parent.id,{ content: 'source.txt must contain delivered. Preserve contract.txt. Test the actual delivered source.',criteria: ['FILE'] });
  change('design_submit',parent.id); change('design_decide',parent.id,{ designId: current(parent.id).designId,decision: 'APPROVED',reason: 'Automated test fixture approval only' });
  const issue = run('issue_create',{ parentId: parent.id,expectedParentVersion: current(parent.id).version,title: '[Test] Content: deliver exact output -> verified artifact',description: 'source.txt must be exactly delivered',criteria: ['FILE'] }).issue;
  const worker = run('actor_enroll',{ role: 'worker',name: 'Worker' }).actor;
  const lead = run('actor_enroll',{ role: 'lead',name: 'Lead' }).actor;
  const qa = run('actor_enroll',{ role: 'qa',name: 'Independent QA' }).actor;
  const profile = run('check_profile_create',{ name: 'Independent Node check',command: process.execPath,args: ['.qa/check.mjs'],criteria: ['FILE'],timeoutMs: 5000 }).profile;
  change('issue_assign',issue.id,{ actorId: worker.id,harness: 'codex' }); change('qa_configure',issue.id,{ actorId: qa.id,harness: 'dsh',checkProfileIds: [profile.id] });
  const dispatch = () => change('work_dispatch',issue.id,{ designId: current(parent.id).designId,scopeRevision: current(issue.id).scopeRevision }).run as Run;
  dispatch();
  const app = createServer(store); const endpoint = await app.listen({ host: '127.0.0.1',port: 0 }); const adapter = new ProviderDouble();
  const coordinator = new Coordinator(store,{ endpoint,directory: join(root,'runs'),bridgeScript: resolve('dist/cli.js'),adapter }); await coordinator.start();
  const context = async (index: number) => { await until(() => adapter.contexts.length > index); return adapter.contexts[index]!; };
  const complete = async (ctx: AdapterContext) => {
    const actor = store.authenticate(ctx.token); adapter.finish.get(ctx.cwd)!({ outcome: 'succeeded' });
    await until(() => ['SUCCEEDED','FAILED','CANCELLED','UNCERTAIN'].includes(store.get<Run>('run',actor.runId!).state));
    return store.get<Run>('run',actor.runId!);
  };
  const submit = async (ctx: AdapterContext,content: string) => {
    writeFileSync(join(ctx.cwd,'source.txt'),content); const i = current(issue.id);
    await new LocalClient(endpoint,ctx.token).command('work_submit',{ workspaceId: workspace.id,issueId: issue.id,expectedVersion: i.version,fence: i.fence,summary: 'Fixture delivery',files: ['source.txt'],idempotencyKey: randomUUID() });
    assert.equal((await complete(ctx)).state,'SUCCEEDED');
  };
  const initialReview = () => change('review_submit',issue.id,{ candidateId: current(issue.id).candidate!.id,verdict: 'PASS',reason: 'Initial fixture review' },lead);
  const check = async (ctx: AdapterContext,script?: string) => {
    mkdirSync(join(ctx.cwd,'.qa'),{ recursive: true });
    writeFileSync(join(ctx.cwd,'.qa/check.mjs'),script ?? `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(process.env.AGILEDEV_TOKEN,undefined); assert.equal(readFileSync('source.txt','utf8'),'delivered'); console.log('independent exact-content check passed');`);
    const client = new LocalClient(endpoint,ctx.token);
    const result = await client.command('qa_check_run',{ workspaceId: workspace.id,issueId: issue.id,expectedVersion: current(issue.id).version,profileId: profile.id,testFiles: ['.qa/check.mjs'],idempotencyKey: randomUUID() });
    await until(() => ['PASSED','FAILED','UNCERTAIN'].includes(store.get<CheckRun>('check',result.check.id).state));
    return (await client.command('qa_check_get',{ workspaceId: workspace.id,checkId: result.check.id })).check as CheckRun;
  };
  const report = (ctx: AdapterContext,checkId: string,verdict: 'PASS' | 'FAIL' | 'BLOCKED' = 'PASS') => new LocalClient(endpoint,ctx.token).command('qa_report_submit',{ workspaceId: workspace.id,issueId: issue.id,expectedVersion: current(issue.id).version,candidateId: current(issue.id).candidate!.id,verdict,summary: 'Independent fixture result',results: [{ criterionId: 'FILE',result: verdict === 'BLOCKED' ? 'NOT_RUN' : verdict,evidenceIds: checkId ? [checkId] : [],reason: 'Observed exact-content behavior' }],findings: verdict === 'FAIL' ? [{ criterionId: 'FILE',severity: 'MAJOR',expected: 'source.txt contains delivered',actual: 'source.txt contains incorrect output',reproduce: 'Run the captured .qa/check.mjs command on this snapshot' }] : [],idempotencyKey: randomUUID() });
  const finalReview = () => change('review_submit',issue.id,{ candidateId: current(issue.id).candidate!.id,verdict: 'PASS',reason: 'Final requirement-fit fixture review' },lead);
  const delivery = (decision = 'ACCEPT',digest?: string) => change('delivery_decide',issue.id,{ candidateId: current(issue.id).candidate!.id,digest: digest ?? (flow.execute(human,'issue_get',{ workspaceId: workspace.id,issueId: issue.id }) as any).deliveryDigest,decision,reason: 'Automated test fixture decision, not real user delivery acceptance' });
  const close = async () => { await coordinator.close(); await app.close(); store.close(); rmSync(root,{ recursive: true,force: true }); };
  return { root,source,workspace,issue,parent,store,flow,human,lead,qa,worker,adapter,coordinator,current,change,dispatch,context,complete,submit,initialReview,check,report,finalReview,delivery,close };
}

test('independent QA executes a real check on a sealed full snapshot before final and human gates', { timeout: 20000 },async () => {
  const f = await fixture();
  try {
    const worker = await f.context(0); await f.submit(worker,'delivered');
    const candidate = f.current(f.issue.id).candidate!; const snapshot = f.store.get<Snapshot>('snapshot',candidate.snapshotId!);
    assert.deepEqual(snapshot.files.map(file => file.path),['contract.txt','source.txt']);
    writeFileSync(join(worker.cwd,'contract.txt'),'producer changed after sealing');
    f.initialReview(); const qa = await f.context(1);
    assert.notEqual(qa.cwd,worker.cwd); assert.equal(f.store.authenticate(qa.token).role,'qa'); assert.equal(qa.harness,'dsh');
    assert.equal(readFileSync(join(qa.cwd,'contract.txt'),'utf8'),'preserve this independent file');
    const check = await f.check(qa); assert.equal(check.state,'PASSED'); assert.equal(check.exitCode,0); assert.match(check.stdout!,/exact-content check passed/); assert.equal(check.snapshotId,snapshot.id); assert.ok(check.pid);
    await assert.rejects(new LocalClient(qa.endpoint,qa.token).command('review_submit',{ workspaceId: f.workspace.id,issueId: f.issue.id,expectedVersion: f.current(f.issue.id).version,candidateId: candidate.id,verdict: 'PASS',reason: 'Narrative shortcut',idempotencyKey: randomUUID() }),(e: any) => e.code === 'EVIDENCE_MISSING');
    await f.report(qa,check.id); assert.equal(f.current(f.issue.id).state,'QA_TEST');
    assert.equal((await f.complete(qa)).state,'SUCCEEDED'); assert.equal(f.current(f.issue.id).stage,'FINAL');
    f.finalReview(); assert.throws(() => f.delivery('ACCEPT','old-digest'),(e: any) => e.code === 'APPROVAL_STALE');
    assert.equal(f.delivery().issue.state,'DONE'); assert.equal(f.current(f.parent.id).state,'IN_PROGRESS');
    assert.equal(readFileSync(join(f.source,'source.txt'),'utf8'),'original');
  } finally { await f.close(); }
});

test('exact completion delegation records the human grantor and executing agent without bypassing QA', { timeout: 20000 },async () => {
  const f = await fixture();
  try {
    const worker = await f.context(0); await f.submit(worker,'delivered'); f.initialReview();
    assert.throws(() => f.change('grant_create',f.issue.id,{ granteeId: f.lead.id,action: 'complete',candidateId: f.current(f.issue.id).candidate!.id,digest: 'invented',expiresAt: new Date(Date.now()+3600000).toISOString(),reason: 'Cannot delegate an unreviewed fixture' }),(error: any) => error.code === 'APPROVAL_STALE');
    const qa = await f.context(1); const check = await f.check(qa); await f.report(qa,check.id); await f.complete(qa); f.finalReview();
    const digest = (f.flow.execute(f.human,'issue_get',{ workspaceId: f.workspace.id,issueId: f.issue.id }) as any).deliveryDigest;
    const grant = f.change('grant_create',f.issue.id,{ granteeId: f.lead.id,action: 'complete',candidateId: f.current(f.issue.id).candidate!.id,digest,expiresAt: new Date(Date.now()+3600000).toISOString(),reason: 'Automated fixture explicitly delegates acceptance of this exact snapshot' }).grant;
    assert.equal(f.store.list('delivery_approval',f.workspace.id).length,0);
    assert.equal(f.change('delivery_complete',f.issue.id,{ grantId: grant.id },f.lead).issue.state,'DONE');
    const decision = f.store.list<any>('delivery_approval',f.workspace.id)[0];
    assert.equal(decision.actorId,f.human.id); assert.equal(decision.executedBy,f.lead.id); assert.equal(decision.grantId,grant.id); assert.equal(decision.source,'delegated_close'); assert.equal(decision.digest,digest);
    const consumed = f.store.get<any>('grant',grant.id); assert.equal(consumed.uses,1);
    f.change('grant_revoke',f.issue.id,{ grantId: grant.id,expectedGrantVersion: consumed.version,reason: 'Revoke any remaining fixture authority without rewriting history' });
    assert.equal(f.current(f.issue.id).state,'DONE'); assert.equal(f.store.list('delivery_approval',f.workspace.id).length,1);
  } finally { await f.close(); }
});

test('Git-blocked delegated closure consumes no grant or acceptance and changed mapping invalidates authority', { timeout: 20000 },async () => {
  const f = await reviewedGitFixture();
  try {
    const mapping = f.attach();
    const digest = (f.flow.execute(f.human,'issue_get',{ workspaceId: f.workspace.id,issueId: f.issue.id }) as any).deliveryDigest;
    const grant = f.change('grant_create',f.issue.id,{ granteeId: f.lead.id,action: 'complete',candidateId: f.current(f.issue.id).candidate!.id,digest,expiresAt: new Date(Date.now()+3600000).toISOString(),reason: 'Fixture delegation remains conditional on verified Git evidence' }).grant;
    assert.throws(() => f.change('delivery_complete',f.issue.id,{ grantId: grant.id },f.lead),(error: any) => error.code === 'CLOSURE_BLOCKED' && error.details.blockers.includes('GIT_VERIFICATION_PENDING'));
    assert.equal(f.store.get<any>('grant',grant.id).uses,0); assert.equal(f.store.list('delivery_approval',f.workspace.id).length,0); assert.equal(f.current(f.issue.id).acceptedDigest,undefined);
    f.attach('f'.repeat(40));
    assert.notEqual(f.current(f.issue.id).gitSubmissionId,mapping.id);
    assert.throws(() => f.change('delivery_complete',f.issue.id,{ grantId: grant.id },f.lead),(error: any) => error.code === 'GRANT_STALE');
    assert.equal(f.store.get<any>('grant',grant.id).uses,0);
  } finally { await f.close(); }
});

test('real failing QA creates a reproducible defect and rework requires fresh independent evidence', { timeout: 30000 },async () => {
  const f = await fixture();
  try {
    await f.submit(await f.context(0),'incorrect'); f.initialReview(); const qa = await f.context(1);
    const failed = await f.check(qa); assert.equal(failed.state,'FAILED'); assert.notEqual(failed.exitCode,0); assert.match(failed.stderr!,/AssertionError/);
    await assert.rejects(f.report(qa,'','FAIL'),(e: any) => e.code === 'EVIDENCE_MISSING');
    await assert.rejects(f.report(qa,failed.id,'PASS'),(e: any) => e.code === 'EVIDENCE_MISSING');
    await f.report(qa,failed.id,'FAIL'); await f.complete(qa); assert.equal(f.current(f.issue.id).state,'QA_REJECTED');
    const defect = f.store.list<any>('defect',f.workspace.id)[0]!; assert.equal(defect.state,'OPEN'); assert.equal(defect.ownerId,f.worker.id); assert.ok(defect.reproduce);
    const oldCandidate = f.current(f.issue.id).candidate!.id;
    f.dispatch(); await f.submit(await f.context(2),'delivered'); f.initialReview(); const freshQa = await f.context(3);
    assert.notEqual(f.store.authenticate(freshQa.token).sessionId,failed.sessionId);
    await assert.rejects(f.report(freshQa,failed.id),(e: any) => e.code === 'EVIDENCE_STALE');
    const passed = await f.check(freshQa); await f.report(freshQa,passed.id); await f.complete(freshQa);
    assert.notEqual(f.current(f.issue.id).candidate!.id,oldCandidate); assert.equal(f.store.get<any>('defect',defect.id).state,'RESOLVED');
    assert.equal(f.store.get<CheckRun>('check',failed.id).state,'FAILED'); f.finalReview(); assert.equal(f.delivery().issue.state,'DONE');
  } finally { await f.close(); }
});

test('QA cannot pass changed source or changed test evidence; blocked checks leave the gate open', { timeout: 20000 },async () => {
  const f = await fixture();
  try {
    await f.submit(await f.context(0),'delivered'); f.initialReview(); const qa = await f.context(1); const passed = await f.check(qa);
    writeFileSync(join(qa.cwd,'.qa/check.mjs'),'console.log("replaced test")');
    await assert.rejects(f.report(qa,passed.id),(e: any) => e.code === 'EVIDENCE_STALE');
    writeFileSync(join(qa.cwd,'contract.txt'),'changed source');
    const failed = await f.check(qa); assert.equal(failed.state,'FAILED'); assert.equal(failed.errorCode,'EVIDENCE_STALE');
    await assert.rejects(f.report(qa,'','BLOCKED'),(e: any) => e.code === 'EVIDENCE_STALE');
    writeFileSync(join(qa.cwd,'contract.txt'),'preserve this independent file'); await f.report(qa,'','BLOCKED');
    assert.equal((await f.complete(qa)).errorCode,'QA_BLOCKED'); assert.equal(f.current(f.issue.id).state,'QA_TEST');
  } finally { await f.close(); }
});

test('Git acceptance remains saved but cannot close without verified commit evidence', { timeout: 20000 },async () => {
  const f = await fixture('git');
  try {
    await f.submit(await f.context(0),'delivered'); f.initialReview(); const qa = await f.context(1); const check = await f.check(qa); await f.report(qa,check.id); await f.complete(qa); f.finalReview();
    const result = f.delivery(); assert.equal(result.issue.state,'USER_ACCEPTANCE'); assert.deepEqual(result.closureBlocked,['GIT_VERIFICATION_REQUIRED']); assert.ok(f.current(f.issue.id).acceptedDigest);
    assert.throws(() => f.change('delivery_decide',f.issue.id,{ candidateId: f.current(f.issue.id).candidate!.id,digest: result.approval.digest,decision: 'ACCEPT',reason: 'Agent impersonation' },f.lead),(e: any) => e.code === 'ROLE_DENIED');
  } finally { await f.close(); }
});

test('interrupting QA terminates a real running check and retains failure evidence', { timeout: 20000 },async () => {
  const f = await fixture();
  try {
    await f.submit(await f.context(0),'delivered'); f.initialReview(); const qa = await f.context(1);
    mkdirSync(join(qa.cwd,'.qa')); writeFileSync(join(qa.cwd,'.qa/check.mjs'),'setInterval(()=>{},1000)');
    const actor = f.store.authenticate(qa.token); const client = new LocalClient(qa.endpoint,qa.token);
    const result = await client.command('qa_check_run',{ workspaceId: f.workspace.id,issueId: f.issue.id,expectedVersion: f.current(f.issue.id).version,profileId: f.store.get<Run>('run',actor.runId!).checkProfileIds![0],testFiles: ['.qa/check.mjs'],idempotencyKey: randomUUID() });
    await until(() => f.store.get<CheckRun>('check',result.check.id).state === 'RUNNING');
    const pid = f.store.get<CheckRun>('check',result.check.id).pid!; const run = f.store.get<Run>('run',actor.runId!);
    f.flow.execute(f.human,'run_interrupt',{ workspaceId: f.workspace.id,runId: run.id,expectedVersion: run.version,reason: 'Cancel real check fixture',idempotencyKey: randomUUID() });
    await until(() => f.store.get<Run>('run',run.id).state === 'CANCELLED');
    assert.throws(() => process.kill(pid,0)); assert.equal(f.store.get<CheckRun>('check',result.check.id).state,'FAILED'); assert.equal(f.current(f.issue.id).state,'QA_TEST');
  } finally { await f.close(); }
});

test('producer mutation after submission invalidates the candidate instead of stranding a review', { timeout: 20000 },async () => {
  const f = await fixture();
  try {
    const worker = await f.context(0); const issue = f.current(f.issue.id);
    writeFileSync(join(worker.cwd,'source.txt'),'delivered');
    await new LocalClient(worker.endpoint,worker.token).command('work_submit',{ workspaceId: f.workspace.id,issueId: issue.id,expectedVersion: issue.version,fence: issue.fence,files: ['source.txt'],summary: 'Submitted before mutation',idempotencyKey: randomUUID() });
    writeFileSync(join(worker.cwd,'source.txt'),'changed after submission');
    const result = await f.complete(worker); assert.equal(result.state,'FAILED'); assert.equal(result.errorCode,'EVIDENCE_STALE');
    assert.equal(f.current(f.issue.id).state,'NOT_STARTED'); assert.equal(f.current(f.issue.id).candidate,null); assert.equal(f.store.list('candidate',f.workspace.id).length,1);
    assert.equal(f.dispatch().state,'QUEUED');
  } finally { await f.close(); }
});

test('sealing includes unselected files and detects their later corruption before review', { timeout: 20000 },async () => {
  const f = await fixture();
  try {
    await f.submit(await f.context(0),'delivered'); const candidate = f.current(f.issue.id).candidate!;
    const snapshot = f.store.get<Snapshot>('snapshot',candidate.snapshotId!); writeFileSync(join(snapshot.root,'contract.txt'),'corrupted immutable evidence');
    assert.throws(() => f.initialReview(),(e: any) => e.code === 'EVIDENCE_STALE'); assert.equal(f.current(f.issue.id).state,'LEAD_REVIEW');
  } finally { await f.close(); }
});

async function reviewedGitFixture() {
  const f = await fixture('git');
  try {
    execFileSync('git',['remote','add','origin','https://github.com/fixture/delivery.git'],{ cwd: f.source,windowsHide: true,stdio: 'ignore' });
    f.flow.execute(f.human,'workspace_git_bind',{ workspaceId: f.workspace.id,idempotencyKey: randomUUID() });
    const worker = await f.context(0); await f.submit(worker,'delivered'); f.initialReview(); const qa = await f.context(1); const check = await f.check(qa); await f.report(qa,check.id); await f.complete(qa); f.finalReview();
    const git = (...args: string[]) => execFileSync('git',args,{ cwd: worker.cwd,windowsHide: true,encoding: 'utf8',stdio: ['ignore','pipe','ignore'] }).trim();
    git('add','source.txt'); git('-c','user.name=Fixture','-c','user.email=test@example.invalid','-c','core.hooksPath=/dev/null','commit','-m','Disposable delivery');
    const sha = git('rev-parse','HEAD'); const tree = git('rev-parse','HEAD^{tree}');
    const attach = (value = sha) => f.change('git_submit',f.issue.id,{ candidateId: f.current(f.issue.id).candidate!.id,commitUrl: `https://github.com/fixture/delivery/commit/${value}` }).git as GitSubmission;
    return { ...f,sha,tree,attach };
  } catch (error) { await f.close(); throw error; }
}

test('Git outage preserves exact human acceptance and successful retry closes without a second approval', { timeout: 20000 },async () => {
  const f = await reviewedGitFixture(); let calls = 0;
  const verifier = new GitVerifier(f.store,new GitHubProvider(async () => ++calls === 1 ? new Response('unavailable',{ status: 503 }) : Response.json({ sha: f.sha,tree: { sha: f.tree } }),() => undefined));
  try {
    const git = f.attach(); verifier.tick(); await until(() => f.store.get<GitSubmission>('git_submission',git.id).state === 'UNAVAILABLE');
    const accepted = f.delivery(); assert.equal(accepted.issue.state,'USER_ACCEPTANCE'); assert.deepEqual(accepted.closureBlocked,['PROVIDER_UNAVAILABLE']);
    const digest = f.current(f.issue.id).acceptedDigest; assert.ok(digest); const count = f.store.list('delivery_approval',f.workspace.id).length;
    f.change('git_retry',f.issue.id,{ submissionId: git.id },f.lead); assert.equal(f.current(f.issue.id).acceptedDigest,digest);
    verifier.tick(); await until(() => f.current(f.issue.id).state === 'DONE');
    const verified = f.store.get<GitSubmission>('git_submission',git.id); assert.equal(verified.state,'VERIFIED'); assert.equal(verified.treeSha,f.tree); assert.ok(verified.verifiedAt); assert.equal(verified.attempt,2);
    assert.equal(f.store.list('delivery_approval',f.workspace.id).length,count); assert.equal(f.store.list('git_attempt',f.workspace.id).length,2); assert.equal(calls,2);
    assert.equal(f.current(f.parent.id).state,'IN_PROGRESS');
  } finally { await verifier.close(); await f.close(); }
});

test('an existing remote commit with a different complete tree cannot close a reviewed candidate', { timeout: 20000 },async () => {
  const f = await reviewedGitFixture();
  const verifier = new GitVerifier(f.store,new GitHubProvider(async () => Response.json({ sha: f.sha,tree: { sha: 'e'.repeat(40) } }),() => undefined));
  try {
    assert.throws(() => f.change('git_submit',f.issue.id,{ candidateId: f.current(f.issue.id).candidate!.id,commitUrl: `https://github.com/wrong/repository/commit/${f.sha}` }),(e: any) => e.code === 'COMMIT_REPOSITORY_MISMATCH');
    const git = f.attach(); f.delivery(); verifier.tick(); await until(() => f.store.get<GitSubmission>('git_submission',git.id).state === 'FAILED');
    assert.equal(f.store.get<GitSubmission>('git_submission',git.id).errorCode,'COMMIT_SNAPSHOT_MISMATCH'); assert.equal(f.current(f.issue.id).state,'USER_ACCEPTANCE');
    const result = f.change('delivery_complete',f.issue.id,{},f.lead); assert.deepEqual(result.closureBlocked,['COMMIT_SNAPSHOT_MISMATCH']); assert.equal(result.issue.state,'USER_ACCEPTANCE');
  } finally { await verifier.close(); await f.close(); }
});

test('changing the final commit mapping invalidates acceptance and stale provider callbacks cannot close it', { timeout: 20000 },async () => {
  const f = await reviewedGitFixture(); let resolveResponse!: (response: Response) => void;
  const verifier = new GitVerifier(f.store,new GitHubProvider(async () => new Promise<Response>(done => { resolveResponse = done; }),() => undefined));
  try {
    const original = f.attach(); const accepted = f.delivery(); const digest = accepted.approval.digest;
    verifier.tick(); await until(() => !!resolveResponse);
    const replacement = f.attach('d'.repeat(40)); assert.notEqual(replacement.id,original.id); assert.equal(f.current(f.issue.id).acceptedDigest,undefined);
    resolveResponse(Response.json({ sha: f.sha,tree: { sha: f.tree } }));
    await until(() => f.store.get<GitSubmission>('git_submission',original.id).state === 'STALE');
    assert.equal(f.current(f.issue.id).state,'USER_ACCEPTANCE'); assert.throws(() => f.delivery('ACCEPT',digest),(e: any) => e.code === 'APPROVAL_STALE');
    const incomplete = f.change('delivery_complete',f.issue.id,{},f.lead); assert.ok(incomplete.closureBlocked.includes('HUMAN_ACCEPTANCE_REQUIRED'));
  } finally { await verifier.close(); await f.close(); }
});

test('a hold blocks automatic Git closure and saved acceptance can complete after resume', { timeout: 20000 },async () => {
  const f = await reviewedGitFixture(); let resolveResponse!: (response: Response) => void;
  const verifier = new GitVerifier(f.store,new GitHubProvider(async () => new Promise<Response>(done => { resolveResponse = done; }),() => undefined));
  try {
    const git = f.attach(); f.delivery(); verifier.tick(); await until(() => !!resolveResponse);
    f.change('issue_transition',f.issue.id,{ action: 'hold',reason: 'Fixture hold during remote verification' }); resolveResponse(Response.json({ sha: f.sha,tree: { sha: f.tree } }));
    await until(() => f.store.get<GitSubmission>('git_submission',git.id).state === 'VERIFIED'); assert.equal(f.current(f.issue.id).state,'ON_HOLD');
    f.change('issue_transition',f.issue.id,{ action: 'resume',reason: 'Resume exact fixture delivery' });
    const result = f.change('delivery_complete',f.issue.id,{},f.lead); assert.equal(result.issue.state,'DONE'); assert.equal(f.store.list('delivery_approval',f.workspace.id).length,1);
  } finally { await verifier.close(); await f.close(); }
});
