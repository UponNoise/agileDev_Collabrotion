import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actor, Candidate, GitSubmission, Issue, Run, Snapshot } from '../src/contracts.js';
import { GitHubProvider, snapshotGitTree } from '../src/git.js';
import { GitVerifier } from '../src/git-verifier.js';
import { sealSnapshot, snapshotManifest } from '../src/snapshots.js';
import { Store, canonical, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';

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
    assert.deepEqual(f.closureBlocked().filter((code: string) => code.startsWith('GIT')), []);
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
