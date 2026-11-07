import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { inside } from './paths.js';
export { inside } from './paths.js';
import { Actor, CheckProfile, CheckRun, Design, DomainError, GitAttempt, GitBinding, GitSubmission, Grant, Issue, Operation, QaReport, Run, Workspace, liveRunStates, schemas } from './contracts.js';
import { canonical, hash, Store } from './store.js';
import { acceptanceDigest, candidateSnapshot, queueQa, validateQaReport } from './qa-policy.js';
import { githubCommitUrl, inspectGitBinding } from './git.js';
import { workspaceView,issueView,runsView } from './web-views.js';

const readOps = new Set(['workspace_list', 'connection_list', 'issue_get', 'issue_list', 'run_get', 'run_list', 'gap_list', 'event_list','check_profile_list','qa_check_get','evidence_get','ui_workspace','ui_issue','ui_runs','grant_list']);
function requireRole(actor: Actor, ...allowed: Actor['role'][]) {
  if (!allowed.includes(actor.role)) throw new DomainError('ROLE_DENIED', `Operation requires ${allowed.join(' or ')} authority`, 403);
}
function version(issue: Issue, expected: number) {
  if (issue.version !== expected) throw new DomainError('VERSION_CONFLICT', 'Issue changed; reload before retrying', 409, { currentVersion: issue.version });
}
export class Workflow {
  constructor(readonly store: Store, readonly now = () => Date.now()) {}
  execute(actor: Actor, operation: string, input: unknown): unknown {
    if (!(operation in schemas)) throw new DomainError('UNKNOWN_OPERATION', 'Unknown operation', 404);
    const op = operation as Operation;
    const parsed = schemas[op].safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Command failed schema validation', 400, parsed.error.flatten());
    const args = parsed.data as Record<string, any>;
    if (readOps.has(op)) return this.read(actor, op, args);
    const digest = hash(canonical({ op, args }));
    return this.store.db.transaction(() => {
      const existing = this.store.db.prepare('SELECT digest,result FROM receipts WHERE actor_id=? AND key=?').get(actor.id, args.idempotencyKey) as { digest: string; result: string } | undefined;
      if (existing) {
        if (existing.digest !== digest) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Key was already used with different input');
        return { ...JSON.parse(existing.result), replayed: true };
      }
      const result = this.mutate(actor, op, args);
      const receipt = { ...result };
      delete receipt.token;
      this.store.db.prepare('INSERT INTO receipts(actor_id,key,digest,result) VALUES(?,?,?,?)').run(actor.id, args.idempotencyKey, digest, JSON.stringify(receipt));
      return result;
    }).immediate();
  }
  private read(actor: Actor, op: Operation, a: Record<string, any>): unknown {
    const s = this.store;
    if (op === 'workspace_list') return { workspaces: s.list<Workspace>('workspace').filter(w => actor.role === 'human' || actor.workspaceIds.includes(w.id)) };
    const workspace = s.workspace(actor, a.workspaceId);
    if (op.startsWith('ui_')) {
      requireRole(actor,'human');
      if (op === 'ui_workspace') return workspaceView(s,workspace,a,issue => this.display(issue));
      if (op === 'ui_runs') return runsView(s,workspace.id,a);
      const issue = s.issue(actor,workspace.id,a.issueId);
      return { ...this.read(actor,'issue_get',a) as object,...issueView(s,issue,a) };
    }
    if (op === 'grant_list') {
      requireRole(actor,'human','lead','pm');
      const issue = s.issue(actor,a.workspaceId,a.issueId);
      const grants = s.list<Grant>('grant',a.workspaceId).filter(g => g.issueId === issue.id && (actor.role === 'human' || g.granteeId === actor.id)).reverse();
      return { grants: grants.slice(a.offset,a.offset+a.limit).map(g => ({ ...g,status: this.grantStatus(g,issue) })),total: grants.length,nextOffset: a.offset+a.limit < grants.length ? a.offset+a.limit : null };
    }
    if (op === 'check_profile_list') return { profiles: s.list<CheckProfile>('check_profile',a.workspaceId) };
    if (op === 'qa_check_get') {
      const check = s.get<CheckRun>('check',a.checkId); s.issue(actor,a.workspaceId,check.issueId);
      if (check.workspaceId !== a.workspaceId || (actor.role === 'qa' && check.runId !== actor.runId && check.actorId !== actor.id)) throw new DomainError('SCOPE_DENIED','Check belongs to another QA execution',403);
      return { check };
    }
    if (op === 'connection_list') {
      requireRole(actor, 'human', 'lead', 'pm');
      return { connections: s.list('connection', a.workspaceId) };
    }
    const issues = s.list<Issue>('issue', a.workspaceId).filter(i => !['worker','qa'].includes(actor.role) || ((actor.role === 'worker' ? i.assignee : i.qaAssignee) === (actor.principalId ?? actor.id) && (!actor.runId || s.get<Run>('run', actor.runId).issueId === i.id)));
    if (op === 'issue_get') {
      const issue = s.issue(actor, a.workspaceId, a.issueId);
      let deliveryDigest: string | null = null;
      if (issue.state === 'USER_ACCEPTANCE') { try { deliveryDigest = acceptanceDigest(s,issue); } catch {} }
      const git = issue.gitSubmissionId ? s.get<GitSubmission>('git_submission',issue.gitSubmissionId) : null;
      return { issue: this.display(issue), readiness: this.readiness(issue), nextActions: this.nextActions(actor, issue), deliveryDigest, git, closureBlocked: issue.state === 'USER_ACCEPTANCE' ? this.closureBlockers(issue) : [],...(['human','lead','pm'].includes(actor.role) ? { authorizationScopeHash: this.grantScope(issue) } : {}) };
    }
    if (op === 'evidence_get') {
      const issue = s.issue(actor,a.workspaceId,a.issueId); const evidence = s.get<any>(a.kind,a.evidenceId);
      const bindingAllowed = a.kind === 'git_binding' && (s.get<Workspace>('workspace',a.workspaceId).gitBindingId === evidence.id || (issue.gitSubmissionId && s.get<GitSubmission>('git_submission',issue.gitSubmissionId).bindingId === evidence.id));
      if ((!bindingAllowed && evidence.issueId !== a.issueId) || (evidence.workspaceId && evidence.workspaceId !== a.workspaceId)) throw new DomainError('SCOPE_DENIED','Evidence belongs to another issue',403);
      return { evidence };
    }
    if (op === 'issue_list') {
      const filtered = issues.filter(i => !a.state || i.state === a.state);
      return { issues: filtered.slice(a.offset, a.offset + a.limit).map(i => this.display(i)), total: filtered.length, nextOffset: a.offset + a.limit < filtered.length ? a.offset + a.limit : null };
    }
    if (op === 'gap_list') return { gaps: issues.filter(i => !['DONE','ABANDONED'].includes(i.state)).flatMap(i => [...new Set([...this.readiness(i).blocking,...(i.state === 'USER_ACCEPTANCE' ? this.closureBlockers(i) : [])])].map(code => ({ issueId: i.id, key: i.key, code, severity: 'blocking' })).concat(i.plannedStart ? [] : [{ issueId: i.id, key: i.key, code: 'SCHEDULE_UNSET', severity: 'advisory' }] )) };
    if (op === 'event_list') {
      requireRole(actor, 'human', 'lead', 'pm');
      return { events: s.db.prepare('SELECT sequence,actor_id AS actorId,operation,target_id AS targetId,data,at FROM events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(a.workspaceId, a.after, a.limit).map((r: any) => ({ ...r, data: JSON.parse(r.data) })) };
    }
    const runs = s.list<Run>('run', a.workspaceId).filter(r => !['worker','qa'].includes(actor.role) || (r.actorId === (actor.principalId ?? actor.id) && (!actor.runId || r.id === actor.runId)));
    if (op === 'run_list') return { runs: runs.slice(-a.limit).reverse() };
    const run = runs.find(r => r.id === a.runId);
    if (!run) throw new DomainError('NOT_FOUND', 'Run not found', 404);
    return { run };
  }
  private display(issue: Issue) {
    const title = issue.parentId ? `${this.store.get<Issue>('issue', issue.parentId).title}——${issue.title}` : issue.title;
    return { ...issue, title, titleSuffix: issue.title, url: `/w/${issue.workspaceId}/issues/${issue.id}` };
  }
  private nextActions(actor: Actor, i: Issue): string[] {
    if (i.state === 'NOT_STARTED' && actor.role === 'worker' && !this.readiness(i).blocking.length) return ['work_claim'];
    if (i.state === 'IN_PROGRESS' && i.lease?.actorId === actor.id) return ['work_heartbeat', 'work_submit'];
    if (i.state === 'LEAD_REVIEW' && actor.role === 'lead') return ['review_submit'];
    if (i.state === 'QA_TEST' && actor.role === 'qa') return ['qa_check_run', 'qa_check_get', 'qa_report_submit'];
    if (i.state === 'USER_ACCEPTANCE' && ['human','lead','pm'].includes(actor.role)) return [...(actor.role === 'human' ? ['delivery_decide'] : []),'git_submit','git_retry','delivery_complete'];
    return [];
  }
  design(issue: Issue): Design | null {
    const root = issue.parentId ? this.store.get<Issue>('issue', issue.parentId) : issue;
    return root.designId ? this.store.get<Design>('design', root.designId) : null;
  }
  readiness(i: Issue) {
    const blocking: string[] = [];
    const workspace = this.store.get<Workspace>('workspace',i.workspaceId); const root = i.parentId ? this.store.get<Issue>('issue',i.parentId) : i;
    if (i.artifactMode !== 'artifact' && root.designBindingId && root.designBindingId !== workspace.gitBindingId) blocking.push('DESIGN_BINDING_STALE');
    if (this.design(i)?.status !== 'APPROVED') blocking.push('DESIGN_APPROVAL_REQUIRED');
    if (!i.assignee) blocking.push('ASSIGNEE_REQUIRED');
    if (!i.criteria.length) blocking.push('CRITERIA_REQUIRED');
    if (!i.description.trim()) blocking.push('SCOPE_REQUIRED');
    if (i.state === 'ON_HOLD' || (i.parentId && this.store.get<Issue>('issue', i.parentId).state === 'ON_HOLD')) blocking.push('ON_HOLD');
    if (i.dependencies.some(id => this.store.get<Issue>('issue', id).state !== 'DONE')) blocking.push('DEPENDENCY_BLOCKED');
    if (this.store.list<Issue>('issue', i.workspaceId).some(child => child.parentId === i.id && child.state !== 'DONE')) blocking.push('CHILDREN_INCOMPLETE');
    const d = this.design(i);
    if (d && d.requirementDescription !== root.description) blocking.push('DESIGN_SCOPE_STALE');
    if (d && i.criteria.some(c => !d.criteria.includes(c))) blocking.push('CRITERIA_UNMAPPED');
    return { ready: blocking.length === 0, blocking };
  }
  private save(actor: Actor, op: string, i: Issue, data: unknown = {}) {
    const before = this.store.get<Issue>('issue', i.id);
    i.version++;
    this.store.put('issue', i, i.workspaceId);
    const changes = Object.fromEntries(Object.entries(i).filter(([key, value]) => canonical(value) !== canonical((before as any)[key])).map(([key, value]) => [key, { before: (before as any)[key], after: value }]));
    this.store.event(i.workspaceId, actor, op, i.id, { version: i.version, state: i.state, stage: i.stage, changes, ...data as object });
    return { issue: this.display(i) };
  }
  private invalidate(i: Issue) {
    i.candidate = null; i.initialReview = null; i.qaReview = null; i.finalReview = null; i.lease = null; i.stage = null; i.acceptedDigest = undefined; i.gitSubmissionId = undefined;
    if (i.state === 'ON_HOLD') i.savedState = { state: 'NOT_STARTED',stage: null };
    else if (!['NOT_STARTED', 'ABANDONED'].includes(i.state)) i.state = 'NOT_STARTED';
  }
  private draftDesign(actor: Actor, issue: Issue, content: string, criteria: string[]) {
    const workspace = this.store.get<Workspace>('workspace',issue.workspaceId);
    issue.designBindingId = issue.artifactMode === 'artifact' ? undefined : workspace.gitBindingId;
    const normalized = [...new Set(criteria)];
    const design: Design = { id: randomUUID(),issueId: issue.id,content,criteria: normalized,status: 'DRAFT',requirementDescription: issue.description,hash: hash(canonical({ content,criteria: normalized,requirementDescription: issue.description,artifactMode: issue.artifactMode,artifactReason: issue.artifactReason,gitBindingId: issue.designBindingId })) };
    this.store.put('design',design,issue.workspaceId); issue.designId = design.id; issue.criteria = design.criteria; this.invalidate(issue);
    for (const child of this.store.list<Issue>('issue',issue.workspaceId).filter(c => c.parentId === issue.id && c.state !== 'ABANDONED')) { this.invalidate(child); this.save(actor,'design_invalidated',child,{ designId: design.id }); }
    return design;
  }
  private grantScope(issue: Issue) {
    const scope = (i: Issue) => ({ id: i.id,scopeRevision: i.scopeRevision,description: i.description,criteria: i.criteria,artifactMode: i.artifactMode,artifactReason: i.artifactReason });
    return hash(canonical({ issue: scope(issue),designId: this.design(issue)?.id ?? null,gitBindingId: issue.designBindingId,children: this.store.list<Issue>('issue',issue.workspaceId).filter(i => i.parentId === issue.id).map(scope).sort((a,b) => a.id.localeCompare(b.id)) }));
  }
  private grantStatus(grant: Grant, issue: Issue) {
    if (grant.revokedAt !== undefined) return 'REVOKED';
    if (Date.parse(grant.expiresAt) <= this.now()) return 'EXPIRED';
    if (grant.uses >= grant.maxUses) return 'EXHAUSTED';
    if (grant.scopeHash !== this.grantScope(issue)) return 'STALE';
    if (grant.action === 'complete') {
      try { if (grant.candidateId !== issue.candidate?.id || grant.digest !== acceptanceDigest(this.store,issue)) return 'STALE'; }
      catch { return 'STALE'; }
    }
    return 'AVAILABLE';
  }
  private useGrant(actor: Actor, issue: Issue, action: Grant['action'], grantId?: string) {
    requireRole(actor,'lead','pm');
    if (!grantId) throw new DomainError('ROLE_DENIED','This lifecycle action requires an exact human grant',403);
    const grant = this.store.get<Grant>('grant',grantId);
    if (actor.runId || grant.granteeId !== actor.id || grant.workspaceId !== issue.workspaceId || grant.issueId !== issue.id || grant.action !== action) throw new DomainError('GRANT_DENIED','Grant does not authorize this agent, issue, or action',403);
    const status = this.grantStatus(grant,issue);
    if (status !== 'AVAILABLE') throw new DomainError(`GRANT_${status}`,'The human grant is no longer usable');
    grant.uses++; grant.version++; this.store.put('grant',grant,issue.workspaceId);
    this.store.event(issue.workspaceId,actor,'grant_used',grant.id,{ issueId: issue.id,grantorId: grant.grantorId,action,uses: grant.uses });
    return grant;
  }
  completeQa(actor: Actor, runId: string) {
    requireRole(actor,'qa');
    const run = this.store.get<Run>('run',runId); const issue = this.store.issue(actor,run.workspaceId,run.issueId);
    if (issue.state !== 'QA_TEST' || run.state !== 'RUNNING' || run.executionActorId !== actor.id || !run.providerSessionId || !run.reportId) throw new DomainError('QA_REPORT_REQUIRED','A stopped independent producer must have submitted a report for this QA gate');
    const report = this.store.get<QaReport>('qa_report',run.reportId); validateQaReport(this.store,issue,actor,report);
    const review = { id: randomUUID(), issueId: issue.id, workspaceId: issue.workspaceId, actorId: actor.id, sessionId: actor.sessionId, candidateId: report.candidateId, snapshotId: report.snapshotId, stage: 'QA', verdict: report.verdict, reportId: report.id, reason: report.summary, at: new Date(this.now()).toISOString() };
    this.store.put('review',review,issue.workspaceId);
    for (const finding of report.findings) {
      const defect = { id: randomUUID(), issueId: issue.id, workspaceId: issue.workspaceId, candidateId: report.candidateId, snapshotId: report.snapshotId, reportId: report.id, ownerId: issue.assignee, state: 'OPEN', ...finding };
      this.store.put('defect',defect,issue.workspaceId);
    }
    if (report.verdict === 'PASS') {
      for (const defect of this.store.list<any>('defect',issue.workspaceId).filter(d => d.issueId === issue.id && d.state === 'OPEN' && d.reportId !== report.id)) { defect.state = 'RESOLVED'; defect.resolutionReportId = report.id; this.store.put('defect',defect,issue.workspaceId); }
      issue.qaReview = review.id; issue.state = 'LEAD_REVIEW'; issue.stage = 'FINAL';
    } else if (report.verdict === 'FAIL') { issue.state = 'QA_REJECTED'; issue.stage = null; }
    return this.save(actor,'qa_review_completed',issue,{ reviewId: review.id, reportId: report.id, verdict: report.verdict });
  }
  closureBlockers(issue: Issue) {
    const s = this.store; const blockers: string[] = [];
    let digest: string | undefined;
    try { digest = acceptanceDigest(s,issue); } catch (error) { blockers.push(error instanceof DomainError ? error.code : 'EVIDENCE_STALE'); }
    const approved = digest && issue.acceptedDigest === digest && s.list<any>('delivery_approval',issue.workspaceId).some(a => a.issueId === issue.id && a.candidateId === issue.candidate?.id && a.digest === digest && a.decision === 'ACCEPT' && s.get<Actor>('actor',a.actorId).role === 'human');
    if (!approved) blockers.push('HUMAN_ACCEPTANCE_REQUIRED');
    if (issue.parentId && ['ON_HOLD','ABANDONED'].includes(s.get<Issue>('issue',issue.parentId).state)) blockers.push('ANCESTOR_BLOCKED');
    if (issue.state !== 'USER_ACCEPTANCE') blockers.push('DELIVERY_NOT_READY');
    if (s.list<Issue>('issue',issue.workspaceId).some(c => c.parentId === issue.id && c.state !== 'DONE')) blockers.push('CHILDREN_INCOMPLETE');
    if (issue.dependencies.some(id => s.get<Issue>('issue',id).state !== 'DONE')) blockers.push('DEPENDENCY_BLOCKED');
    if (s.list<Run>('run',issue.workspaceId).some(r => r.issueId === issue.id && (liveRunStates as readonly string[]).includes(r.state))) blockers.push('RUN_STILL_LIVE');
    if (s.list<any>('defect',issue.workspaceId).some(d => d.issueId === issue.id && d.state === 'OPEN' && d.severity !== 'INFO')) blockers.push('UNRESOLVED_DEFECTS');
    const workspace = s.get<Workspace>('workspace',issue.workspaceId);
    if ((issue.artifactMode ?? (workspace.commonDir ? 'git' : 'artifact')) === 'git') {
      if (!issue.gitSubmissionId) blockers.push('GIT_VERIFICATION_REQUIRED');
      else {
        const git = s.get<GitSubmission>('git_submission',issue.gitSubmissionId);
        if (git.workspaceId !== issue.workspaceId || git.issueId !== issue.id || git.candidateId !== issue.candidate?.id || git.snapshotId !== issue.candidate?.snapshotId || git.bindingId !== workspace.gitBindingId) blockers.push('GIT_EVIDENCE_STALE');
        else if (git.state !== 'VERIFIED') blockers.push(git.errorCode ?? (['QUEUED','VERIFYING'].includes(git.state) ? 'GIT_VERIFICATION_PENDING' : 'GIT_VERIFICATION_REQUIRED'));
        else {
          const attempt = git.currentAttemptId ? s.get<GitAttempt>('git_attempt',git.currentAttemptId) : null;
          if (!git.verifiedAt || !git.treeSha || git.treeSha !== git.expectedTreeSha || !attempt || attempt.state !== 'VERIFIED' || attempt.submissionId !== git.id || attempt.treeSha !== git.treeSha || attempt.expectedTreeSha !== git.expectedTreeSha) blockers.push('GIT_EVIDENCE_STALE');
        }
      }
    }
    return [...new Set(blockers)];
  }
  completeGit(attempt: GitAttempt) {
    return this.store.db.transaction(() => {
      const s = this.store; const git = s.get<GitSubmission>('git_submission',attempt.submissionId);
      if (git.state !== 'VERIFYING' || git.currentAttemptId !== attempt.id || attempt.attempt !== git.attempt) return;
      const issue = s.get<Issue>('issue',git.issueId); const workspace = s.get<Workspace>('workspace',git.workspaceId);
      const current = issue.gitSubmissionId === git.id && issue.candidate?.id === git.candidateId && issue.candidate?.snapshotId === git.snapshotId && workspace.gitBindingId === git.bindingId;
      if (!current) { attempt.state = 'STALE'; attempt.errorCode = 'GIT_EVIDENCE_STALE'; }
      if (attempt.state === 'VERIFIED' && (!attempt.treeSha || attempt.treeSha !== attempt.expectedTreeSha || attempt.sha !== git.sha || attempt.repository !== git.repository)) { attempt.state = 'FAILED'; attempt.errorCode = 'COMMIT_SNAPSHOT_MISMATCH'; }
      attempt.finishedAt ??= new Date(this.now()).toISOString();
      s.put('git_attempt',attempt,git.workspaceId);
      git.state = attempt.state; git.errorCode = attempt.errorCode; git.rootTreeSha = attempt.rootTreeSha; git.treeSha = attempt.treeSha; git.expectedTreeSha = attempt.expectedTreeSha;
      if (attempt.state === 'VERIFIED') git.verifiedAt = attempt.finishedAt;
      s.put('git_submission',git,git.workspaceId);
      const actor = s.get<Actor>('actor',git.actorId);
      s.event(git.workspaceId,actor,'git_verification_finished',git.id,{ attemptId: attempt.id,state: git.state,errorCode: git.errorCode,performedBy: 'git-verifier' });
      if (current && issue.state === 'USER_ACCEPTANCE' && issue.acceptedDigest && !this.closureBlockers(issue).length) { issue.state = 'DONE'; this.save(actor,'delivery_closed',issue,{ submissionId: git.id,performedBy: 'git-verifier',cause: 'Current human acceptance and verified commit' }); }
    }).immediate();
  }
  private mutate(actor: Actor, op: Operation, a: Record<string, any>): Record<string, unknown> {
    const s = this.store;
    if (op === 'workspace_register') {
      requireRole(actor, 'human');
      if (!isAbsolute(a.root) || !existsSync(a.root) || !statSync(a.root).isDirectory()) throw new DomainError('WORKSPACE_UNRESOLVED', 'Select an existing absolute directory');
      const root = realpathSync(a.root);
      const existing = s.list<Workspace>('workspace').find(w => w.root === root);
      if (existing) return { workspace: existing };
      let commonDir = null;
      try { commonDir = realpathSync(resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim())); } catch {}
      const w: Workspace = { id: randomUUID(), name: a.name, prefix: a.prefix, root, commonDir, sequence: 0 };
      s.put('workspace', w, w.id); s.event(w.id, actor, op, w.id, { name: w.name });
      return { workspace: w };
    }
    const w = s.workspace(actor, a.workspaceId);
    if (op === 'workspace_git_bind') {
      requireRole(actor,'human');
      if ((w.gitBindingId ?? null) !== a.expectedBindingId) throw new DomainError('VERSION_CONFLICT','Workspace Git binding changed; reload it before retrying');
      const binding = inspectGitBinding(w,a.remote,actor.id);
      if (w.gitBindingId) {
        const previous = s.get<GitBinding>('git_binding',w.gitBindingId);
        if (previous.repository === binding.repository && previous.subdirectory === binding.subdirectory) return { workspace: w,binding: previous };
        if (s.list<Issue>('issue',w.id).some(i => i.artifactMode !== 'artifact' && !['DONE','ABANDONED'].includes(i.state) && (i.candidate || i.state !== 'NOT_STARTED' || this.design(i)?.status === 'APPROVED'))) throw new DomainError('REBIND_REQUIRES_SCOPE_RESET','Reset approved or active Git work before selecting another repository binding');
      }
      s.put('git_binding',binding,w.id); w.gitBindingId = binding.id; s.put('workspace',w,w.id);
      for (const issue of s.list<Issue>('issue',w.id).filter(i => i.artifactMode !== 'artifact' && !['DONE','ABANDONED'].includes(i.state))) {
        if (!issue.parentId) issue.designBindingId = binding.id;
        issue.acceptedDigest = undefined; this.save(actor,'scope_git_binding_set',issue,{ bindingId: binding.id,designId: this.design(issue)?.id });
      }
      s.event(w.id,actor,op,binding.id,{ repository: binding.repository,subdirectory: binding.subdirectory }); return { workspace: w,binding };
    }
    if (op === 'check_profile_create') {
      requireRole(actor,'human');
      if (!isAbsolute(a.command) || !existsSync(a.command) || !statSync(a.command).isFile() || /\.(cmd|bat|ps1|sh)$/i.test(a.command)) throw new DomainError('COMMAND_INVALID','Approve an absolute native executable; shell shims are not executed');
      const profile: CheckProfile = { id: randomUUID(), workspaceId: w.id, name: a.name, command: realpathSync(a.command), args: a.args, criteria: [...new Set<string>(a.criteria)], timeoutMs: a.timeoutMs, hash: hash(canonical({ command: realpathSync(a.command), args: a.args, criteria: a.criteria, timeoutMs: a.timeoutMs })) };
      s.put('check_profile',profile,w.id); s.event(w.id,actor,op,profile.id,{ profileHash: profile.hash }); return { profile };
    }
    if (op === 'run_interrupt' || op === 'run_reconcile') {
      requireRole(actor, ...(op === 'run_reconcile' ? ['human'] as const : ['human', 'lead', 'pm'] as const));
      const run = s.get<Run>('run', a.runId);
      if (run.workspaceId !== w.id) throw new DomainError('SCOPE_DENIED', 'Run belongs to another workspace', 403);
      if ((run.version ?? 1) !== a.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Run changed; reload before retrying');
      if (!(liveRunStates as readonly string[]).includes(run.state)) throw new DomainError('INVALID_TRANSITION', 'Run is already terminal');
      if (op === 'run_reconcile' && run.state !== 'UNCERTAIN') throw new DomainError('INVALID_TRANSITION', 'Only uncertain execution requires external reconciliation');
      if (op === 'run_reconcile') {
        const checks = s.list<CheckRun>('check',w.id).filter(c => c.runId === run.id && ['RUNNING','UNCERTAIN'].includes(c.state));
        for (const pid of [run.pid,...checks.map(c => c.pid)].filter((p): p is number => !!p)) {
          let alive = true;
          try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
          if (alive) throw new DomainError('RUN_STILL_LIVE', 'Recorded process still exists; inspect and stop the owned execution first');
        }
        for (const check of checks) { check.state = 'FAILED'; check.errorCode = 'EXTERNAL_STOP_CONFIRMED'; check.finishedAt = new Date(this.now()).toISOString(); s.put('check',check,w.id); }
        run.state = 'CANCELLED'; run.finishedAt = new Date(this.now()).toISOString();
        if (run.executionActorId) s.revokeActor(run.executionActorId);
        const issue = s.get<Issue>('issue', run.issueId);
        if (run.kind !== 'qa' && issue.candidate?.runId === run.id) {
          s.put('candidate',issue.candidate,w.id); const held = issue.state === 'ON_HOLD'; const abandoned = issue.state === 'ABANDONED'; this.invalidate(issue);
          if (held) { issue.state = 'ON_HOLD'; issue.savedState = { state: 'NOT_STARTED',stage: null }; } else if (abandoned) issue.state = 'ABANDONED';
          this.save(actor,'candidate_invalidated',issue,{ runId: run.id,reason: a.reason });
        }
        if (issue.lease?.actorId === run.executionActorId) { issue.lease = null; if (issue.state === 'IN_PROGRESS') issue.state = 'NOT_STARTED'; this.save(actor, 'run_reconciled', issue, { runId: run.id, reason: a.reason }); }
      } else if (run.state === 'QUEUED') { run.state = 'CANCELLED'; run.finishedAt = new Date(this.now()).toISOString(); }
      else if (run.state !== 'UNCERTAIN') run.state = 'STOPPING';
      else throw new DomainError('RUN_UNCERTAIN', 'Reconcile external execution before issuing a new stop request');
      run.stopReason = a.reason; run.version = (run.version ?? 1) + 1;
      s.put('run', run, w.id); s.event(w.id, actor, op, run.id, { state: run.state, reason: a.reason });
      return { run };
    }
    if (op === 'actor_enroll') {
      requireRole(actor, 'human');
      const enrolled: Actor = { id: randomUUID(), role: a.role, name: a.name, workspaceIds: [w.id], sessionId: randomUUID() };
      const token = s.token(enrolled);
      s.event(w.id, actor, op, enrolled.id, { role: a.role, name: a.name });
      return { actor: enrolled, token };
    }
    if (op === 'issue_create') {
      requireRole(actor, 'human', 'lead', 'pm');
      if (a.parentId) {
        const parent = s.issue(actor, w.id, a.parentId);
        version(parent, a.expectedParentVersion);
        if (parent.parentId) throw new DomainError('HIERARCHY_LIMIT', 'Tasks cannot contain child tasks');
        if (['DONE', 'ABANDONED'].includes(parent.state)) throw new DomainError('PARENT_CLOSED', 'Reopen the parent before adding scope');
        if (!/^\[(Feature|Fix|Refactor|Test|Docs|Research)\] [^:]+: .+ -> .+$/.test(a.title)) throw new DomainError('TITLE_FORMAT', 'Use [Type] Area: action -> outcome for the child suffix');
        const wasActive = parent.state !== 'NOT_STARTED';
        this.invalidate(parent); if (wasActive && parent.state !== 'ON_HOLD') parent.state = 'IN_PROGRESS';
        this.save(actor, 'scope_child_added', parent);
      }
      w.sequence++; s.put('workspace', w, w.id);
      const i: Issue = { id: randomUUID(), workspaceId: w.id, key: `${w.prefix}-${String(w.sequence).padStart(4, '0')}`, parentId: a.parentId ?? null, title: a.title, description: a.description, criteria: [...new Set<string>(a.criteria)], version: 1, scopeRevision: 1, state: 'NOT_STARTED', stage: null, assignee: null, harness: null, dependencies: [], priority: 2, plannedStart: null, dueDate: null, designId: null, fence: 0, lease: null, candidate: null, initialReview: null, qaReview: null, finalReview: null, savedState: null };
      const parent = a.parentId ? s.get<Issue>('issue',a.parentId) : null;
      i.artifactMode = parent?.artifactMode ?? a.artifactMode ?? (w.commonDir ? 'git' : 'artifact'); i.artifactReason = parent?.artifactReason ?? a.artifactReason ?? (!w.commonDir ? 'Non-Git workspace delivery' : undefined);
      i.designBindingId = i.artifactMode === 'artifact' ? undefined : parent?.designBindingId ?? w.gitBindingId;
      if (a.artifactMode && parent?.artifactMode && a.artifactMode !== parent.artifactMode) throw new DomainError('ARTIFACT_MODE_MISMATCH','Child delivery mode follows the approved parent scope');
      if (i.artifactMode === 'artifact' && w.commonDir && !i.artifactReason) throw new DomainError('ARTIFACT_REASON_REQUIRED','Non-Git delivery in a Git workspace needs an explicit reviewed reason');
      s.put('issue', i, w.id); s.event(w.id, actor, op, i.id, { key: i.key, version: 1 });
      return { issue: this.display(i) };
    }
    const i = s.issue(actor, w.id, a.issueId);
    version(i, a.expectedVersion);
    if (op === 'grant_create') {
      requireRole(actor,'human');
      const grantee = s.get<Actor>('actor',a.granteeId);
      if (!['lead','pm'].includes(grantee.role) || grantee.runId || !grantee.workspaceIds.includes(w.id)) throw new DomainError('GRANTEE_INVALID','Choose a logical lead or PM in this workspace');
      const lifetime = Date.parse(a.expiresAt)-this.now();
      if (lifetime <= 0 || lifetime > 604800000) throw new DomainError('GRANT_EXPIRY_INVALID','A grant must expire in the next seven days');
      if (a.scopeHash !== this.grantScope(i)) throw new DomainError('GRANT_SCOPE_STALE','The issue or its child scope changed after the authorization view was loaded');
      if (a.action === 'complete') {
        if (i.state !== 'USER_ACCEPTANCE' || a.candidateId !== i.candidate?.id || a.digest !== acceptanceDigest(s,i)) throw new DomainError('APPROVAL_STALE','Completion authority must bind the current reviewed delivery');
      } else if (a.candidateId !== undefined || a.digest !== undefined) throw new DomainError('INVALID_INPUT','Delivery bindings apply only to completion grants',400);
      const grant: Grant = { id: randomUUID(),workspaceId: w.id,issueId: i.id,grantorId: actor.id,granteeId: grantee.id,action: a.action,scopeRevision: i.scopeRevision,designId: this.design(i)?.id ?? null,scopeHash: this.grantScope(i),candidateId: a.candidateId,digest: a.digest,expiresAt: a.expiresAt,maxUses: a.maxUses,uses: 0,version: 1,reason: a.reason,createdAt: new Date(this.now()).toISOString() };
      s.put('grant',grant,w.id);
      return { ...this.save(actor,op,i,{ grantId: grant.id,granteeId: grant.granteeId,action: grant.action,reason: a.reason }),grant };
    }
    if (op === 'grant_revoke') {
      requireRole(actor,'human');
      const grant = s.get<Grant>('grant',a.grantId);
      if (grant.workspaceId !== w.id || grant.issueId !== i.id) throw new DomainError('SCOPE_DENIED','Grant belongs to another issue',403);
      if (grant.version !== a.expectedGrantVersion) throw new DomainError('VERSION_CONFLICT','Grant use or revocation changed; reload before revoking');
      if (grant.revokedAt !== undefined) throw new DomainError('GRANT_REVOKED','Grant is already revoked');
      grant.revokedAt = new Date(this.now()).toISOString(); grant.revokedBy = actor.id; grant.revocationReason = a.reason; grant.version++;
      s.put('grant',grant,w.id);
      return { ...this.save(actor,op,i,{ grantId: grant.id,reason: a.reason }),grant };
    }
    if (op === 'git_submit' || op === 'git_retry') {
      requireRole(actor,'human','lead','pm');
      if (i.artifactMode === 'artifact' || !w.commonDir) throw new DomainError('GIT_MODE_REQUIRED','Commit evidence applies to Git-backed delivery');
      if (!['LEAD_REVIEW','QA_TEST','USER_ACCEPTANCE'].includes(i.state)) throw new DomainError('INVALID_TRANSITION','Attach commit evidence to a current submitted delivery');
      const snapshot = candidateSnapshot(s,i);
      if (!w.gitBindingId) throw new DomainError('GIT_BINDING_REQUIRED','The owner must bind the workspace GitHub remote first');
      const binding = s.get<GitBinding>('git_binding',w.gitBindingId);
      if (op === 'git_retry') {
        const git = s.get<GitSubmission>('git_submission',a.submissionId);
        if (i.gitSubmissionId !== git.id || git.snapshotId !== snapshot.id || git.candidateId !== i.candidate!.id || git.bindingId !== binding.id || git.workspaceId !== w.id || git.issueId !== i.id) throw new DomainError('GIT_EVIDENCE_STALE','Retry only the current candidate and repository mapping');
        if (!['FAILED','UNAVAILABLE'].includes(git.state)) throw new DomainError('INVALID_TRANSITION','Only failed or unavailable Git verification can be retried');
        git.state = 'QUEUED'; git.errorCode = undefined; s.put('git_submission',git,w.id);
        return { ...this.save(actor,op,i,{ submissionId: git.id }),git };
      }
      if (i.candidate!.id !== a.candidateId) throw new DomainError('EVIDENCE_STALE','Commit must map to the current candidate');
      const target = githubCommitUrl(a.commitUrl);
      if (target.repository !== binding.repository) throw new DomainError('COMMIT_REPOSITORY_MISMATCH','Commit repository differs from the owner-bound workspace remote');
      if (i.gitSubmissionId) { const previous = s.get<GitSubmission>('git_submission',i.gitSubmissionId); if (previous.url === target.url && previous.snapshotId === snapshot.id && previous.bindingId === binding.id) return { issue: this.display(i),git: previous }; }
      const git: GitSubmission = { id: randomUUID(),workspaceId: w.id,issueId: i.id,candidateId: i.candidate!.id,snapshotId: snapshot.id,bindingId: binding.id,subdirectory: binding.subdirectory,...target,actorId: actor.id,createdAt: new Date(this.now()).toISOString(),state: 'QUEUED',attempt: 0 };
      s.put('git_submission',git,w.id); i.gitSubmissionId = git.id; i.acceptedDigest = undefined;
      return { ...this.save(actor,op,i,{ submissionId: git.id,acceptanceInvalidated: true }),git };
    }
    if (op === 'delivery_complete') {
      requireRole(actor,'human','lead','pm');
      if (i.state !== 'USER_ACCEPTANCE') throw new DomainError('INVALID_TRANSITION','Completion requires the final user acceptance gate');
      let grant: Grant | undefined;
      if (a.grantId) {
        grant = this.useGrant(actor,i,'complete',a.grantId);
        const approval = { id: randomUUID(),issueId: i.id,actorId: grant.grantorId,executedBy: actor.id,grantId: grant.id,source: 'delegated_close',candidateId: grant.candidateId,digest: grant.digest,decision: 'ACCEPT',reason: grant.reason,at: new Date(this.now()).toISOString() };
        s.put('delivery_approval',approval,w.id); i.acceptedDigest = grant.digest;
      }
      const blockers = this.closureBlockers(i);
      if (grant && blockers.length) throw new DomainError('CLOSURE_BLOCKED','Delegated completion still requires all delivery guards',409,{ blockers });
      if (!blockers.length) i.state = 'DONE';
      return { ...this.save(actor,op,i,{ closureBlocked: blockers,...(grant ? { grantId: grant.id,grantorId: grant.grantorId } : {}) }),closureBlocked: blockers };
    }
    if (op === 'qa_configure') {
      requireRole(actor,'human','lead','pm');
      if (['DONE','ABANDONED','USER_ACCEPTANCE'].includes(i.state) || (i.state === 'LEAD_REVIEW' && i.stage === 'FINAL')) throw new DomainError('INVALID_TRANSITION','QA assignment is frozen after acceptance gates');
      if (s.list<Run>('run',w.id).some(r => r.issueId === i.id && r.kind === 'qa' && (liveRunStates as readonly string[]).includes(r.state))) throw new DomainError('RUN_EXISTS','Reconcile the current QA run first');
      const reviewer = s.get<Actor>('actor',a.actorId);
      if (reviewer.role !== 'qa' || reviewer.runId || !reviewer.workspaceIds.includes(w.id) || reviewer.id === i.assignee) throw new DomainError('REVIEW_INDEPENDENCE_REQUIRED','Select an independent logical QA actor in this workspace');
      for (const id of a.checkProfileIds) if (s.get<CheckProfile>('check_profile',id).workspaceId !== w.id) throw new DomainError('SCOPE_DENIED','Check profile belongs to another workspace',403);
      i.qaAssignee = reviewer.id; i.qaHarness = a.harness; i.checkProfileIds = [...new Set<string>(a.checkProfileIds)];
      const run = i.state === 'QA_TEST' ? queueQa(s,i) : null;
      return { ...this.save(actor,op,i,{ runId: run?.id }), run };
    }
    if (op === 'qa_check_run' || op === 'qa_report_submit') {
      requireRole(actor,'qa');
      if (!actor.runId || i.state !== 'QA_TEST') throw new DomainError('REVIEW_INDEPENDENCE_REQUIRED','Captured QA evidence requires a managed independent review');
      const run = s.get<Run>('run',actor.runId); const snapshot = candidateSnapshot(s,i);
      if (run.kind !== 'qa' || run.state !== 'RUNNING' || run.executionActorId !== actor.id || run.snapshotId !== snapshot.id || i.qaAssignee !== (actor.principalId ?? actor.id)) throw new DomainError('SCOPE_DENIED','QA execution does not own the current assignment',403);
      if (op === 'qa_check_run') {
        if (!(run.checkProfileIds ?? []).includes(a.profileId)) throw new DomainError('SCOPE_DENIED','Check profile is not approved for this run',403);
        const profile = s.get<CheckProfile>('check_profile',a.profileId);
        const testFiles = (a.testFiles as string[]).map(path => {
          path = path.replaceAll('\\','/');
          if (!path.startsWith('.qa/') || path.split('/').includes('..') || statSync(inside(run.executionRoot!,path)).size > 2097152) throw new DomainError('ARTIFACT_POLICY','QA test sources belong under .qa and must be at most 2 MiB');
          return { path, hash: hash(readFileSync(inside(run.executionRoot!,path))) };
        });
        const check: CheckRun = { id: randomUUID(), workspaceId: w.id, issueId: i.id, runId: run.id, actorId: actor.id, sessionId: actor.sessionId, candidateId: i.candidate!.id, snapshotId: snapshot.id, profileId: profile.id, profileHash: profile.hash, state: 'QUEUED', criteria: profile.criteria, testFiles, createdAt: new Date(this.now()).toISOString() };
        s.put('check',check,w.id); this.save(actor,op,i,{ checkId: check.id }); return { check, issue: this.display(i) };
      }
      const report: QaReport = { id: randomUUID(), workspaceId: w.id, issueId: i.id, runId: run.id, actorId: actor.id, sessionId: actor.sessionId, candidateId: a.candidateId, snapshotId: snapshot.id, verdict: a.verdict, results: a.results, findings: a.findings, summary: a.summary };
      validateQaReport(s,i,actor,report); s.put('qa_report',report,w.id); run.reportId = report.id; run.version++; s.put('run',run,w.id);
      return { ...this.save(actor,op,i,{ reportId: report.id }), report, reviewPendingStop: true };
    }
    if (op === 'delivery_decide') {
      requireRole(actor,'human');
      if (i.state !== 'USER_ACCEPTANCE' || i.candidate?.id !== a.candidateId || acceptanceDigest(s,i) !== a.digest) throw new DomainError('APPROVAL_STALE','Accept only the current reviewed delivery digest');
      const approval = { id: randomUUID(), issueId: i.id, actorId: actor.id, candidateId: i.candidate!.id, digest: a.digest, decision: a.decision, reason: a.reason, at: new Date(this.now()).toISOString() };
      s.put('delivery_approval',approval,w.id);
      if (a.decision === 'REJECT') { i.state = 'USER_REJECTED'; i.acceptedDigest = undefined; }
      else {
        i.acceptedDigest = a.digest;
        const children = s.list<Issue>('issue',w.id).filter(c => c.parentId === i.id);
        if (children.some(c => c.state !== 'DONE')) throw new DomainError('CHILDREN_INCOMPLETE','Parent acceptance requires every in-scope child to be implemented');
        if (!i.initialReview || !i.qaReview || !i.finalReview || this.design(i)?.status !== 'APPROVED') throw new DomainError('EVIDENCE_MISSING','Current design, lead reviews, and QA are required');
        if (!this.closureBlockers(i).length) i.state = 'DONE';
      }
      return { ...this.save(actor,op,i,{ approvalId: approval.id, reason: a.reason }), approval, closureBlocked: i.state === 'USER_ACCEPTANCE' ? this.closureBlockers(i) : [] };
    }
    const scopeChanged = op === 'issue_update' && a.description !== undefined && a.description !== i.description;
    if (['issue_assign', 'dependency_add', 'design_set'].includes(op) || scopeChanged) {
      if (s.list<Run>('run', w.id).some(r => (r.issueId === i.id || ((op === 'design_set' || (scopeChanged && !i.parentId)) && s.get<Issue>('issue', r.issueId).parentId === i.id)) && (liveRunStates as readonly string[]).includes(r.state))) throw new DomainError('RUN_EXISTS', 'Reconcile queued, live, or uncertain executions before changing their assignment or scope');
    }
    if (op === 'issue_update') {
      requireRole(actor, 'human', 'lead', 'pm');
      if (['DONE', 'ABANDONED'].includes(i.state)) throw new DomainError('ISSUE_CLOSED', 'Reopen before editing');
      if (a.title !== undefined && i.parentId && !/^\[(Feature|Fix|Refactor|Test|Docs|Research)\] [^:]+: .+ -> .+$/.test(a.title)) throw new DomainError('TITLE_FORMAT', 'Invalid task suffix');
      if (scopeChanged) {
        i.scopeRevision++; i.description = a.description;
        const previous = this.design(i);
        if (!i.parentId && previous) this.draftDesign(actor,i,previous.content,previous.criteria);
        else this.invalidate(i);
      }
      for (const key of ['title', 'description', 'priority', 'plannedStart', 'dueDate'] as const) if (a[key] !== undefined) (i as any)[key] = a[key];
      return this.save(actor, op, i);
    }
    if (op === 'design_set') {
      requireRole(actor, 'human', 'lead');
      if (i.parentId) throw new DomainError('PARENT_DESIGN_REQUIRED', 'Design revisions belong to the parent requirement');
      if (['DONE', 'ABANDONED'].includes(i.state)) throw new DomainError('ISSUE_CLOSED', 'Reopen before changing scope');
      const design = this.draftDesign(actor,i,a.content,a.criteria);
      return this.save(actor, op, i, { designId: design.id });
    }
    if (op === 'design_submit' || op === 'design_decide') {
      requireRole(actor, ...(op === 'design_decide' ? ['human'] as const : ['human', 'lead'] as const));
      if (!i.designId || i.parentId) throw new DomainError('DESIGN_REQUIRED', 'Create a parent design first');
      const d = s.get<Design>('design', i.designId);
      if (op === 'design_submit') { if (d.status !== 'DRAFT' && d.status !== 'CHANGES_REQUESTED') throw new DomainError('INVALID_TRANSITION', 'Design is not editable'); d.status = 'IN_REVIEW'; }
      else {
        if (a.designId !== d.id) throw new DomainError('APPROVAL_STALE', 'Design revision changed');
        if (d.requirementDescription !== i.description) throw new DomainError('DESIGN_SCOPE_STALE','Create a current scope-bound design revision before approving it');
        if (d.status !== 'IN_REVIEW') throw new DomainError('INVALID_TRANSITION', 'Design is not awaiting a decision');
        d.status = a.decision;
        s.put('approval', { id: randomUUID(), actorId: actor.id, designId: d.id, hash: d.hash, decision: a.decision, reason: a.reason, at: new Date(this.now()).toISOString() }, w.id);
      }
      s.put('design', d, w.id);
      return this.save(actor, op, i, { designId: d.id, decision: d.status });
    }
    if (op === 'issue_assign') {
      requireRole(actor, 'human', 'lead', 'pm');
      if (i.state !== 'NOT_STARTED' && !i.state.endsWith('REJECTED')) throw new DomainError('ASSIGNMENT_ACTIVE', 'Reconcile active work before reassigning');
      const assigned = s.get<Actor>('actor', a.actorId);
      if (assigned.role !== 'worker' || assigned.runId || !assigned.workspaceIds.includes(w.id)) throw new DomainError('SCOPE_DENIED', 'Assignment requires a logical worker in this workspace');
      i.assignee = assigned.id; i.harness = a.harness; i.lease = null;
      return this.save(actor, op, i);
    }
    if (op === 'dependency_add') {
      requireRole(actor, 'human', 'lead', 'pm');
      if (i.state !== 'NOT_STARTED') throw new DomainError('PLAN_ACTIVE', 'Dependency edits require unstarted work');
      s.issue(actor, w.id, a.dependsOn);
      const reaches = (id: string, seen = new Set<string>()): boolean => {
        if (id === i.id) return true;
        if (seen.has(id)) return false;
        seen.add(id); return s.get<Issue>('issue', id).dependencies.some(d => reaches(d, seen));
      };
      if (reaches(a.dependsOn)) throw new DomainError('DEPENDENCY_CYCLE', 'Dependency would create a cycle');
      if (i.parentId === a.dependsOn) throw new DomainError('DEPENDENCY_CYCLE', 'A child cannot wait for its own aggregate parent');
      i.dependencies = [...new Set([...i.dependencies, a.dependsOn])];
      return this.save(actor, op, i);
    }
    if (op === 'work_dispatch' || op === 'work_claim') {
      requireRole(actor, ...(op === 'work_claim' ? ['worker'] as const : ['human', 'lead', 'pm'] as const));
      if (!['NOT_STARTED', 'LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED'].includes(i.state)) throw new DomainError('INVALID_TRANSITION', 'Issue cannot be started from its current state');
      const blockers = this.readiness(i).blocking;
      if (blockers.length) throw new DomainError('NOT_READY', 'Resolve readiness blockers first', 409, { blockers });
      if (this.design(i)?.id !== a.designId || i.scopeRevision !== a.scopeRevision) throw new DomainError('APPROVAL_STALE', 'Acknowledge the current design and task scope');
      if (op === 'work_dispatch') {
        if (s.list<Run>('run', w.id).some(r => r.issueId === i.id && (liveRunStates as readonly string[]).includes(r.state))) throw new DomainError('RUN_EXISTS', 'A live or uncertain dispatch already owns this task');
        const run: Run = { id: randomUUID(), issueId: i.id, workspaceId: w.id, actorId: i.assignee!, harness: i.harness!, state: 'QUEUED', version: 1, createdAt: new Date(this.now()).toISOString(), designId: a.designId, scopeRevision: a.scopeRevision };
        s.put('run', run, w.id); this.save(actor, op, i, { runId: run.id });
        return { run, issue: this.display(i) };
      }
      const live = s.list<Run>('run', w.id).find(r => r.issueId === i.id && (liveRunStates as readonly string[]).includes(r.state));
      if (live && (live.id !== actor.runId || live.executionActorId !== actor.id || !live.executionRoot)) throw new DomainError('RUN_EXISTS', 'A managed execution already owns this task');
      if (i.assignee !== (actor.principalId ?? actor.id)) throw new DomainError('ROLE_DENIED', 'Only the assigned worker can claim this task', 403);
      i.fence++; i.lease = { actorId: actor.id, expiresAt: this.now() + 300000, fence: i.fence }; i.state = 'IN_PROGRESS'; i.stage = null;
      if (i.parentId) { const parent = s.get<Issue>('issue', i.parentId); if (parent.state === 'NOT_STARTED') { parent.state = 'IN_PROGRESS'; this.save(actor, 'child_started', parent); } }
      return this.save(actor, op, i);
    }
    if (op === 'work_heartbeat' || op === 'work_submit') {
      requireRole(actor, 'worker');
      if (i.state !== 'IN_PROGRESS' || i.lease?.actorId !== actor.id || i.lease.fence !== a.fence) throw new DomainError('STALE_FENCE', 'Run does not own the current implementation lease');
      if (i.lease.expiresAt <= this.now()) throw new DomainError('LEASE_EXPIRED', 'Reconcile execution before renewing or submitting');
      if (this.readiness(i).blocking.length) throw new DomainError('NOT_READY', 'Work is blocked by a changed requirement or hold');
      if (op === 'work_heartbeat') { i.lease.expiresAt = this.now() + 300000; return this.save(actor, op, i); }
      const run = actor.runId ? s.get<Run>('run', actor.runId) : null;
      if (run && (run.state !== 'RUNNING' || run.executionActorId !== actor.id || !run.executionRoot || run.scopeRevision !== i.scopeRevision || run.designId !== this.design(i)?.id)) throw new DomainError('RUN_UNCERTAIN', 'Run is not the current active execution');
      const root = run?.executionRoot ?? w.root;
      const files = (a.files as string[]).map(path => {
        if (isAbsolute(path)) throw new DomainError('PATH_DENIED', 'Use workspace-relative artifact paths', 403);
        const file = inside(root, path);
        if (!statSync(file).isFile() || statSync(file).size > 2 * 1024 * 1024) throw new DomainError('ARTIFACT_LIMIT', 'Artifacts must be files of at most 2 MiB');
        return { path: relative(root, file), hash: hash(readFileSync(file)) };
      });
      i.candidate = { id: randomUUID(), workerId: actor.id, sessionId: actor.sessionId, designId: this.design(i)!.id, files, hash: hash(canonical(files)), summary: a.summary, ...(run ? { executionRoot: root, runId: run.id, baseSha: run.baseSha } : {}) };
      s.put('candidate',i.candidate,w.id);
      i.initialReview = null; i.qaReview = null; i.finalReview = null; i.lease = null; i.state = 'LEAD_REVIEW'; i.stage = 'PRE_QA';
      i.gitSubmissionId = undefined; i.acceptedDigest = undefined;
      return this.save(actor, op, i, { candidateId: i.candidate.id, artifactHash: i.candidate.hash });
    }
    if (op === 'review_submit') {
      if (!i.candidate || i.candidate.id !== a.candidateId) throw new DomainError('EVIDENCE_STALE', 'Review must reference the current candidate');
      if (i.candidate.runId && (liveRunStates as readonly string[]).includes(s.get<Run>('run', i.candidate.runId).state)) throw new DomainError('RUN_STILL_LIVE', 'Confirm execution stopped before reviewing its artifacts');
      if (i.candidate.runId) candidateSnapshot(s,i);
      else for (const file of i.candidate.files) if (hash(readFileSync(inside(w.root, file.path))) !== file.hash) throw new DomainError('EVIDENCE_STALE', 'Submitted artifact changed; resubmit before review');
      if (i.candidate.sessionId === actor.sessionId) throw new DomainError('REVIEW_INDEPENDENCE_REQUIRED', 'Implementer cannot review its own delivery');
      if (i.state === 'LEAD_REVIEW') requireRole(actor, 'lead');
      else if (i.state === 'QA_TEST') requireRole(actor, 'qa');
      else throw new DomainError('INVALID_TRANSITION', 'Issue is not awaiting a review');
      if (i.state === 'QA_TEST') throw new DomainError('EVIDENCE_MISSING', 'Use an assigned QA report with captured test evidence; narrative review cannot move the QA gate');
      if (i.state === 'LEAD_REVIEW' && i.stage === 'FINAL' && (!i.initialReview || !i.qaReview)) throw new DomainError('EVIDENCE_MISSING', 'Final review requires current initial and independent QA evidence');
      const review = { id: randomUUID(), issueId: i.id, workspaceId: w.id, actorId: actor.id, sessionId: actor.sessionId, candidateId: i.candidate.id, snapshotId: i.candidate.snapshotId, stage: i.stage ?? 'QA', verdict: a.verdict, reason: a.reason, at: new Date(this.now()).toISOString() };
      s.put('review', review, w.id);
      if (a.verdict === 'FAIL') { i.state = 'LEAD_REJECTED'; i.stage = null; }
      else if (i.stage === 'PRE_QA') { i.initialReview = review.id; i.state = 'QA_TEST'; i.stage = null; const run = queueQa(s,i); if (run) s.event(w.id,actor,'qa_dispatched',run.id,{ candidateId: i.candidate.id }); }
      else { i.finalReview = review.id; i.state = 'USER_ACCEPTANCE'; i.stage = null; }
      return this.save(actor, op, i, { reviewId: review.id, verdict: review.verdict, reason: review.reason });
    }
    if (op === 'issue_transition') {
      const grant = actor.role === 'human' && !a.grantId ? null : this.useGrant(actor,i,a.action,a.grantId);
      if (a.action === 'hold') {
        if (['DONE', 'ABANDONED', 'ON_HOLD'].includes(i.state)) throw new DomainError('INVALID_TRANSITION', 'Only active issues can be held');
        i.savedState = { state: i.state, stage: i.stage }; i.state = 'ON_HOLD';
      } else if (a.action === 'resume') {
        if (i.state !== 'ON_HOLD' || !i.savedState) throw new DomainError('INVALID_TRANSITION', 'Issue is not on hold');
        i.state = i.savedState.state; i.stage = i.savedState.stage; i.savedState = null;
        if (i.state === 'IN_PROGRESS') { i.state = 'NOT_STARTED'; i.lease = null; }
      } else if (a.action === 'abandon') {
        if (['DONE', 'ABANDONED'].includes(i.state)) throw new DomainError('INVALID_TRANSITION', 'Issue is already terminal');
        if (s.list<Issue>('issue', w.id).some(child => child.parentId === i.id && !['DONE', 'ABANDONED'].includes(child.state))) throw new DomainError('CHILD_DISPOSITION_REQUIRED', 'Resolve active children explicitly before abandoning the parent');
        i.state = 'ABANDONED'; i.lease = null;
      } else {
        if (!['DONE', 'ABANDONED'].includes(i.state)) throw new DomainError('INVALID_TRANSITION', 'Only terminal issues can reopen');
        this.invalidate(i); i.state = 'NOT_STARTED';
        if (i.parentId) {
          const parent = s.get<Issue>('issue',i.parentId);
          if (parent.state === 'DONE') { this.invalidate(parent); parent.state = 'IN_PROGRESS'; this.save(actor,'child_reopened',parent,{ childId: i.id }); }
        }
      }
      return this.save(actor, op, i, { reason: a.reason,...(grant ? { grantId: grant.id,grantorId: grant.grantorId } : {}) });
    }
    throw new DomainError('CAPABILITY_UNSUPPORTED', 'Operation is not implemented', 501);
  }
}
