import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Actor, Candidate, CheckRun, DomainError, GitSubmission, Harness, Issue, QaReport, Run, Snapshot, Workspace } from './contracts.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { createServer } from './http.js';
import { Coordinator } from './runner.js';
import { GitHubProvider, githubRepository, inspectGitBinding, snapshotGitTree } from './git.js';
import { sealSnapshot,snapshotManifest } from './snapshots.js';
import { hash } from './store.js';

function fixtureSummary(value: string | undefined, root: string, limit: number) {
  return value?.replaceAll(JSON.stringify(root).slice(1,-1),'<fixture>').replaceAll(root,'<fixture>').slice(-limit);
}

export async function verifyGit(sourceRoot: string) {
  const source = resolve(sourceRoot);
  const git = (cwd: string,args: string[]) => execFileSync('git',args,{ cwd,windowsHide: true,encoding: 'utf8',timeout: 30000,maxBuffer: 16777216,stdio: ['ignore','pipe','ignore'] }).replace(/\r?\n$/,'');
  const repository = githubRepository(git(source,['remote','get-url','origin']));
  const sha = git(source,['rev-parse','HEAD']);
  const root = mkdtempSync(join(tmpdir(),'agiledev-git-verification-')); const checkout = join(root,'source');
  git(root,['clone','--shared','--no-checkout','--',source,checkout]);
  git(checkout,['remote','set-url','origin',`https://github.com/${repository}.git`]);
  git(checkout,['-c','core.autocrlf=false','-c','core.hooksPath=/dev/null','checkout','--detach',sha]);
  const workspace: Workspace = { id: randomUUID(),name: 'Remote Git verification fixture',root: checkout,prefix: 'GIT',sequence: 0,commonDir: resolve(checkout,git(checkout,['rev-parse','--git-common-dir'])) };
  const binding = inspectGitBinding(workspace,'origin','verification-fixture');
  const manifest = snapshotManifest(checkout,[],true); if (!manifest.length) throw new DomainError('EMPTY_FIXTURE','Choose a repository with at least one committed file');
  const first = manifest[0]!;
  const candidate: Candidate = { id: randomUUID(),workerId: 'verification-fixture',sessionId: randomUUID(),designId: 'provider-boundary-only',files: [{ path: first.path,hash: hash(readFileSync(join(checkout,first.path))) }],hash: 'provider-boundary-only',summary: 'Read-only provider verification of a published commit',executionRoot: checkout };
  const snapshot = sealSnapshot(candidate,workspace.id,randomUUID(),join(root,'snapshots'),true);
  const expectedTreeSha = snapshotGitTree(snapshot);
  const submission: GitSubmission = { id: randomUUID(),workspaceId: workspace.id,issueId: snapshot.issueId,candidateId: candidate.id,snapshotId: snapshot.id,bindingId: binding.id,repository,subdirectory: '',sha,url: `https://github.com/${repository}/commit/${sha}`,actorId: 'verification-fixture',createdAt: new Date().toISOString(),state: 'QUEUED',attempt: 0 };
  try {
    const result = await new GitHubProvider().resolve(submission,AbortSignal.timeout(30000));
    return { status: result.treeSha === expectedTreeSha ? 'GIT_COMMIT_VERIFIED' : 'GIT_COMMIT_NOT_VERIFIED',repository,sha,...result,expectedTreeSha,snapshotFileCount: snapshot.files.length,retainedEvidenceDirectory: root,limitations: ['Read-only remote-provider boundary check; does not create approvals, verify independent QA, close a real issue, merge, or deploy.'] };
  } catch (error) { return { status: 'GIT_COMMIT_NOT_VERIFIED',repository,sha,expectedTreeSha,errorCode: error instanceof DomainError ? error.code : 'VERIFICATION_FAILED',retainedEvidenceDirectory: root }; }
}

export async function verifyExecution(harness: Harness, bridgeScript: string, qaHarness?: Harness) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-native-execution-'));
  const source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'README.md'), 'Disposable AgileDev execution fixture.\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init'); git('add', '.'); git('-c', 'user.name=AgileDev verification', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initialize disposable execution fixture');
  const store = new Store(join(root, 'workflow.sqlite')); const flow = new Workflow(store); const owner = store.bootstrap();
  const call = (actor: Actor, operation: string, input: object) => flow.execute(actor, operation, { idempotencyKey: randomUUID(), ...input }) as any;
  const workspace = call(owner.actor, 'workspace_register', { root: source, name: 'Native execution verification', prefix: 'NAT' }).workspace;
  const run = (operation: string, input: object) => call(owner.actor, operation, { workspaceId: workspace.id, ...input });
  const parent = run('issue_create', { title: 'Native execution fixture', description: 'Verify the selected native harness executes in an isolated directory and submits actual files', criteria: ['FILE-1'], ...(qaHarness ? { artifactMode: 'artifact', artifactReason: 'Disposable integration fixture for artifact acceptance; does not verify Git commit closure' } : {}) }).issue;
  const change = (operation: string, issueId: string, input: object = {}) => run(operation, { issueId, expectedVersion: store.get<Issue>('issue', issueId).version, ...input });
  change('design_set', parent.id, { content: 'Create delivery.txt containing exactly agiledev-native-ok followed by a newline. Do not change README.md. Submit delivery.txt through the workflow tool. This is a disposable integration fixture, not a user delivery acceptance.', criteria: ['FILE-1'] });
  change('design_submit', parent.id); change('design_decide', parent.id, { designId: store.get<Issue>('issue', parent.id).designId, decision: 'APPROVED', reason: 'Automated integration fixture setup; not approval of a real product requirement' });
  const task = run('issue_create', { parentId: parent.id, expectedParentVersion: store.get<Issue>('issue', parent.id).version, title: '[Test] Execution: write delivery.txt -> authenticated submission', description: 'Write delivery.txt containing exactly agiledev-native-ok and a newline, then use the provided MCP workflow tools to submit that file for initial lead review. Preserve README.md.', criteria: ['FILE-1'] }).issue;
  const worker = run('actor_enroll', { role: 'worker', name: `${harness} fixture worker` });
  change('issue_assign', task.id, { actorId: worker.actor.id, harness });
  const plannedTask = store.get<Issue>('issue',task.id);
  change('plan_apply',parent.id,{ expectedPlanId: null,designId: store.get<Issue>('issue',parent.id).designId,mode: 'READY',tasks: [{ ref: 'delivery',issueId: plannedTask.id,expectedVersion: plannedTask.version,title: plannedTask.title,description: plannedTask.description,criteria: plannedTask.criteria,dependencies: [] }],reason: 'Explicit automated native verification plan; not human product approval' });
  const lead = qaHarness ? run('actor_enroll',{ role: 'lead', name: 'Automated integration fixture lead' }).actor as Actor : undefined;
  if (qaHarness) {
    const qa = run('actor_enroll',{ role: 'qa',name: `${qaHarness} independent fixture reviewer` });
    const profile = run('check_profile_create',{ name: 'Independent exact-file fixture check',command: process.execPath,args: ['.qa/check.mjs'],criteria: ['FILE-1'],timeoutMs: 10000 }).profile;
    change('qa_configure',task.id,{ actorId: qa.actor.id,harness: qaHarness,checkProfileIds: [profile.id] });
  }
  const job = change('work_dispatch', task.id, { designId: store.get<Issue>('issue', parent.id).designId, scopeRevision: 1 }).run as Run;
  const app = createServer(store); const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const coordinator = new Coordinator(store, { endpoint, directory: join(root, 'runs'), bridgeScript, concurrency: 1, maxRunMs: 120000 });
  try {
    await coordinator.start(); const deadline = Date.now() + 140000;
    while (['QUEUED', 'STARTING', 'RUNNING', 'STOPPING'].includes(store.get<Run>('run', job.id).state) && Date.now() < deadline) await new Promise(done => setTimeout(done, 250));
    const final = store.get<Run>('run', job.id); const issue = store.get<Issue>('issue', task.id);
    const delivered = issue.candidate?.executionRoot ? join(issue.candidate.executionRoot, 'delivery.txt') : null;
    const expectedContent = delivered && existsSync(delivered) ? readFileSync(delivered, 'utf8') === 'agiledev-native-ok\n' : false;
    const sourceIntact = !existsSync(join(source, 'delivery.txt')) && readFileSync(join(source, 'README.md'), 'utf8') === 'Disposable AgileDev execution fixture.\n';
    if (qaHarness && final.state === 'SUCCEEDED' && expectedContent && sourceIntact) {
      const initial = store.get<Issue>('issue',task.id);
      call(lead!,'review_submit',{ workspaceId: workspace.id,issueId: task.id,expectedVersion: initial.version,candidateId: initial.candidate!.id,verdict: 'PASS',reason: 'Automated integration fixture initial review, not real product acceptance' });
      const qaJob = store.list<Run>('run',workspace.id).find(r => r.kind === 'qa' && r.issueId === task.id)!;
      const qaDeadline = Date.now() + 180000;
      while (['QUEUED','STARTING','RUNNING','STOPPING'].includes(store.get<Run>('run',qaJob.id).state) && Date.now() < qaDeadline) await new Promise(done => setTimeout(done,250));
      await coordinator.close();
      const qaRun = store.get<Run>('run',qaJob.id); let afterQa = store.get<Issue>('issue',task.id);
      if (qaRun.state === 'SUCCEEDED' && afterQa.state === 'LEAD_REVIEW' && afterQa.stage === 'FINAL') {
        call(lead!,'review_submit',{ workspaceId: workspace.id,issueId: task.id,expectedVersion: afterQa.version,candidateId: afterQa.candidate!.id,verdict: 'PASS',reason: 'Automated integration fixture final review, not real product acceptance' });
        afterQa = store.get<Issue>('issue',task.id);
        const packet = flow.execute(owner.actor,'issue_get',{ workspaceId: workspace.id,issueId: task.id }) as any;
        change('delivery_decide',task.id,{ candidateId: afterQa.candidate!.id,digest: packet.deliveryDigest,decision: 'ACCEPT',reason: 'Automated integration fixture owner decision only; not actual user acceptance or Git closure' });
      }
      const report = qaRun.reportId ? store.get<QaReport>('qa_report',qaRun.reportId) : null;
      const snapshot = store.get<Snapshot>('snapshot',initial.candidate!.snapshotId!);
      const checks = store.list<CheckRun>('check',workspace.id).filter(c => c.runId === qaRun.id);
      const status = store.get<Issue>('issue',task.id).state;
      return { workerHarness: harness,qaHarness,status: status === 'DONE' && qaRun.state === 'SUCCEEDED' ? 'QA_HANDOFF_VERIFIED' : 'QA_HANDOFF_NOT_VERIFIED',workerRunState: final.state,qaRunState: qaRun.state,qaErrorCode: qaRun.errorCode,issueState: status,workerProviderSessionRecorded: !!final.providerSessionId,qaProviderSessionRecorded: !!qaRun.providerSessionId,independentSessions: report ? report.sessionId !== initial.candidate!.sessionId : null,independentDirectories: qaRun.executionRoot ? qaRun.executionRoot !== initial.candidate!.executionRoot : null,snapshotHash: snapshot.hash,snapshotFileCount: snapshot.files.length,checks: checks.map(c => ({ state: c.state,exitCode: c.exitCode,profileHash: c.profileHash,criteria: c.criteria,stdout: fixtureSummary(c.stdout,root,3000),stderr: fixtureSummary(c.stderr,root,3000),errorCode: c.errorCode })),qaVerdict: report?.verdict ?? null,reportSubmitted: !!report,expectedContent,sourceIntact,retainedEvidenceDirectory: root,diagnostic: qaRun.state !== 'SUCCEEDED' ? fixtureSummary(qaRun.summary,root,2500) : undefined,limitations: ['Provider execution and QA evidence are real. Human/design/lead decisions are automated fixture setup, not actual product acceptance.','Artifact mode deliberately excludes Git commit closure, merge, deployment, UI, and packaging acceptance.'] };
    }
    await coordinator.close();
    return { harness, status: final.state === 'SUCCEEDED' && expectedContent && sourceIntact && issue.state === 'LEAD_REVIEW' ? 'EXECUTION_VERIFIED' : 'EXECUTION_NOT_VERIFIED', runState: final.state, errorCode: final.errorCode, issueState: issue.state, providerSessionRecorded: !!final.providerSessionId, expectedContent, sourceIntact, retainedEvidenceDirectory: root, diagnostic: final.state !== 'SUCCEEDED' ? fixtureSummary(final.summary,root,2500) : undefined, limitations: ['This verifies worker execution and submission, not independent QA or user acceptance.'] };
  } finally { await coordinator.close(); await app.close(); store.close(); }
}
