import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actor, Candidate, GitSubmission, Issue, Run, Snapshot } from '../src/contracts.js';
import { GitHubProvider, githubApiVersion, snapshotGitTree } from '../src/git.js';
import { GitVerifier } from '../src/git-verifier.js';
import { sealSnapshot, snapshotManifest } from '../src/snapshots.js';
import { Store, canonical, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { acceptanceDigest, integrationManifest } from '../src/qa-policy.js';
import { applyFixturePlan } from './fixtures.js';

const gitAt = (root: string) => (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const blobSha = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const commit = (git: (args: string[]) => string) => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Disposable normalization fixture');
async function until(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Expected state did not arrive'); await new Promise(done => setTimeout(done, 20)); }
}
const seal = (root: string, candidateFiles: string[], destination: string, git: boolean, workspaceId = 'w', issueId = 'i', workerId = 'fixture-worker', sessionId = randomUUID(), runId?: string) => {
  const files = candidateFiles.map(path => ({ path, hash: hash(readFileSync(join(root, path))) }));
  const candidate: Candidate = { id: randomUUID(), workerId, sessionId, designId: 'fixture-design', files, hash: hash(canonical(files)), summary: 'Normalization fixture candidate', executionRoot: root, ...(runId ? { runId } : {}) };
  return { candidate, snapshot: sealSnapshot(candidate, workspaceId, issueId, destination, git) };
};

test('seal normalization records Git blob SHAs under eol=crlf so the committed tree matches', () => {
  const base = mkdtempSync(join(tmpdir(), 'agiledev-eol-attrs-'));
  const root = join(base, 'source'); mkdirSync(root);
  const git = gitAt(root);
  try {
    git('init'); git('config', 'core.autocrlf', 'false');
    writeFileSync(join(root, '.gitattributes'), '*.txt text eol=crlf\n');
    writeFileSync(join(root, 'data.txt'), 'alpha\nbeta\n');
    writeFileSync(join(root, 'plain.bin'), Buffer.from([0, 13, 10, 255]));
    git('add', '-A'); commit(git);
    const headTree = git('rev-parse', 'HEAD^{tree}');
    const worktree = join(base, 'worktree');
    git('worktree', 'add', '--detach', worktree, 'HEAD');
    const checked = readFileSync(join(worktree, 'data.txt'));
    assert.equal(checked.toString('latin1'), 'alpha\r\nbeta\r\n');
    const snapshot = seal(worktree, ['data.txt'], join(base, 'snapshots'), true).snapshot;
    assert.equal(snapshotGitTree(snapshot), headTree);
    const data = snapshot.files.find(file => file.path === 'data.txt')!;
    assert.ok(data.blob);
    assert.notEqual(data.blob, blobSha(checked));
    assert.equal(data.blob, blobSha(Buffer.from('alpha\nbeta\n')));
    const binary = snapshot.files.find(file => file.path === 'plain.bin')!;
    assert.equal(binary.blob, blobSha(readFileSync(join(worktree, 'plain.bin'))));
    const legacyFiles = snapshotManifest(worktree, [], true);
    const legacy: Snapshot = { id: 's', workspaceId: 'w', issueId: 'i', candidateId: 'c', root: worktree, files: legacyFiles, hash: hash(canonical(legacyFiles)), createdAt: new Date().toISOString() };
    assert.notEqual(snapshotGitTree(legacy), headTree);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('seal normalization records Git blob SHAs under core.autocrlf=true', () => {
  const base = mkdtempSync(join(tmpdir(), 'agiledev-autocrlf-'));
  const root = join(base, 'source'); mkdirSync(root);
  const git = gitAt(root);
  try {
    git('init'); git('config', 'core.autocrlf', 'true');
    writeFileSync(join(root, 'data.txt'), 'alpha\r\nbeta\r\n');
    git('add', '-A'); commit(git);
    const headTree = git('rev-parse', 'HEAD^{tree}');
    const snapshot = seal(root, ['data.txt'], join(base, 'snapshots'), true).snapshot;
    assert.equal(snapshotGitTree(snapshot), headTree);
    const data = snapshot.files.find(file => file.path === 'data.txt')!;
    assert.ok(data.blob);
    assert.equal(data.blob, blobSha(Buffer.from('alpha\nbeta\n')));
    assert.notEqual(data.blob, blobSha(readFileSync(join(root, 'data.txt'))));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('seal normalization applies configured clean filters to snapshot blobs', () => {
  const base = mkdtempSync(join(tmpdir(), 'agiledev-filter-'));
  const root = join(base, 'source'); mkdirSync(root);
  const git = gitAt(root);
  try {
    git('init');
    writeFileSync(join(root, '.gitattributes'), '*.data filter=rot13\n');
    const rot13 = 'node -e "var s=\'\';process.stdin.on(\'data\',function(d){s+=d});process.stdin.on(\'end\',function(){process.stdout.write(s.replace(/[A-Za-z]/g,function(c){var b=c.toLowerCase()<=\'m\';return String.fromCharCode(c.charCodeAt(0)+(b?13:-13))}))})"';
    git('config', 'filter.rot13.clean', rot13);
    git('config', 'filter.rot13.smudge', rot13);
    writeFileSync(join(root, 'data.data'), 'hello\n');
    git('add', '-A'); commit(git);
    assert.equal(git('cat-file', '-p', 'HEAD:data.data'), 'uryyb');
    const headTree = git('rev-parse', 'HEAD^{tree}');
    const snapshot = seal(root, ['data.data'], join(base, 'snapshots'), true).snapshot;
    assert.equal(snapshotGitTree(snapshot), headTree);
    const data = snapshot.files.find(file => file.path === 'data.data')!;
    assert.equal(data.blob, git('rev-parse', 'HEAD:data.data'));
    assert.notEqual(data.blob, blobSha(Buffer.from('hello\n')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Git-mode sealing outside a repository is an honest normalization block, never a fallback', () => {
  const base = mkdtempSync(join(tmpdir(), 'agiledev-norepo-'));
  const root = join(base, 'source'); mkdirSync(root);
  try {
    writeFileSync(join(root, 'data.txt'), 'plain\n');
    assert.throws(() => seal(root, ['data.txt'], join(base, 'snapshots'), true), (error: any) => error.code === 'SNAPSHOT_NORMALIZATION_UNAVAILABLE');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

async function multiRepoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-multirepo-'));
  const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'data.txt'), 'alpha\nbeta\n');
  const git = gitAt(source);
  git('init'); git('config', 'core.autocrlf', 'false'); git('add', '-A'); commit(git);
  git('remote', 'add', 'origin', 'https://github.com/fixture/delivery.git');
  const store = new Store(':memory:'); const flow = new Workflow(store); const owner = store.bootstrap().actor;
  const call = (actor: Actor, op: string, input: object) => flow.execute(actor, op, { idempotencyKey: randomUUID(), ...input }) as any;
  const workspace = call(owner, 'workspace_register', { root: source, name: 'Multi-repository closure fixture', prefix: 'MR' }).workspace;
  call(owner, 'workspace_git_bind', { workspaceId: workspace.id });
  const issue = call(owner, 'issue_create', { workspaceId: workspace.id, title: 'Multi-repository delivery', description: 'Verify one commit entry per changed repository', criteria: ['SCOPE'] }).issue;
  const runId = randomUUID();
  const actor: Actor = { id: randomUUID(), role: 'worker', name: 'Fixture worker', principalId: 'fixture-principal', runId, workspaceIds: [workspace.id], sessionId: randomUUID() };
  store.token(actor);
  const run: Run = { id: runId, issueId: issue.id, workspaceId: workspace.id, actorId: 'fixture-principal', harness: 'codex', kind: 'implementation', state: 'SUCCEEDED', version: 1, createdAt: new Date().toISOString(), designId: 'fixture-design', scopeRevision: 1, providerSessionId: 'fixture-provider-session', executionActorId: actor.id, executionRoot: source };
  store.put('run', run, workspace.id);
  const sealed = seal(source, ['data.txt'], join(root, 'snapshots'), true, workspace.id, issue.id, actor.id, actor.sessionId, runId);
  sealed.candidate.snapshotId = sealed.snapshot.id;
  store.put('snapshot', sealed.snapshot, workspace.id);
  const candidate = sealed.candidate;
  store.put('candidate', candidate, workspace.id);
  const current = store.get<Issue>('issue', issue.id); current.candidate = candidate; current.state = 'USER_ACCEPTANCE'; current.lease = null; store.put('issue', current, workspace.id);
  const primarySha = '1'.repeat(40); const secondarySha = '2'.repeat(40); const secondaryTree = '3'.repeat(40);
  const attach = (additionalCommits: { repository: string; commitUrl: string }[] = []) => {
    const state = store.get<Issue>('issue', issue.id);
    return call(owner, 'git_submit', { workspaceId: workspace.id, issueId: issue.id, expectedVersion: state.version, candidateId: candidate.id, commitUrl: `https://github.com/fixture/delivery/commit/${primarySha}`, additionalCommits }).git as GitSubmission;
  };
  const closureBlocked = () => flow.execute(owner, 'issue_get', { workspaceId: workspace.id, issueId: issue.id }).closureBlocked as string[];
  return { root, source, store, flow, owner, workspace, issue, candidate, snapshot: sealed.snapshot, primarySha, secondarySha, secondaryTree, attach, closureBlocked, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('multi-repository verification requires every entry to verify and reports per-entry failure codes', async () => {
  const f = await multiRepoFixture();
  let secondaryFails = true;
  const provider = new GitHubProvider(async (url) => {
    const target = String(url);
    if (target.includes(`/repos/fixture/delivery/git/commits/${f.primarySha}`)) return Response.json({ sha: f.primarySha, tree: { sha: snapshotGitTree(f.snapshot) } });
    if (target.includes(`/repos/fixture/other/git/commits/${f.secondarySha}`)) {
      if (secondaryFails) return new Response('secondary unavailable', { status: 404 });
      return Response.json({ sha: f.secondarySha, tree: { sha: f.secondaryTree } });
    }
    throw new Error(`Unexpected provider request ${target}`);
  }, () => undefined);
  const verifier = new GitVerifier(f.store, provider);
  try {
    const git = f.attach([{ repository: 'fixture/other', commitUrl: `https://github.com/fixture/other/commit/${f.secondarySha}` }]);
    assert.deepEqual(f.store.get<GitSubmission>('git_submission', git.id).entries.map(e => e.repository), ['fixture/delivery', 'fixture/other']);
    assert.ok(f.closureBlocked().includes('GIT_VERIFICATION_PENDING'));
    verifier.tick();
    await until(() => f.store.get<GitSubmission>('git_submission', git.id).state === 'FAILED');
    const failed = f.store.get<GitSubmission>('git_submission', git.id);
    assert.equal(failed.state, 'FAILED'); assert.equal(failed.errorCode, 'COMMIT_NOT_FOUND');
    const firstRound = f.store.list<any>('git_attempt', f.workspace.id).filter((a: any) => a.submissionId === git.id && a.attempt === 1);
    assert.equal(firstRound.length, 2);
    assert.equal(firstRound.find((a: any) => a.entryIndex === 0)!.treeComparison, true);
    assert.equal(firstRound.find((a: any) => a.entryIndex === 1)!.treeComparison, false);
    assert.equal(firstRound.find((a: any) => a.entryIndex === 0)!.evidenceRole, 'snapshot');
    assert.equal(firstRound.find((a: any) => a.entryIndex === 1)!.evidenceRole, 'reference');
    assert.ok(f.closureBlocked().includes('COMMIT_NOT_FOUND'));
    secondaryFails = false;
    f.flow.execute(f.owner, 'git_retry', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: f.store.get<Issue>('issue', f.issue.id).version, submissionId: git.id, idempotencyKey: randomUUID() });
    verifier.tick();
    await until(() => f.store.get<GitSubmission>('git_submission', git.id).state === 'VERIFIED');
    const verified = f.store.get<GitSubmission>('git_submission', git.id);
    assert.equal(verified.state, 'VERIFIED'); assert.equal(verified.attempt, 2); assert.ok(verified.verifiedAt);
    assert.equal(verified.treeSha, snapshotGitTree(f.snapshot));
    const round = f.store.list<any>('git_attempt', f.workspace.id).filter((a: any) => a.submissionId === git.id && a.attempt === 2);
    assert.equal(round.length, 2);
    assert.ok(round.every((a: any) => a.state === 'VERIFIED'));
    const secondary = round.find((a: any) => a.entryIndex === 1)!;
    assert.equal(secondary.treeSha, f.secondaryTree);
    assert.equal(secondary.expectedTreeSha, undefined);
    assert.equal(secondary.evidenceRole, 'reference');
    assert.deepEqual(f.closureBlocked().filter((code: string) => code.startsWith('GIT')), []);
    assert.ok(f.closureBlocked().includes('MULTI_REPOSITORY_CLOSURE_UNSUPPORTED'));
    const complete = f.flow.execute(f.owner, 'delivery_complete', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: f.store.get<Issue>('issue', f.issue.id).version, idempotencyKey: randomUUID() }) as any;
    assert.ok(complete.closureBlocked.includes('MULTI_REPOSITORY_CLOSURE_UNSUPPORTED'));
    assert.equal(complete.issue.state, 'USER_ACCEPTANCE');
  } finally { await verifier.close(); await f.close(); }
});

test('git_submit validates additional commit entries and replays idempotently', async () => {
  const f = await multiRepoFixture();
  const secondaryUrl = `https://github.com/fixture/other/commit/${f.secondarySha}`;
  const submit = (additionalCommits: { repository: string; commitUrl: string }[]) => {
    const issue = f.store.get<Issue>('issue', f.issue.id);
    return f.flow.execute(f.owner, 'git_submit', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: issue.version, candidateId: f.candidate.id, commitUrl: `https://github.com/fixture/delivery/commit/${f.primarySha}`, additionalCommits, idempotencyKey: randomUUID() }) as any;
  };
  try {
    assert.throws(() => submit([{ repository: 'fixture/delivery', commitUrl: secondaryUrl }]), (e: any) => e.code === 'COMMIT_REPOSITORY_MISMATCH');
    assert.throws(() => submit([{ repository: 'fixture/other', commitUrl: `https://github.com/fixture/third/commit/${f.secondarySha}` }]), (e: any) => e.code === 'COMMIT_REPOSITORY_MISMATCH');
    assert.throws(() => submit([{ repository: 'fixture/other', commitUrl: secondaryUrl }, { repository: 'fixture/other', commitUrl: `https://github.com/fixture/other/commit/${'4'.repeat(40)}` }]), (e: any) => e.code === 'COMMIT_REPOSITORY_MISMATCH');
    assert.throws(() => submit([{ repository: 'fixture/other', commitUrl: 'https://github.com/fixture/other/tree/main' }]), (e: any) => e.code === 'COMMIT_URL_INVALID');
    assert.throws(() => submit([{ repository: 'not a repository', commitUrl: secondaryUrl }]), (e: any) => e.code === 'INVALID_INPUT');
    const first = submit([{ repository: 'fixture/other', commitUrl: secondaryUrl }]).git as GitSubmission;
    assert.equal(f.store.get<Issue>('issue', f.issue.id).gitSubmissionId, first.id);
    const replayed = submit([{ repository: 'fixture/other', commitUrl: secondaryUrl }]).git as GitSubmission;
    assert.equal(replayed.id, first.id);
    assert.equal(f.store.list('git_submission', f.workspace.id).length, 1);
  } finally { await f.close(); }
});

test('legacy submission records without entries queue, verify and read normally without migration', async () => {
  const f = await multiRepoFixture();
  const bindingId = f.store.get<any>('workspace', f.workspace.id).gitBindingId;
  const legacy: any = { id: randomUUID(), workspaceId: f.workspace.id, issueId: f.issue.id, candidateId: f.candidate.id, snapshotId: f.snapshot.id, bindingId, repository: 'fixture/delivery', subdirectory: '', sha: f.primarySha, url: `https://github.com/fixture/delivery/commit/${f.primarySha}`, actorId: f.owner.id, createdAt: new Date().toISOString(), state: 'QUEUED', attempt: 0 };
  f.store.put('git_submission', legacy, f.workspace.id);
  const linked = f.store.get<Issue>('issue', f.issue.id); linked.gitSubmissionId = legacy.id; f.store.put('issue', linked, f.workspace.id);
  const provider = new GitHubProvider(async (url) => {
    const target = String(url);
    if (target.includes(`/repos/fixture/delivery/git/commits/${f.primarySha}`)) return Response.json({ sha: f.primarySha, tree: { sha: snapshotGitTree(f.snapshot) } });
    throw new Error(`Unexpected provider request ${target}`);
  }, () => undefined);
  const verifier = new GitVerifier(f.store, provider);
  try {
    verifier.tick();
    await until(() => f.store.get<any>('git_submission', legacy.id).state === 'VERIFIED');
    const stored = f.store.get<any>('git_submission', legacy.id);
    assert.equal(stored.entries, undefined);
    assert.equal(stored.repository, 'fixture/delivery'); assert.equal(stored.sha, f.primarySha); assert.equal(stored.url, `https://github.com/fixture/delivery/commit/${f.primarySha}`);
    assert.equal(stored.state, 'VERIFIED'); assert.ok(stored.verifiedAt); assert.equal(stored.attempt, 1);
    const attempts = f.store.list<any>('git_attempt', f.workspace.id).filter((a: any) => a.submissionId === legacy.id);
    assert.equal(attempts.length, 1); assert.equal(attempts[0]!.repository, 'fixture/delivery'); assert.equal(attempts[0]!.sha, f.primarySha); assert.equal(attempts[0]!.evidenceRole, 'snapshot');
    const view = f.flow.execute(f.owner, 'issue_get', { workspaceId: f.workspace.id, issueId: f.issue.id }) as any;
    assert.equal(view.git.id, legacy.id);
    assert.equal(view.git.entries.length, 1);
    assert.equal(view.git.entries[0].repository, 'fixture/delivery');
    assert.equal(view.git.entries[0].sha, f.primarySha);
    assert.equal(view.git.entries[0].url, `https://github.com/fixture/delivery/commit/${f.primarySha}`);
    assert.equal(view.git.entries[0].attempt.state, 'VERIFIED');
    assert.deepEqual(f.closureBlocked().filter((code: string) => code.startsWith('GIT')), []);
  } finally { await verifier.close(); await f.close(); }
});

async function buildAcceptedLeaf(f: Awaited<ReturnType<typeof multiRepoFixture>>, issueId: string, designId: string, rootDescription: string, options: { digestPolicy?: 2 | 3 | 4; legacySubmission?: boolean } = {}) {
  const s = f.store; const w = f.workspace; const bindingId = s.get<any>('workspace', w.id).gitBindingId;
  const existing = s.get<Issue>('issue', issueId);
  if (!existing.parentId) s.put('design', { id: designId, issueId, content: 'Fixture design', criteria: ['SCOPE'], status: 'APPROVED', hash: 'fixture-design-hash', requirementDescription: rootDescription }, w.id);
  const runId = randomUUID();
  const actor: Actor = { id: randomUUID(), role: 'worker', name: 'Accepted leaf worker', principalId: `principal-${runId}`, runId, workspaceIds: [w.id], sessionId: randomUUID() };
  s.token(actor);
  s.put('run', { id: runId, issueId, workspaceId: w.id, actorId: actor.principalId, harness: 'codex', kind: 'implementation', state: 'SUCCEEDED', version: 1, createdAt: new Date().toISOString(), designId, scopeRevision: 1, providerSessionId: `session-${runId}`, executionActorId: actor.id, executionRoot: f.source }, w.id);
  const sealed = seal(f.source, ['data.txt'], join(f.root, 'snapshots'), true, w.id, issueId, actor.id, actor.sessionId, runId);
  if (options.legacySubmission) {
    sealed.snapshot.files = sealed.snapshot.files.map(({ blob, ...file }) => file);
    sealed.snapshot.hash = hash(canonical(sealed.snapshot.files));
  }
  sealed.candidate.snapshotId = sealed.snapshot.id;
  s.put('snapshot', sealed.snapshot, w.id);
  const candidate = sealed.candidate; candidate.designId = designId;
  if (options.digestPolicy) candidate.digestPolicy = options.digestPolicy;
  s.put('candidate', candidate, w.id);
  const qaRunId = randomUUID();
  s.put('run', { id: qaRunId, issueId, workspaceId: w.id, actorId: actor.principalId, harness: 'dsh', kind: 'qa', state: 'SUCCEEDED', version: 1, createdAt: new Date().toISOString(), designId, scopeRevision: 1, candidateId: candidate.id, snapshotId: sealed.snapshot.id }, w.id);
  const reportId = randomUUID();
  s.put('qa_report', { id: reportId, workspaceId: w.id, issueId, runId: qaRunId, actorId: 'fixture-qa', sessionId: randomUUID(), candidateId: candidate.id, snapshotId: sealed.snapshot.id, verdict: 'PASS', results: [], findings: [], summary: 'Fixture independent QA' }, w.id);
  const review = (stage: string, extra: object = {}) => { const id = randomUUID(); s.put('review', { id, issueId, workspaceId: w.id, actorId: 'fixture-lead', sessionId: randomUUID(), candidateId: candidate.id, snapshotId: sealed.snapshot.id, stage, verdict: 'PASS', reason: 'Fixture review', at: new Date().toISOString(), ...extra }, w.id); return id; };
  const initialReview = review('PRE_QA'); const qaReview = review('QA', { reportId }); const finalReview = review('FINAL');
  const expectedTreeSha = snapshotGitTree(sealed.snapshot);
  const git: any = options.legacySubmission
    ? { id: randomUUID(), workspaceId: w.id, issueId, candidateId: candidate.id, snapshotId: sealed.snapshot.id, bindingId, repository: 'fixture/delivery', subdirectory: '', sha: f.primarySha, url: `https://github.com/fixture/delivery/commit/${f.primarySha}`, actorId: f.owner.id, createdAt: new Date().toISOString(), state: 'VERIFIED', attempt: 1, verifiedAt: new Date().toISOString(), treeSha: expectedTreeSha, expectedTreeSha, rootTreeSha: 'r'.repeat(40) }
    : { id: randomUUID(), workspaceId: w.id, issueId, candidateId: candidate.id, snapshotId: sealed.snapshot.id, bindingId, entries: [{ repository: 'fixture/delivery', subdirectory: '', sha: f.primarySha, url: `https://github.com/fixture/delivery/commit/${f.primarySha}` }], actorId: f.owner.id, createdAt: new Date().toISOString(), state: 'VERIFIED', attempt: 1, verifiedAt: new Date().toISOString(), treeSha: expectedTreeSha, expectedTreeSha, rootTreeSha: 'r'.repeat(40) };
  const attemptId = randomUUID(); git.currentAttemptId = attemptId;
  s.put('git_submission', git, w.id);
  if (options.legacySubmission) s.put('git_attempt', { id: attemptId, submissionId: git.id, workspaceId: w.id, issueId, attempt: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), state: 'VERIFIED', apiVersion: githubApiVersion, repository: 'fixture/delivery', sha: f.primarySha, treeSha: expectedTreeSha, expectedTreeSha, rootTreeSha: expectedTreeSha }, w.id);
  else s.put('git_attempt', { id: attemptId, submissionId: git.id, workspaceId: w.id, issueId, attempt: 1, entryIndex: 0, treeComparison: true, evidenceRole: 'snapshot', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), state: 'VERIFIED', apiVersion: githubApiVersion, repository: 'fixture/delivery', sha: f.primarySha, treeSha: expectedTreeSha, expectedTreeSha, rootTreeSha: expectedTreeSha }, w.id);
  const issue = s.get<Issue>('issue', issueId);
  issue.candidate = candidate; issue.initialReview = initialReview; issue.qaReview = qaReview; issue.finalReview = finalReview; issue.gitSubmissionId = git.id; issue.lease = null; issue.designId = issue.parentId ? issue.designId : designId;
  s.put('issue', issue, w.id);
  return { candidate, snapshot: sealed.snapshot, git, initialReview, qaReview, finalReview, expectedTreeSha, designId };
}

async function acceptedLeaf(f: Awaited<ReturnType<typeof multiRepoFixture>>, designId: string, options: { digestPolicy?: 2 | 3 | 4; legacySubmission?: boolean } = {}) {
  const issue = f.store.get<Issue>('issue', f.issue.id);
  const built = await buildAcceptedLeaf(f, f.issue.id, designId, issue.description, options);
  const acceptAndClose = (digest: string) => {
    const s = f.store;
    const current = s.get<Issue>('issue', f.issue.id); current.acceptedDigest = digest; s.put('issue', current, f.workspace.id);
    s.put('delivery_approval', { id: randomUUID(), issueId: f.issue.id, actorId: f.owner.id, candidateId: current.candidate!.id, digest, decision: 'ACCEPT', reason: 'Fixture human acceptance', at: new Date().toISOString() }, f.workspace.id);
    return f.flow.execute(f.owner, 'delivery_complete', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: s.get<Issue>('issue', f.issue.id).version, idempotencyKey: randomUUID() }) as any;
  };
  return { ...f, built, acceptAndClose };
}

test('pre-upgrade raw-shape records close under the stored digest policy without retry', async () => {
  const f = await acceptedLeaf(await multiRepoFixture(), randomUUID(), { legacySubmission: true });
  try {
    const s = f.store; const issue = s.get<Issue>('issue', f.issue.id); const bindingId = s.get<any>('workspace', f.workspace.id).gitBindingId;
    const storedAttempt = s.list<any>('git_attempt', f.workspace.id).find((a: any) => a.submissionId === f.built.git.id)!;
    assert.equal(storedAttempt.entryIndex, undefined);
    assert.equal(storedAttempt.treeComparison, undefined);
    assert.equal(storedAttempt.evidenceRole, undefined);
    assert.deepEqual(f.closureBlocked().filter((code: string) => code.startsWith('GIT')), []);
    const expected = hash(canonical({ policyVersion: 2, designId: f.built.designId, scopeRevision: issue.scopeRevision, candidateId: f.built.candidate.id, snapshotHash: f.built.snapshot.hash, initialReview: issue.initialReview, qaReview: issue.qaReview, finalReview: issue.finalReview, artifactMode: issue.artifactMode, gitBindingId: bindingId, git: { id: f.built.git.id, bindingId: f.built.git.bindingId, sha: f.built.git.sha, repository: f.built.git.repository, subdirectory: f.built.git.subdirectory } }));
    assert.equal(acceptanceDigest(s, issue), expected);
    assert.equal(f.acceptAndClose(expected).issue.state, 'DONE');
    assert.equal(s.get<any>('git_attempt', storedAttempt.id).entryIndex, undefined);
    const after = f.flow.execute(f.owner, 'issue_get', { workspaceId: f.workspace.id, issueId: f.issue.id }) as any;
    assert.equal(after.issue.state, 'DONE');
    assert.equal(after.git.id, f.built.git.id);
    assert.equal(after.git.entries[0].attempt.state, 'VERIFIED');
    assert.equal(after.git.entries[0].attempt.evidenceRole, 'snapshot');
  } finally { await f.close(); }
});

test('legacy raw-shape attempts normalize in the issue view without persisting new metadata', async () => {
  const f = await acceptedLeaf(await multiRepoFixture(), randomUUID(), { legacySubmission: true });
  try {
    const view = f.flow.execute(f.owner, 'issue_get', { workspaceId: f.workspace.id, issueId: f.issue.id }) as any;
    assert.equal(view.git.entries.length, 1);
    const entry = view.git.entries[0];
    assert.equal(entry.repository, 'fixture/delivery');
    assert.ok(entry.attempt);
    assert.equal(entry.attempt.state, 'VERIFIED');
    assert.equal(entry.attempt.entryIndex, 0);
    assert.equal(entry.attempt.treeComparison, true);
    assert.equal(entry.attempt.evidenceRole, 'snapshot');
    assert.equal(entry.attempt.treeSha, entry.attempt.expectedTreeSha);
    const stored = f.store.get<any>('git_attempt', entry.attempt.id);
    assert.equal(stored.entryIndex, undefined);
    assert.equal(stored.treeComparison, undefined);
    assert.equal(stored.evidenceRole, undefined);
    assert.ok(stored.finishedAt);
    assert.deepEqual(f.closureBlocked().filter((code: string) => code.startsWith('GIT')), []);
  } finally { await f.close(); }
});

test('secondary-entry provider outage keeps the packet unavailable with its entry error code', async () => {
  const f = await multiRepoFixture();
  const provider = new GitHubProvider(async (url) => {
    const target = String(url);
    if (target.includes(`/repos/fixture/delivery/git/commits/${f.primarySha}`)) return Response.json({ sha: f.primarySha, tree: { sha: snapshotGitTree(f.snapshot) } });
    if (target.includes(`/repos/fixture/other/git/commits/${f.secondarySha}`)) return new Response('secondary outage', { status: 503 });
    throw new Error(`Unexpected provider request ${target}`);
  }, () => undefined);
  const verifier = new GitVerifier(f.store, provider);
  try {
    const git = f.attach([{ repository: 'fixture/other', commitUrl: `https://github.com/fixture/other/commit/${f.secondarySha}` }]);
    verifier.tick();
    await until(() => f.store.get<GitSubmission>('git_submission', git.id).state === 'UNAVAILABLE');
    const unavailable = f.store.get<GitSubmission>('git_submission', git.id);
    assert.equal(unavailable.errorCode, 'PROVIDER_UNAVAILABLE');
    assert.ok(f.closureBlocked().includes('PROVIDER_UNAVAILABLE'));
    const round = f.store.list<any>('git_attempt', f.workspace.id).filter((a: any) => a.submissionId === git.id && a.attempt === 1);
    assert.equal(round.find((a: any) => a.entryIndex === 0)!.state, 'VERIFIED');
    assert.equal(round.find((a: any) => a.entryIndex === 1)!.state, 'UNAVAILABLE');
    assert.equal(round.find((a: any) => a.entryIndex === 1)!.errorCode, 'PROVIDER_UNAVAILABLE');
    assert.equal(f.store.get<Issue>('issue', f.issue.id).state, 'USER_ACCEPTANCE');
  } finally { await verifier.close(); await f.close(); }
});

test('new candidates accept and close under digest policy 4', async () => {
  const f = await acceptedLeaf(await multiRepoFixture(), randomUUID(), { digestPolicy: 4 });
  try {
    const s = f.store; const issue = s.get<Issue>('issue', f.issue.id); const bindingId = s.get<any>('workspace', f.workspace.id).gitBindingId;
    const expected = hash(canonical({ policyVersion: 4, designId: f.built.designId, scopeRevision: issue.scopeRevision, candidateId: f.built.candidate.id, snapshotHash: f.built.snapshot.hash, initialReview: issue.initialReview, qaReview: issue.qaReview, finalReview: issue.finalReview, artifactMode: issue.artifactMode, gitBindingId: bindingId, git: { id: f.built.git.id, bindingId: f.built.git.bindingId, entries: f.built.git.entries } }));
    assert.equal(acceptanceDigest(s, issue), expected);
    assert.equal(f.acceptAndClose(expected).issue.state, 'DONE');
  } finally { await f.close(); }
});

test('mixed upgrade records digest stably under the stored legacy policy', async () => {
  const f = await acceptedLeaf(await multiRepoFixture(), randomUUID());
  try {
    const s = f.store; const issue = s.get<Issue>('issue', f.issue.id); const bindingId = s.get<any>('workspace', f.workspace.id).gitBindingId;
    const primary = f.built.git.entries[0];
    const expected = hash(canonical({ policyVersion: 2, designId: f.built.designId, scopeRevision: issue.scopeRevision, candidateId: f.built.candidate.id, snapshotHash: f.built.snapshot.hash, initialReview: issue.initialReview, qaReview: issue.qaReview, finalReview: issue.finalReview, artifactMode: issue.artifactMode, gitBindingId: bindingId, git: { id: f.built.git.id, bindingId: f.built.git.bindingId, sha: primary.sha, repository: primary.repository, subdirectory: primary.subdirectory } }));
    assert.equal(acceptanceDigest(s, issue), expected);
    assert.equal(acceptanceDigest(s, s.get<Issue>('issue', f.issue.id)), expected);
    assert.equal(f.acceptAndClose(expected).issue.state, 'DONE');
  } finally { await f.close(); }
});

test('pre-upgrade accepted children keep parent integration valid', async () => {
  const f = await multiRepoFixture();
  try {
    const s = f.store; const flow = f.flow; const owner = f.owner; const w = f.workspace;
    const call = (op: string, input: object) => flow.execute(owner, op, { idempotencyKey: randomUUID(), ...input }) as any;
    const parent = call('issue_create', { workspaceId: w.id, title: 'Legacy integration parent', description: 'Parent scope over legacy children', criteria: ['SCOPE'] }).issue as Issue;
    const change = (op: string, id: string, input: object = {}) => call(op, { workspaceId: w.id, issueId: id, expectedVersion: s.get<Issue>('issue', id).version, ...input });
    change('design_set', parent.id, { content: 'Assemble the accepted legacy child', criteria: ['SCOPE'] });
    change('design_submit', parent.id);
    change('design_decide', parent.id, { designId: s.get<Issue>('issue', parent.id).designId, decision: 'APPROVED', reason: 'Automated fixture approval' });
    const child = call('issue_create', { workspaceId: w.id, parentId: parent.id, expectedParentVersion: s.get<Issue>('issue', parent.id).version, title: '[Test] Legacy: deliver content -> accepted child', description: 'Legacy child delivered before the digest policy upgrade', criteria: ['SCOPE'] }).issue as Issue;
    const built = await buildAcceptedLeaf(f, child.id, s.get<Issue>('issue', parent.id).designId, s.get<Issue>('issue', parent.id).description, { legacySubmission: true });
    const digest = acceptanceDigest(s, s.get<Issue>('issue', child.id));
    const done = s.get<Issue>('issue', child.id); done.acceptedDigest = digest; done.state = 'DONE'; s.put('issue', done, w.id);
    s.put('delivery_approval', { id: randomUUID(), issueId: child.id, actorId: owner.id, candidateId: built.candidate.id, digest, decision: 'ACCEPT', reason: 'Fixture human acceptance of the legacy child', at: new Date().toISOString() }, w.id);
    applyFixturePlan(flow, owner, parent.id);
    const manifest = integrationManifest(s, s.get<Issue>('issue', parent.id))!;
    assert.equal(manifest.children.length, 1);
    assert.equal(manifest.children[0]!.issueId, child.id);
    assert.equal(manifest.children[0]!.commitUrl, `https://github.com/fixture/delivery/commit/${f.primarySha}`);
    const parentProof = await buildAcceptedLeaf(f, parent.id, s.get<Issue>('issue', parent.id).designId!, s.get<Issue>('issue', parent.id).description, { legacySubmission: true });
    const parentIssue = s.get<Issue>('issue', parent.id); parentIssue.candidate!.integration = manifest;
    s.put('candidate', parentIssue.candidate!, w.id); s.put('issue', parentIssue, w.id);
    const parentDigest = hash(canonical({ policyVersion: 3, designId: parentProof.designId, scopeRevision: parentIssue.scopeRevision, candidateId: parentProof.candidate.id, snapshotHash: parentProof.snapshot.hash, initialReview: parentIssue.initialReview, qaReview: parentIssue.qaReview, finalReview: parentIssue.finalReview, artifactMode: parentIssue.artifactMode, gitBindingId: parentProof.git.bindingId, git: { id: parentProof.git.id, bindingId: parentProof.git.bindingId, sha: parentProof.git.sha, repository: parentProof.git.repository, subdirectory: parentProof.git.subdirectory }, integrationHash: manifest.hash }));
    assert.equal(acceptanceDigest(s, parentIssue), parentDigest);
    assert.equal(acceptanceDigest(s, s.get<Issue>('issue', parent.id)), parentDigest);
  } finally { await f.close(); }
});

async function legacyClosureFixture(mutate?: (git: any, attempt: any) => void) {
  const f = await multiRepoFixture();
  const bindingId = f.store.get<any>('workspace', f.workspace.id).gitBindingId;
  const expectedTreeSha = snapshotGitTree(f.snapshot);
  const git: any = { id: randomUUID(), workspaceId: f.workspace.id, issueId: f.issue.id, candidateId: f.candidate.id, snapshotId: f.snapshot.id, bindingId, repository: 'fixture/delivery', subdirectory: '', sha: f.primarySha, url: `https://github.com/fixture/delivery/commit/${f.primarySha}`, actorId: f.owner.id, createdAt: new Date().toISOString(), state: 'VERIFIED', attempt: 1, verifiedAt: new Date().toISOString(), treeSha: expectedTreeSha, expectedTreeSha, rootTreeSha: 'r'.repeat(40) };
  const attempt: any = { id: randomUUID(), submissionId: git.id, workspaceId: f.workspace.id, issueId: f.issue.id, attempt: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), state: 'VERIFIED', apiVersion: githubApiVersion, repository: 'fixture/delivery', sha: f.primarySha, treeSha: expectedTreeSha, expectedTreeSha, rootTreeSha: 'r'.repeat(40) };
  git.currentAttemptId = attempt.id;
  mutate?.(git, attempt);
  f.store.put('git_submission', git, f.workspace.id);
  f.store.put('git_attempt', attempt, f.workspace.id);
  const issue = f.store.get<Issue>('issue', f.issue.id); issue.gitSubmissionId = git.id; f.store.put('issue', issue, f.workspace.id);
  const closeAttempt = () => f.flow.execute(f.owner, 'delivery_complete', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: f.store.get<Issue>('issue', f.issue.id).version, idempotencyKey: randomUUID() }) as any;
  return { ...f, git, attempt, closeAttempt };
}

test('legacy fallback never grants closure authority to a mismatched attempt identity', async () => {
  for (const mutate of [(git: any, attempt: any) => { attempt.repository = 'other/repository'; }, (git: any, attempt: any) => { attempt.sha = '9'.repeat(40); }]) {
    const f = await legacyClosureFixture(mutate);
    try {
      assert.ok(f.closureBlocked().includes('GIT_EVIDENCE_STALE'));
      const result = f.closeAttempt();
      assert.ok(result.closureBlocked.includes('GIT_EVIDENCE_STALE'));
      assert.equal(result.issue.state, 'USER_ACCEPTANCE');
    } finally { await f.close(); }
  }
});

test('stale candidate, snapshot, or binding mapping stays blocked', async () => {
  for (const mutate of [(git: any) => { git.candidateId = randomUUID(); }, (git: any) => { git.snapshotId = randomUUID(); }, (git: any) => { git.bindingId = randomUUID(); }]) {
    const f = await legacyClosureFixture(mutate);
    try {
      assert.ok(f.closureBlocked().includes('GIT_EVIDENCE_STALE'));
      const result = f.closeAttempt();
      assert.ok(result.closureBlocked.includes('GIT_EVIDENCE_STALE'));
      assert.equal(result.issue.state, 'USER_ACCEPTANCE');
    } finally { await f.close(); }
  }
});

test('malformed legacy records fail closed without crashing', async () => {
  const cases: ((git: any, attempt: any) => void)[] = [
    (git) => { delete git.sha; },
    (git) => { delete git.url; },
    (git, attempt) => { delete attempt.treeSha; },
    (git, attempt) => { delete attempt.repository; }
  ];
  for (const mutate of cases) {
    const f = await legacyClosureFixture(mutate);
    try {
      const view = f.flow.execute(f.owner, 'issue_get', { workspaceId: f.workspace.id, issueId: f.issue.id }) as any;
      assert.equal(view.git.id, f.git.id);
      assert.ok(f.closureBlocked().includes('GIT_EVIDENCE_STALE'));
      const result = f.closeAttempt();
      assert.ok(result.closureBlocked.includes('GIT_EVIDENCE_STALE'));
      assert.equal(result.issue.state, 'USER_ACCEPTANCE');
    } finally { await f.close(); }
  }
});

test('multi-entry packets keep the closure blocker even with unshaped attempts', async () => {
  const f = await multiRepoFixture();
  const bindingId = f.store.get<any>('workspace', f.workspace.id).gitBindingId;
  const expectedTreeSha = snapshotGitTree(f.snapshot);
  const git: any = { id: randomUUID(), workspaceId: f.workspace.id, issueId: f.issue.id, candidateId: f.candidate.id, snapshotId: f.snapshot.id, bindingId, entries: [{ repository: 'fixture/delivery', subdirectory: '', sha: f.primarySha, url: `https://github.com/fixture/delivery/commit/${f.primarySha}` }, { repository: 'fixture/other', subdirectory: '', sha: f.secondarySha, url: `https://github.com/fixture/other/commit/${f.secondarySha}` }], actorId: f.owner.id, createdAt: new Date().toISOString(), state: 'VERIFIED', attempt: 1, verifiedAt: new Date().toISOString(), treeSha: expectedTreeSha, expectedTreeSha, rootTreeSha: 'r'.repeat(40) };
  const attempt: any = { id: randomUUID(), submissionId: git.id, workspaceId: f.workspace.id, issueId: f.issue.id, attempt: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), state: 'VERIFIED', apiVersion: githubApiVersion, repository: 'fixture/delivery', sha: f.primarySha, treeSha: expectedTreeSha, expectedTreeSha, rootTreeSha: 'r'.repeat(40) };
  f.store.put('git_submission', git, f.workspace.id);
  f.store.put('git_attempt', attempt, f.workspace.id);
  const issue = f.store.get<Issue>('issue', f.issue.id); issue.gitSubmissionId = git.id; f.store.put('issue', issue, f.workspace.id);
  try {
    const blocked = f.closureBlocked();
    assert.ok(blocked.includes('MULTI_REPOSITORY_CLOSURE_UNSUPPORTED'));
    assert.ok(blocked.includes('GIT_EVIDENCE_STALE'));
    const result = f.flow.execute(f.owner, 'delivery_complete', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: f.store.get<Issue>('issue', f.issue.id).version, idempotencyKey: randomUUID() }) as any;
    assert.ok(result.closureBlocked.includes('MULTI_REPOSITORY_CLOSURE_UNSUPPORTED'));
    assert.equal(result.issue.state, 'USER_ACCEPTANCE');
  } finally { await f.close(); }
});

test('same-commit git_submit replays the legacy row exactly', async () => {
  const f = await legacyClosureFixture();
  try {
    const issue = f.store.get<Issue>('issue', f.issue.id);
    const result = f.flow.execute(f.owner, 'git_submit', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: issue.version, candidateId: f.candidate.id, commitUrl: `https://github.com/fixture/delivery/commit/${f.primarySha}`, idempotencyKey: randomUUID() }) as any;
    assert.equal(result.git.id, f.git.id);
    assert.equal(f.store.list('git_submission', f.workspace.id).length, 1);
    const stored = f.store.get<any>('git_submission', f.git.id);
    assert.equal(stored.entries, undefined);
    assert.equal(stored.repository, 'fixture/delivery');
  } finally { await f.close(); }
});

test('primary-entry outage reports its code in views and a successful retry clears it', async () => {
  const f = await multiRepoFixture();
  let primaryDown = true;
  const provider = new GitHubProvider(async (url) => {
    const target = String(url);
    if (target.includes(`/repos/fixture/delivery/git/commits/${f.primarySha}`)) {
      if (primaryDown) return new Response('primary outage', { status: 503 });
      return Response.json({ sha: f.primarySha, tree: { sha: snapshotGitTree(f.snapshot) } });
    }
    if (target.includes(`/repos/fixture/other/git/commits/${f.secondarySha}`)) return Response.json({ sha: f.secondarySha, tree: { sha: f.secondaryTree } });
    throw new Error(`Unexpected provider request ${target}`);
  }, () => undefined);
  const verifier = new GitVerifier(f.store, provider);
  try {
    const git = f.attach([{ repository: 'fixture/other', commitUrl: `https://github.com/fixture/other/commit/${f.secondarySha}` }]);
    verifier.tick();
    await until(() => f.store.get<GitSubmission>('git_submission', git.id).state === 'UNAVAILABLE');
    const unavailable = f.store.get<GitSubmission>('git_submission', git.id);
    assert.equal(unavailable.errorCode, 'PROVIDER_UNAVAILABLE');
    const view = f.flow.execute(f.owner, 'issue_get', { workspaceId: f.workspace.id, issueId: f.issue.id }) as any;
    assert.equal(view.git.state, 'UNAVAILABLE');
    assert.equal(view.git.errorCode, 'PROVIDER_UNAVAILABLE');
    assert.equal(view.git.entries[0].attempt.state, 'UNAVAILABLE');
    assert.equal(view.git.entries[1].attempt.state, 'VERIFIED');
    assert.ok(view.closureBlocked.includes('PROVIDER_UNAVAILABLE'));
    primaryDown = false;
    f.flow.execute(f.owner, 'git_retry', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: f.store.get<Issue>('issue', f.issue.id).version, submissionId: git.id, idempotencyKey: randomUUID() });
    verifier.tick();
    await until(() => f.store.get<GitSubmission>('git_submission', git.id).state === 'VERIFIED');
    const verified = f.store.get<GitSubmission>('git_submission', git.id);
    assert.equal(verified.errorCode, undefined);
    assert.ok(verified.verifiedAt);
    assert.equal(verified.attempt, 2);
  } finally { await verifier.close(); await f.close(); }
});

test('a failed entry keeps its error code when another entry is merely unavailable', async () => {
  const f = await multiRepoFixture();
  const provider = new GitHubProvider(async (url) => {
    const target = String(url);
    if (target.includes(`/repos/fixture/delivery/git/commits/${f.primarySha}`)) return Response.json({ sha: f.primarySha, tree: { sha: '9'.repeat(40) } });
    if (target.includes(`/repos/fixture/other/git/commits/${f.secondarySha}`)) return new Response('secondary outage', { status: 503 });
    throw new Error(`Unexpected provider request ${target}`);
  }, () => undefined);
  const verifier = new GitVerifier(f.store, provider);
  try {
    const git = f.attach([{ repository: 'fixture/other', commitUrl: `https://github.com/fixture/other/commit/${f.secondarySha}` }]);
    verifier.tick();
    await until(() => f.store.get<GitSubmission>('git_submission', git.id).state === 'FAILED');
    const failed = f.store.get<GitSubmission>('git_submission', git.id);
    assert.equal(failed.errorCode, 'COMMIT_SNAPSHOT_MISMATCH');
    const round = f.store.list<any>('git_attempt', f.workspace.id).filter((a: any) => a.submissionId === git.id && a.attempt === 1);
    assert.equal(round.find((a: any) => a.entryIndex === 0)!.state, 'FAILED');
    assert.equal(round.find((a: any) => a.entryIndex === 0)!.errorCode, 'COMMIT_SNAPSHOT_MISMATCH');
    assert.equal(round.find((a: any) => a.entryIndex === 1)!.state, 'UNAVAILABLE');
    assert.equal(round.find((a: any) => a.entryIndex === 1)!.errorCode, 'PROVIDER_UNAVAILABLE');
  } finally { await verifier.close(); await f.close(); }
});

test('historical proof projection and idempotent completion retain the stored evidence', async () => {
  const f = await acceptedLeaf(await multiRepoFixture(), randomUUID(), { legacySubmission: true });
  try {
    const s = f.store; const issue = s.get<Issue>('issue', f.issue.id);
    const digest = acceptanceDigest(s, issue); issue.acceptedDigest = digest; s.put('issue', issue, f.workspace.id);
    s.put('delivery_approval', { id: randomUUID(), issueId: issue.id, actorId: f.owner.id, candidateId: issue.candidate!.id, digest, decision: 'ACCEPT', reason: 'Historical fixture acceptance' }, f.workspace.id);
    const beforeGit = canonical(s.get('git_submission', f.built.git.id));
    const beforeAttempt = canonical(s.get('git_attempt', f.built.git.currentAttemptId));
    const input = { workspaceId: f.workspace.id, issueId: issue.id, expectedVersion: issue.version, idempotencyKey: randomUUID() };
    const closed = f.flow.execute(f.owner, 'delivery_complete', input) as any;
    const replayed = f.flow.execute(f.owner, 'delivery_complete', input) as any;
    assert.equal(closed.issue.state, 'DONE'); assert.equal(replayed.replayed, true);
    assert.equal(replayed.issue.version, closed.issue.version);
    assert.equal(s.list('delivery_approval', f.workspace.id).length, 1);
    const view = f.flow.execute(f.owner, 'issue_get', { workspaceId: f.workspace.id, issueId: issue.id }) as any;
    assert.equal(view.git.entries[0].attempt.id, f.built.git.currentAttemptId);
    assert.equal(view.git.entries[0].attempt.evidenceRole, 'snapshot');
    assert.equal(canonical(s.get('git_submission', f.built.git.id)), beforeGit);
    assert.equal(canonical(s.get('git_attempt', f.built.git.currentAttemptId)), beforeAttempt);
    assert.equal(acceptanceDigest(s, s.get<Issue>('issue', issue.id)), digest);
  } finally { await f.close(); }
});

test('only genuine legacy shape and exact current proof identities can clear delivery', async () => {
  for (const legacy of [true, false]) {
    const f = await acceptedLeaf(await multiRepoFixture(), randomUUID(), { legacySubmission: legacy, ...(legacy ? {} : { digestPolicy: 4 }) });
    try {
      const s = f.store; const issue = s.get<Issue>('issue', f.issue.id);
      const digest = acceptanceDigest(s, issue); issue.acceptedDigest = digest; s.put('issue', issue, f.workspace.id);
      s.put('delivery_approval', { id: randomUUID(), issueId: issue.id, actorId: f.owner.id, candidateId: issue.candidate!.id, digest, decision: 'ACCEPT', reason: 'Negative fixture acceptance' }, f.workspace.id);
      const originalGit = s.get<any>('git_submission', f.built.git.id);
      const originalAttempt = s.get<any>('git_attempt', originalGit.currentAttemptId);
      const cases: [string, (git: any, attempt: any) => void][] = [
        ['missing pointer', git => { delete git.currentAttemptId; }],
        ['wrong pointer', git => { git.currentAttemptId = randomUUID(); }],
        ['wrong submission', (_git, attempt) => { attempt.submissionId = randomUUID(); }],
        ['wrong workspace', (_git, attempt) => { attempt.workspaceId = randomUUID(); }],
        ['wrong issue', (_git, attempt) => { attempt.issueId = randomUUID(); }],
        ['wrong attempt round', (_git, attempt) => { attempt.attempt++; }],
        ['wrong submission round', git => { git.attempt++; }],
        ['wrong repository', (_git, attempt) => { attempt.repository = 'fixture/other'; }],
        ['wrong SHA', (_git, attempt) => { attempt.sha = '9'.repeat(40); }],
        ['reference without index', (_git, attempt) => { delete attempt.entryIndex; attempt.treeComparison = false; attempt.evidenceRole = 'reference'; }],
        ['explicit reference', (_git, attempt) => { attempt.entryIndex = 0; attempt.treeComparison = false; attempt.evidenceRole = 'reference'; }],
        ['index only', (_git, attempt) => { attempt.entryIndex = 0; delete attempt.treeComparison; delete attempt.evidenceRole; }],
        ['comparison only', (_git, attempt) => { delete attempt.entryIndex; attempt.treeComparison = true; delete attempt.evidenceRole; }],
        ['role only', (_git, attempt) => { delete attempt.entryIndex; delete attempt.treeComparison; attempt.evidenceRole = 'snapshot'; }]
      ];
      if (legacy) cases.push(
        ['empty entries', git => { git.entries = []; }],
        ['null entries', git => { git.entries = null; }],
        ['modern entry with historical attempt', git => { git.entries = [{ repository: git.repository, subdirectory: git.subdirectory, sha: git.sha, url: git.url }]; }]
      );
      else cases.push(['missing modern metadata', (_git, attempt) => { delete attempt.entryIndex; delete attempt.treeComparison; delete attempt.evidenceRole; }]);
      for (const [name, mutate] of cases) {
        const git = structuredClone(originalGit); const attempt = structuredClone(originalAttempt); mutate(git, attempt);
        s.put('git_submission', git, f.workspace.id); s.put('git_attempt', attempt, f.workspace.id);
        const view = f.flow.execute(f.owner, 'issue_get', { workspaceId: f.workspace.id, issueId: issue.id }) as any;
        assert.ok(view.closureBlocked.includes('GIT_EVIDENCE_STALE'), `${legacy ? 'legacy' : 'modern'}: ${name}`);
        const completed = f.flow.execute(f.owner, 'delivery_complete', { workspaceId: f.workspace.id, issueId: issue.id, expectedVersion: s.get<Issue>('issue', issue.id).version, idempotencyKey: randomUUID() }) as any;
        assert.equal(completed.issue.state, 'USER_ACCEPTANCE', name);
        assert.equal(canonical(s.get('git_attempt', attempt.id)), canonical(attempt), name);
      }
    } finally { await f.close(); }
  }
});

test('verifier callback leaves an accepted parent in USER_ACCEPTANCE until explicit completion', async () => {
  const f = await multiRepoFixture();
  const s = f.store; const flow = f.flow; const owner = f.owner; const w = f.workspace;
  const call = (op: string, input: object) => flow.execute(owner, op, { idempotencyKey: randomUUID(), ...input }) as any;
  const change = (op: string, id: string, input: object = {}) => call(op, { workspaceId: w.id, issueId: id, expectedVersion: s.get<Issue>('issue', id).version, ...input });
  let proofTree = '';
  const verifier = new GitVerifier(s, new GitHubProvider(async () => Response.json({ sha: f.primarySha, tree: { sha: proofTree } }), () => undefined));
  try {
    const parent = call('issue_create', { workspaceId: w.id, title: 'Callback parent', description: 'Parent scope', criteria: ['SCOPE'] }).issue as Issue;
    change('design_set', parent.id, { content: 'Assemble the accepted child', criteria: ['SCOPE'] });
    change('design_submit', parent.id);
    change('design_decide', parent.id, { designId: s.get<Issue>('issue', parent.id).designId, decision: 'APPROVED', reason: 'Fixture approval' });
    const child = call('issue_create', { workspaceId: w.id, parentId: parent.id, expectedParentVersion: s.get<Issue>('issue', parent.id).version, title: '[Test] Callback: deliver content -> accepted child', description: 'Child', criteria: ['SCOPE'] }).issue as Issue;
    const built = await buildAcceptedLeaf(f, child.id, s.get<Issue>('issue', parent.id).designId!, s.get<Issue>('issue', parent.id).description, { legacySubmission: true });
    const childDigest = acceptanceDigest(s, s.get<Issue>('issue', child.id));
    const done = s.get<Issue>('issue', child.id); done.acceptedDigest = childDigest; done.state = 'DONE'; s.put('issue', done, w.id);
    s.put('delivery_approval', { id: randomUUID(), issueId: child.id, actorId: owner.id, candidateId: built.candidate.id, digest: childDigest, decision: 'ACCEPT', reason: 'Fixture child acceptance', at: new Date().toISOString() }, w.id);
    applyFixturePlan(flow, owner, parent.id);
    const manifest = integrationManifest(s, s.get<Issue>('issue', parent.id))!;
    const proof = await buildAcceptedLeaf(f, parent.id, s.get<Issue>('issue', parent.id).designId!, s.get<Issue>('issue', parent.id).description, { digestPolicy: 4 });
    proofTree = snapshotGitTree(proof.snapshot);
    const queued = s.get<any>('git_submission', proof.git.id); queued.state = 'QUEUED'; delete queued.verifiedAt; s.put('git_submission', queued, w.id);
    const p = s.get<Issue>('issue', parent.id); p.candidate!.integration = manifest; p.state = 'USER_ACCEPTANCE'; p.stage = null; s.put('candidate', p.candidate!, w.id); s.put('issue', p, w.id);
    const parentDigest = acceptanceDigest(s, s.get<Issue>('issue', parent.id));
    const accepted = s.get<Issue>('issue', parent.id); accepted.acceptedDigest = parentDigest; s.put('issue', accepted, w.id);
    s.put('delivery_approval', { id: randomUUID(), issueId: parent.id, actorId: owner.id, candidateId: accepted.candidate!.id, digest: parentDigest, decision: 'ACCEPT', reason: 'Fixture parent acceptance', at: new Date().toISOString() }, w.id);
    assert.deepEqual((flow.execute(owner, 'issue_get', { workspaceId: w.id, issueId: parent.id }) as any).closureBlocked, ['GIT_VERIFICATION_PENDING']);
    verifier.tick();
    await until(() => s.get<GitSubmission>('git_submission', proof.git.id).state === 'VERIFIED');
    assert.equal(s.get<Issue>('issue', parent.id).state, 'USER_ACCEPTANCE');
    assert.equal(s.get<Issue>('issue', parent.id).acceptedDigest, parentDigest);
    const events = s.db.prepare('SELECT operation,target_id AS targetId,data FROM events WHERE workspace_id=? ORDER BY sequence').all(w.id) as { operation: string; targetId: string; data: string }[];
    assert.equal(events.some(e => e.operation === 'delivery_closed'), false);
    const finished = events.filter(e => e.operation === 'git_verification_finished' && e.targetId === proof.git.id).map(e => JSON.parse(e.data));
    assert.equal(finished.at(-1).readyToComplete, true); assert.equal(finished.at(-1).issueId, parent.id);
    const approvals = s.list('delivery_approval', w.id).length;
    const closed = change('delivery_complete', parent.id);
    assert.equal(closed.issue.state, 'DONE'); assert.deepEqual(closed.closureBlocked, []);
    assert.equal(s.list('delivery_approval', w.id).length, approvals);
  } finally { await verifier.close(); await f.close(); }
});
