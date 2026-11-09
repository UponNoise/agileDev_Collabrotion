import { randomUUID } from 'node:crypto';
import { Actor, DomainError, GitAttempt, GitSubmission, Issue, Snapshot, Workspace } from './contracts.js';
import { GitHubProvider, GitProvider, githubApiVersion, snapshotGitTree } from './git.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';

export class GitVerifier {
  private active = new Map<string,{ controller: AbortController; promise: Promise<void> }>();
  private timer?: NodeJS.Timeout;
  private closing = false;
  private flow: Workflow;
  constructor(private store: Store,private provider: GitProvider = new GitHubProvider()) { this.flow = new Workflow(store); }
  start() { this.recover(); this.tick(); this.timer = setInterval(() => this.tick(),250); }
  recover() {
    this.store.db.transaction(() => {
      for (const git of this.store.list<GitSubmission>('git_submission').filter(g => g.state === 'VERIFYING')) {
        git.state = 'UNAVAILABLE'; git.errorCode = 'VERIFICATION_COORDINATOR_LOST'; this.store.put('git_submission',git,git.workspaceId);
        for (const attempt of this.store.list<GitAttempt>('git_attempt',git.workspaceId).filter(a => a.submissionId === git.id && a.state === 'VERIFYING')) {
          attempt.state = 'UNAVAILABLE'; attempt.errorCode = git.errorCode; attempt.finishedAt = new Date().toISOString(); this.store.put('git_attempt',attempt,git.workspaceId);
        }
        this.store.event(git.workspaceId,this.store.get<Actor>('actor',git.actorId),'git_verification_interrupted',git.id,{ errorCode: git.errorCode,performedBy: 'git-verifier' });
      }
    }).immediate();
  }
  tick() {
    if (this.closing) return;
    for (const queued of this.store.list<GitSubmission>('git_submission').filter(g => g.state === 'QUEUED')) {
      if (this.active.size >= 2) break;
      const round = this.store.db.transaction(() => {
        const git = this.store.get<GitSubmission>('git_submission',queued.id);
        if (git.state !== 'QUEUED') return [];
        const attempts: GitAttempt[] = git.entries.map((entry,entryIndex) => {
          const attempt: GitAttempt = { id: randomUUID(),submissionId: git.id,workspaceId: git.workspaceId,issueId: git.issueId,attempt: git.attempt + 1,entryIndex,treeComparison: entryIndex === 0,startedAt: new Date().toISOString(),state: 'VERIFYING',apiVersion: githubApiVersion,repository: entry.repository,sha: entry.sha };
          this.store.put('git_attempt',attempt,git.workspaceId);
          return attempt;
        });
        git.state = 'VERIFYING'; git.attempt++; git.currentAttemptId = attempts[0]?.id; git.errorCode = undefined;
        this.store.put('git_submission',git,git.workspaceId);
        this.store.event(git.workspaceId,this.store.get<Actor>('actor',git.actorId),'git_verification_started',git.id,{ attemptIds: attempts.map(a => a.id),entries: git.entries.map(e => ({ repository: e.repository,sha: e.sha })),performedBy: 'git-verifier' });
        return attempts;
      }).immediate();
      if (round.length) {
        const controller = new AbortController();
        const promise = Promise.allSettled(round.map(attempt => this.verify(queued.id,attempt,controller.signal))).then(() => { this.active.delete(queued.id); });
        this.active.set(queued.id,{ controller,promise });
      }
    }
  }
  private async verify(id: string,attempt: GitAttempt,signal: AbortSignal) {
    try {
      const git = this.store.get<GitSubmission>('git_submission',id); const issue = this.store.get<Issue>('issue',git.issueId); const workspace = this.store.get<Workspace>('workspace',git.workspaceId);
      if (issue.gitSubmissionId !== id || issue.candidate?.id !== git.candidateId || issue.candidate?.snapshotId !== git.snapshotId || workspace.gitBindingId !== git.bindingId) throw new DomainError('GIT_EVIDENCE_STALE','Git mapping no longer belongs to the current delivery');
      const entry = git.entries[attempt.entryIndex];
      if (!entry || entry.repository !== attempt.repository || entry.sha !== attempt.sha) throw new DomainError('GIT_EVIDENCE_STALE','Git attempt does not match the submitted commit entry');
      const snapshot = this.store.get<Snapshot>('snapshot',git.snapshotId);
      if (attempt.treeComparison) {
        attempt.expectedTreeSha = snapshotGitTree(snapshot);
        const result = await this.provider.resolve(git,AbortSignal.any([signal,AbortSignal.timeout(30000)]));
        attempt.rootTreeSha = result.rootTreeSha; attempt.treeSha = result.treeSha;
        if (!/^[a-f0-9]{40}$/.test(result.rootTreeSha) || result.treeSha !== attempt.expectedTreeSha) throw new DomainError('COMMIT_SNAPSHOT_MISMATCH','Commit tree differs from the complete reviewed snapshot');
        if (snapshotGitTree(snapshot) !== attempt.expectedTreeSha) throw new DomainError('EVIDENCE_STALE','Snapshot changed during remote verification');
      } else {
        const result = await this.provider.resolveEntry(entry.repository,entry.sha,entry.subdirectory,AbortSignal.any([signal,AbortSignal.timeout(30000)]));
        attempt.rootTreeSha = result.rootTreeSha; attempt.treeSha = result.treeSha;
      }
      attempt.state = 'VERIFIED';
    } catch (error) {
      attempt.errorCode = error instanceof DomainError ? error.code : 'PROVIDER_UNAVAILABLE';
      attempt.state = attempt.errorCode === 'GIT_EVIDENCE_STALE' ? 'STALE' : ['PROVIDER_UNAVAILABLE','VERIFICATION_INTERRUPTED','GITHUB_RATE_LIMITED','GITHUB_AUTH_REQUIRED','GITHUB_ACCESS_DENIED'].includes(attempt.errorCode) ? 'UNAVAILABLE' : 'FAILED';
    } finally {
      try {
        if (this.store.db.open) { attempt.finishedAt = new Date().toISOString(); this.flow.completeGit(attempt); }
      }
      catch { process.stderr.write('Git verification result could not be persisted; recover the daemon before retrying this read.\n'); }
    }
  }
  async close() {
    this.closing = true; if (this.timer) clearInterval(this.timer);
    for (const value of this.active.values()) value.controller.abort();
    await Promise.allSettled([...this.active.values()].map(value => value.promise));
  }
}
