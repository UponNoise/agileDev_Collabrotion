import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DomainError, GitAttempt, GitBinding, GitSubmission, Snapshot, Workspace } from './contracts.js';
import { inside } from './paths.js';
import { cleanGitEnv, verifySnapshot } from './snapshots.js';

export const githubApiVersion = '2026-03-10';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const validRepository = (value: string) => repositoryPattern.test(value) && !['.','..'].includes(value.split('/')[1]!);

export function githubRepository(remote: string) {
  let path: string;
  const ssh = remote.match(/^git@github\.com:([^\s?#]+)$/);
  if (ssh) path = ssh[1]!;
  else {
    let url: URL;
    try { url = new URL(remote); } catch { throw new DomainError('UNSUPPORTED_PROVIDER','Bind a GitHub.com HTTPS or SSH remote'); }
    if (url.hostname !== 'github.com' || url.port || url.search || url.hash || !['https:','ssh:'].includes(url.protocol) || url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) throw new DomainError('UNSUPPORTED_PROVIDER','Only credential-free GitHub.com remote addresses are supported');
    path = url.pathname.slice(1);
  }
  path = path.replace(/\.git$/,'');
  if (!validRepository(path)) throw new DomainError('REPOSITORY_INVALID','Remote must identify one GitHub owner/repository');
  return path.toLowerCase();
}
export function githubCommitUrl(value: string) {
  const match = value.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+)\/commit\/([a-fA-F0-9]{40})$/);
  if (!match || !validRepository(match[1]!)) throw new DomainError('COMMIT_URL_INVALID','Use https://github.com/owner/repository/commit/ followed by the full 40-character SHA, without a query or fragment');
  const repository = match[1]!.toLowerCase(); const commitSha = match[2]!.toLowerCase();
  return { repository,sha: commitSha,url: `https://github.com/${repository}/commit/${commitSha}` };
}
export function submissionEntries(submission: { entries?: { repository: string; subdirectory?: string; sha: string; url?: string }[]; repository?: string; subdirectory?: string; sha?: string; url?: string }): { repository: string; subdirectory: string; sha: string; url: string }[] {
  if (submission.entries?.length) return submission.entries.map(entry => ({ repository: entry.repository,subdirectory: entry.subdirectory ?? '',sha: entry.sha,url: entry.url ?? `https://github.com/${entry.repository}/commit/${entry.sha}` }));
  if (submission.repository && submission.sha && submission.url) return [{ repository: submission.repository,subdirectory: submission.subdirectory ?? '',sha: submission.sha,url: submission.url }];
  return [];
}
export function normalizeLegacyAttempt<T extends Partial<GitAttempt>>(attempt: T, submission: Pick<GitSubmission, 'id' | 'workspaceId' | 'issueId' | 'attempt' | 'currentAttemptId'> & { entries?: unknown; repository?: string; sha?: string; url?: string }): T {
  if (!Object.hasOwn(submission,'entries') && !['entryIndex','treeComparison','evidenceRole'].some(key => Object.hasOwn(attempt,key)) &&
    submission.id && submission.workspaceId && submission.issueId && submission.repository && submission.sha && submission.url &&
    Number.isSafeInteger(submission.attempt) && submission.attempt > 0 && submission.currentAttemptId &&
    attempt.id === submission.currentAttemptId && attempt.submissionId === submission.id && attempt.attempt === submission.attempt &&
    attempt.workspaceId === submission.workspaceId && attempt.issueId === submission.issueId &&
    attempt.repository === submission.repository && attempt.sha === submission.sha) return { ...attempt,entryIndex: 0,treeComparison: true,evidenceRole: 'snapshot' };
  return attempt;
}
export function inspectGitBinding(workspace: Workspace, remote: string, actorId: string): GitBinding {
  if (!workspace.commonDir) throw new DomainError('GIT_WORKSPACE_REQUIRED','Register a Git workspace before binding its remote');
  const env = cleanGitEnv();
  const git = (args: string[]) => execFileSync('git',args,{ cwd: workspace.root,env,windowsHide: true,timeout: 5000,maxBuffer: 1048576,encoding: 'utf8',stdio: ['ignore','pipe','ignore'] }).replace(/\r?\n$/,'');
  try {
    const common = realpathSync(resolve(workspace.root,git(['rev-parse','--git-common-dir'])));
    if (common !== workspace.commonDir) throw new DomainError('WORKSPACE_IDENTITY_CHANGED','The registered Git repository changed; repair the workspace binding first');
    const repository = githubRepository(git(['remote','get-url',remote]));
    const subdirectory = git(['rev-parse','--show-prefix']).replace(/\/$/,'');
    if (subdirectory.split('/').some(p => p === '..' || p === '.') || subdirectory.includes('\0')) throw new DomainError('WORKSPACE_IDENTITY_CHANGED','Invalid repository-relative workspace directory');
    return { id: randomUUID(),workspaceId: workspace.id,repository,subdirectory,remote,actorId,createdAt: new Date().toISOString() };
  } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('GIT_BINDING_UNAVAILABLE','Cannot read the selected Git remote and registered workspace identity'); }
}
const objectId = (kind: 'blob' | 'tree',content: Buffer) => createHash('sha1').update(`${kind} ${content.length}\0`).update(content).digest('hex');
interface Tree { files: Map<string,{ mode: string; sha: string }>; directories: Map<string,Tree> }
export function snapshotGitTree(snapshot: Snapshot) {
  verifySnapshot(snapshot);
  const root: Tree = { files: new Map(),directories: new Map() };
  for (const file of snapshot.files) {
    const parts = file.path.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\0') || p.includes('\\')) || !['100644','100755'].includes(file.mode)) throw new DomainError('ARTIFACT_POLICY','Git delivery requires regular file paths and executable modes');
    let tree = root;
    for (const part of parts.slice(0,-1)) {
      if (tree.files.has(part)) throw new DomainError('ARTIFACT_POLICY','File/directory collision in snapshot');
      if (!tree.directories.has(part)) tree.directories.set(part,{ files: new Map(),directories: new Map() });
      tree = tree.directories.get(part)!;
    }
    const name = parts.at(-1)!;
    if (tree.files.has(name) || tree.directories.has(name)) throw new DomainError('ARTIFACT_POLICY','Duplicate snapshot path');
    tree.files.set(name,{ mode: file.mode,sha: file.blob ?? objectId('blob',readFileSync(inside(snapshot.root,file.path))) });
  }
  const encode = (tree: Tree): string => {
    const entries = [...tree.files].map(([name,file]) => ({ name,...file,sort: Buffer.from(name) }));
    for (const [name,child] of tree.directories) entries.push({ name,mode: '40000',sha: encode(child),sort: Buffer.from(`${name}/`) });
    entries.sort((a,b) => Buffer.compare(a.sort,b.sort));
    return objectId('tree',Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`),Buffer.from(e.sha,'hex')]))));
  };
  const result = encode(root); verifySnapshot(snapshot); return result;
}
export interface GitResolution { rootTreeSha: string; treeSha: string }
export interface GitProvider {
  resolve(submission: GitSubmission, signal: AbortSignal): Promise<GitResolution>;
  resolveEntry(repository: string, sha: string, subdirectory: string, signal: AbortSignal): Promise<GitResolution>;
}
export class GitHubProvider implements GitProvider {
  constructor(private request: typeof fetch = fetch,private token = () => process.env.AGILEDEV_GITHUB_TOKEN) {}
  private async json(path: string,signal: AbortSignal): Promise<unknown> {
    const credential = this.token();
    try {
      const response = await this.request(`https://api.github.com${path}`,{ redirect: 'error',signal: AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers: { Accept: 'application/vnd.github+json','User-Agent': 'agiledev-collaboration/0.1.0','X-GitHub-Api-Version': githubApiVersion,...(credential ? { Authorization: `Bearer ${credential}` } : {}) } });
      if (!response.ok) {
        await response.body?.cancel();
        const code = response.status === 404 ? 'COMMIT_NOT_FOUND' : response.status === 401 ? 'GITHUB_AUTH_REQUIRED' : response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) ? 'GITHUB_RATE_LIMITED' : response.status === 403 ? 'GITHUB_ACCESS_DENIED' : response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REQUEST_FAILED';
        throw new DomainError(code,'GitHub did not provide verifiable commit evidence');
      }
      if (Number(response.headers.get('content-length') ?? 0) > 8388608) { await response.body?.cancel(); throw new DomainError('PROVIDER_RESPONSE_LIMIT','GitHub response exceeds the verification limit'); }
      const reader = response.body?.getReader(); if (!reader) throw new DomainError('PROVIDER_INVALID_RESPONSE','GitHub returned no evidence body');
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 8388608) { await reader.cancel(); throw new DomainError('PROVIDER_RESPONSE_LIMIT','GitHub response exceeds the verification limit'); } chunks.push(part.value); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DomainError('PROVIDER_INVALID_RESPONSE','GitHub returned an invalid evidence body'); }
    } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError(signal.aborted ? 'VERIFICATION_INTERRUPTED' : 'PROVIDER_UNAVAILABLE','GitHub verification is unavailable; retain acceptance and retry later'); }
  }
  async resolve(submission: GitSubmission,signal: AbortSignal) {
    const primary = submissionEntries(submission)[0];
    if (!primary) throw new DomainError('REPOSITORY_INVALID','Verification requires at least one commit entry');
    return this.resolveEntry(primary.repository,primary.sha,primary.subdirectory,signal);
  }
  async resolveEntry(repository: string,commitSha: string,subdirectory: string,signal: AbortSignal) {
    if (!validRepository(repository) || !sha.safeParse(commitSha).success) throw new DomainError('REPOSITORY_INVALID','Verification requires a bound GitHub repository and immutable SHA');
    const prefix = `/repos/${repository}/git`;
    const commit = z.object({ sha,tree: z.object({ sha }) }).safeParse(await this.json(`${prefix}/commits/${commitSha}`,signal));
    if (!commit.success || commit.data.sha !== commitSha) throw new DomainError('PROVIDER_INVALID_RESPONSE','GitHub commit does not match the requested SHA');
    const rootTreeSha = commit.data.tree.sha; let treeSha = rootTreeSha;
    for (const directory of subdirectory.split('/').filter(Boolean)) {
      if (directory === '.' || directory === '..') throw new DomainError('REPOSITORY_INVALID','Invalid workspace directory');
      const tree = z.object({ sha,truncated: z.literal(false),tree: z.array(z.object({ path: z.string(),type: z.string(),mode: z.string(),sha })) }).safeParse(await this.json(`${prefix}/trees/${treeSha}`,signal));
      if (!tree.success || tree.data.sha !== treeSha) throw new DomainError('PROVIDER_INVALID_RESPONSE','GitHub returned incomplete tree evidence');
      const matches = tree.data.tree.filter(entry => entry.path === directory);
      if (matches.length !== 1 || matches[0]!.type !== 'tree' || matches[0]!.mode !== '040000') throw new DomainError('COMMIT_SNAPSHOT_MISMATCH','Commit does not contain the registered workspace directory');
      treeSha = matches[0]!.sha;
    }
    return { rootTreeSha,treeSha };
  }
}
