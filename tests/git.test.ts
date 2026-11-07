import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { GitAttempt, GitSubmission, Snapshot } from '../src/contracts.js';
import { GitHubProvider, githubApiVersion, githubCommitUrl, githubRepository, snapshotGitTree } from '../src/git.js';
import { snapshotManifest } from '../src/snapshots.js';
import { Store, canonical, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { GitVerifier } from '../src/git-verifier.js';

const sha = 'a'.repeat(40); const tree = 'b'.repeat(40); const scoped = 'c'.repeat(40);
const submission = (subdirectory = ''): GitSubmission => ({ id: randomUUID(),workspaceId: 'w',issueId: 'i',candidateId: 'c',snapshotId: 's',bindingId: 'b',repository: 'owner/project',subdirectory,sha,url: `https://github.com/owner/project/commit/${sha}`,actorId: 'actor',createdAt: new Date().toISOString(),state: 'QUEUED',attempt: 0 });

test('commit references require an immutable SHA and credential-free canonical GitHub repository', () => {
  for (const value of ['https://github.com/Owner/Project.git','git@github.com:Owner/Project.git','ssh://git@github.com/Owner/Project.git']) assert.equal(githubRepository(value),'owner/project');
  for (const value of ['https://example.org/owner/project','https://token@github.com/owner/project','https://github.com/owner/project?token=x','git@github.com:owner/../other','file:///repo']) assert.throws(() => githubRepository(value));
  assert.deepEqual(githubCommitUrl(`https://github.com/Owner/Project/commit/${sha.toUpperCase()}`),{ repository: 'owner/project',sha,url: `https://github.com/owner/project/commit/${sha}` });
  for (const suffix of ['tree/main','pull/1',`commit/${sha.slice(0,8)}`,`commit/${sha}?x=1`,`commit/${sha}#diff`,`commit/${sha}/`]) assert.throws(() => githubCommitUrl(`https://github.com/owner/project/${suffix}`),(e: any) => e.code === 'COMMIT_URL_INVALID');
});

test('snapshot Git tree equals native Git including UTF-8 names, binary contents, directories, deletion and executable modes', () => {
  const root = mkdtempSync(join(tmpdir(),'agiledev-tree-'));
  const git = (...args: string[]) => execFileSync('git',args,{ cwd: root,windowsHide: true,encoding: 'utf8',stdio: ['ignore','pipe','ignore'] }).trim();
  try {
    git('init'); git('config','core.autocrlf','false');
    mkdirSync(join(root,'a')); writeFileSync(join(root,'a','nested.txt'),'nested\n'); writeFileSync(join(root,'a.txt'),'before-directory-sort\n');
    writeFileSync(join(root,'unicode-é.txt'),'unicode\n'); writeFileSync(join(root,'binary.bin'),Buffer.from([0,13,10,255])); writeFileSync(join(root,'run.sh'),'exit 0\n');
    if (process.platform !== 'win32') chmodSync(join(root,'run.sh'),0o755);
    git('add','.'); git('update-index','--chmod=+x','run.sh');
    const files = snapshotManifest(root,[],true); const snapshot: Snapshot = { id: 's',workspaceId: 'w',issueId: 'i',candidateId: 'c',root,files,hash: hash(canonical(files)),createdAt: new Date().toISOString() };
    assert.equal(snapshotGitTree(snapshot),git('write-tree'));
    const previous = snapshotGitTree(snapshot); rmSync(join(root,'a.txt')); git('add','-u');
    snapshot.files = snapshotManifest(root,[],true); snapshot.hash = hash(canonical(snapshot.files)); assert.notEqual(snapshotGitTree(snapshot),previous); assert.equal(snapshotGitTree(snapshot),git('write-tree'));
    writeFileSync(join(root,'binary.bin'),Buffer.from([0,13,10,254])); assert.throws(() => snapshotGitTree(snapshot),(e: any) => e.code === 'EVIDENCE_STALE');
  } finally { rmSync(root,{ recursive: true,force: true }); }
});

test('GitHub provider resolves exact commit and nested directory through pinned read endpoints', async () => {
  const calls: string[] = []; const fixtureToken = 'synthetic-test-credential';
  const provider = new GitHubProvider(async (url,init) => {
    calls.push(String(url)); const headers = new Headers(init?.headers); assert.equal(headers.get('x-github-api-version'),githubApiVersion); assert.equal(headers.get('authorization'),`Bearer ${fixtureToken}`); assert.equal(init?.redirect,'error');
    return Response.json(calls.length === 1 ? { sha,tree: { sha: tree } } : { sha: tree,truncated: false,tree: [{ path: 'nested',type: 'tree',mode: '040000',sha: scoped }] });
  },() => fixtureToken);
  assert.deepEqual(await provider.resolve(submission('nested'),new AbortController().signal),{ rootTreeSha: tree,treeSha: scoped });
  assert.deepEqual(calls,[`https://api.github.com/repos/owner/project/git/commits/${sha}`,`https://api.github.com/repos/owner/project/git/trees/${tree}`]);
});

test('provider rejects missing, rate-limited, incomplete and mismatched evidence without exposing response secrets', async () => {
  for (const [status,headers,expected] of [[404,{},'COMMIT_NOT_FOUND'],[401,{},'GITHUB_AUTH_REQUIRED'],[403,{ 'x-ratelimit-remaining': '0' },'GITHUB_RATE_LIMITED'],[503,{},'PROVIDER_UNAVAILABLE']] as const) {
    const provider = new GitHubProvider(async () => new Response('private response must not escape',{ status,headers }),() => undefined);
    await assert.rejects(provider.resolve(submission(),new AbortController().signal),(e: any) => e.code === expected && !e.message.includes('private response'));
  }
  const wrongSha = new GitHubProvider(async () => Response.json({ sha: 'd'.repeat(40),tree: { sha: tree } }),() => undefined);
  await assert.rejects(wrongSha.resolve(submission(),new AbortController().signal),(e: any) => e.code === 'PROVIDER_INVALID_RESPONSE');
  let count = 0; const truncated = new GitHubProvider(async () => Response.json(++count === 1 ? { sha,tree: { sha: tree } } : { sha: tree,truncated: true,tree: [] }),() => undefined);
  await assert.rejects(truncated.resolve(submission('nested'),new AbortController().signal),(e: any) => e.code === 'PROVIDER_INVALID_RESPONSE');
});

test('owner binds the actual selected remote and agents cannot substitute another repository', () => {
  const root = mkdtempSync(join(tmpdir(),'agiledev-bind-')); const store = new Store(':memory:'); const flow = new Workflow(store); const owner = store.bootstrap().actor;
  const git = (...args: string[]) => execFileSync('git',args,{ cwd: root,windowsHide: true,stdio: 'ignore' });
  try {
    git('init'); git('remote','add','origin','git@github.com:Owner/Project.git'); mkdirSync(join(root,'nested'));
    const w = (flow.execute(owner,'workspace_register',{ root: join(root,'nested'),name: 'Nested project',prefix: 'GT',idempotencyKey: 'register' }) as any).workspace;
    const bound = (flow.execute(owner,'workspace_git_bind',{ workspaceId: w.id,idempotencyKey: 'bind' }) as any).binding;
    assert.equal(bound.repository,'owner/project'); assert.equal(bound.subdirectory,'nested');
    const pm = (flow.execute(owner,'actor_enroll',{ workspaceId: w.id,role: 'pm',name: 'PM',idempotencyKey: 'pm' }) as any).actor;
    assert.throws(() => flow.execute(pm,'workspace_git_bind',{ workspaceId: w.id,expectedBindingId: bound.id,idempotencyKey: 'no' }),(e: any) => e.code === 'ROLE_DENIED');
    assert.throws(() => flow.execute(owner,'workspace_git_bind',{ workspaceId: w.id,idempotencyKey: 'stale' }),(e: any) => e.code === 'VERSION_CONFLICT');
    const issue = (flow.execute(owner,'issue_create',{ workspaceId: w.id,title: 'Approved work',description: 'Scope',criteria: ['AC'],idempotencyKey: 'issue' }) as any).issue;
    for (const [operation,args] of [['design_set',{ content: 'Approved scope',criteria: ['AC'] }],['design_submit',{}],['design_decide',{ designId: 'current',decision: 'APPROVED',reason: 'Fixture only' }]] as const) {
      const current = store.get<any>('issue',issue.id);
      flow.execute(owner,operation,{ workspaceId: w.id,issueId: issue.id,expectedVersion: current.version,idempotencyKey: randomUUID(),...args,...(operation === 'design_decide' ? { designId: current.designId } : {}) });
    }
    git('remote','set-url','origin','https://github.com/other/repository.git');
    assert.throws(() => flow.execute(owner,'workspace_git_bind',{ workspaceId: w.id,expectedBindingId: bound.id,idempotencyKey: 'changed' }),(e: any) => e.code === 'REBIND_REQUIRES_SCOPE_RESET');
    const historical = store.get<any>('issue',issue.id); historical.state = 'DONE'; store.put('issue',historical,w.id);
    flow.execute(owner,'workspace_git_bind',{ workspaceId: w.id,expectedBindingId: bound.id,idempotencyKey: 'rebind-after-seeded-history' });
    flow.execute(owner,'issue_transition',{ workspaceId: w.id,issueId: issue.id,expectedVersion: historical.version,action: 'reopen',reason: 'Reopen seeded historical scope after repository change',idempotencyKey: 'reopen' });
    assert.ok(flow.readiness(store.get<any>('issue',issue.id)).blocking.includes('DESIGN_BINDING_STALE'));
  } finally { store.close(); rmSync(root,{ recursive: true,force: true }); }
});

test('initial repository binding cannot inherit an unrelated design approval and draft rebinding preserves a hold', () => {
  const root = mkdtempSync(join(tmpdir(),'agiledev-first-bind-')); const store = new Store(':memory:'); const flow = new Workflow(store); const owner = store.bootstrap().actor;
  const git = (...args: string[]) => execFileSync('git',args,{ cwd: root,windowsHide: true,stdio: 'ignore' });
  const run = (op: string,input: object) => flow.execute(owner,op,{ ...input,idempotencyKey: randomUUID() }) as any;
  try {
    git('init'); git('remote','add','origin','https://github.com/fixture/repository.git');
    const workspace = run('workspace_register',{ root,name: 'Binding fixture',prefix: 'BIND' }).workspace;
    const issue = run('issue_create',{ workspaceId: workspace.id,title: 'Repository scope',description: 'Review the actual repository',criteria: ['SCOPE'] }).issue;
    const change = (op: string,input: object = {}) => run(op,{ workspaceId: workspace.id,issueId: issue.id,expectedVersion: store.get<any>('issue',issue.id).version,...input });
    change('design_set',{ content: 'Implement and review the bound repository',criteria: ['SCOPE'] }); change('design_submit');
    const approved = store.get<any>('issue',issue.id).designId;
    change('design_decide',{ designId: approved,decision: 'APPROVED',reason: 'Automated unbound fixture approval' });
    assert.throws(() => run('workspace_git_bind',{ workspaceId: workspace.id }),(error: any) => error.code === 'REBIND_REQUIRES_SCOPE_RESET');
    assert.equal(store.get<any>('workspace',workspace.id).gitBindingId,undefined); assert.equal(store.list('git_binding',workspace.id).length,0);
    change('design_set',{ content: 'Reset draft before selecting repository',criteria: ['SCOPE'] });
    const oldDraft = store.get<any>('issue',issue.id).designId;
    change('issue_transition',{ action: 'hold',reason: 'Keep reset draft suspended while selecting repository' });
    const binding = run('workspace_git_bind',{ workspaceId: workspace.id }).binding;
    const current = store.get<any>('issue',issue.id); const design = store.get<any>('design',current.designId);
    assert.equal(current.state,'ON_HOLD'); assert.equal(current.designBindingId,binding.id); assert.notEqual(current.designId,oldDraft); assert.equal(design.status,'DRAFT');
    assert.equal(store.get<any>('design',approved).status,'APPROVED'); assert.notEqual(design.hash,store.get<any>('design',oldDraft).hash);
    assert.throws(() => change('design_decide',{ designId: approved,decision: 'APPROVED',reason: 'Old scope cannot approve a new repository' }),(error: any) => error.code === 'APPROVAL_STALE');
  } finally { store.close(); rmSync(root,{ recursive: true,force: true }); }
});

test('interrupted provider read becomes unavailable and is never recovered as verified', () => {
  const store = new Store(':memory:'); const owner = store.bootstrap().actor; const git = { ...submission(),actorId: owner.id,state: 'VERIFYING' as const,currentAttemptId: 'attempt',attempt: 1 };
  const attempt: GitAttempt = { id: 'attempt',submissionId: git.id,workspaceId: git.workspaceId,issueId: git.issueId,attempt: 1,startedAt: new Date().toISOString(),state: 'VERIFYING',apiVersion: githubApiVersion,repository: git.repository,sha: git.sha };
  try {
    store.put('git_submission',git,git.workspaceId); store.put('git_attempt',attempt,git.workspaceId); new GitVerifier(store).recover();
    assert.equal(store.get<GitSubmission>('git_submission',git.id).state,'UNAVAILABLE'); assert.equal(store.get<GitAttempt>('git_attempt',attempt.id).errorCode,'VERIFICATION_COORDINATOR_LOST');
    assert.equal(store.list('delivery_approval').length,0);
  } finally { store.close(); }
});
