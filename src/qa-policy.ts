import { Actor, CheckProfile, CheckRun, DomainError, GitSubmission, IntegrationManifest, Issue, QaReport, Run, Snapshot, Workspace } from './contracts.js';
import { Store, canonical, hash } from './store.js';
import { verifySnapshot } from './snapshots.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inside } from './paths.js';
import { currentPlan, isAggregate, planChildren, planCoverage } from './planning.js';
import { inScopeChildren, scopeState } from './scope.js';

export function candidateSnapshot(store: Store, issue: Issue) {
  if (!issue.candidate?.snapshotId) throw new DomainError('SNAPSHOT_REQUIRED','Seal the complete delivery before QA or acceptance');
  const snapshot = store.get<Snapshot>('snapshot',issue.candidate.snapshotId);
  if (snapshot.issueId !== issue.id || snapshot.candidateId !== issue.candidate.id || snapshot.workspaceId !== issue.workspaceId) throw new DomainError('EVIDENCE_STALE','Snapshot does not belong to this candidate');
  verifySnapshot(snapshot); return snapshot;
}
export function integrationManifest(store: Store, issue: Issue): IntegrationManifest | undefined {
  if (!isAggregate(store,issue)) return undefined;
  const coverage = planCoverage(store,issue); const plan = currentPlan(store,issue);
  if (!plan || !coverage.ready) throw new DomainError('PLAN_NOT_READY','Integration requires current complete criterion coverage',409,{ blockers: coverage.blocking });
  const children = inScopeChildren(store,issue);
  if (children.some(child => child.state !== 'DONE')) throw new DomainError('CHILDREN_INCOMPLETE','Finish every in-scope child before preparing integration');
  const manifest = children.map(child => {
    const digest = acceptanceDigest(store,child);
    if (child.acceptedDigest !== digest || !store.list<any>('delivery_approval',issue.workspaceId).some(a => a.issueId === child.id && a.digest === digest && a.decision === 'ACCEPT' && store.get<Actor>('actor',a.actorId).role === 'human')) throw new DomainError('CHILD_ACCEPTANCE_STALE','Integration requires each exact accepted child snapshot');
    const snapshot = store.get<Snapshot>('snapshot',child.candidate!.snapshotId!);
    const git = child.gitSubmissionId ? store.get<GitSubmission>('git_submission',child.gitSubmissionId) : null;
    if (child.artifactMode === 'git' && (!git || git.state !== 'VERIFIED' || git.candidateId !== child.candidate!.id || git.snapshotId !== snapshot.id)) throw new DomainError('GIT_EVIDENCE_STALE','Integration requires historical verified child commits');
    return { issueId: child.id,candidateId: child.candidate!.id,snapshotId: snapshot.id,snapshotHash: snapshot.hash,digest,...(git ? { commitUrl: git.url } : {}) };
  }).sort((a,b) => a.issueId.localeCompare(b.issueId));
  const excluded = planChildren(store,issue).map(child => ({ child,scope: scopeState(store,child) })).filter(v => v.scope.status === 'EXCLUDED').map(({ child,scope }) => ({ issueId: child.id,decisionId: scope.decision!.id,decisionHash: scope.decision!.hash,replacementIds: scope.decision!.replacements.map(r => r.issueId).sort() })).sort((a,b) => a.issueId.localeCompare(b.issueId));
  const body = { planScopeHash: plan.scopeHash,children: manifest,...(excluded.length ? { excluded } : {}) };
  return { planId: plan.id,...body,hash: hash(canonical(body)) };
}
export function validateIntegration(store: Store, issue: Issue) {
  const current = integrationManifest(store,issue);
  if (current && (!issue.candidate?.integration || issue.candidate.integration.hash !== current.hash || issue.candidate.integration.planScopeHash !== current.planScopeHash || hash(canonical({ planScopeHash: issue.candidate.integration.planScopeHash,children: issue.candidate.integration.children,...(issue.candidate.integration.excluded ? { excluded: issue.candidate.integration.excluded } : {}) })) !== current.hash)) throw new DomainError('INTEGRATION_STALE','Integration must reference the current accepted child manifest and ready plan');
  return current;
}
export function queueQa(store: Store, issue: Issue) {
  if (!issue.qaAssignee || !issue.qaHarness || !issue.checkProfileIds?.length) return null;
  const snapshot = candidateSnapshot(store,issue);
  validateIntegration(store,issue);
  if (store.list<Run>('run',issue.workspaceId).some(r => r.issueId === issue.id && ['QUEUED','STARTING','RUNNING','STOPPING','UNCERTAIN'].includes(r.state))) throw new DomainError('RUN_EXISTS','Reconcile live execution before QA dispatch');
  const profiles = issue.checkProfileIds.map(id => store.get<CheckProfile>('check_profile',id));
  if (profiles.some(p => p.workspaceId !== issue.workspaceId) || issue.criteria.some(c => !profiles.some(p => p.criteria.includes(c)))) throw new DomainError('QA_COVERAGE_REQUIRED','Approved checks must cover every assigned criterion');
  const run: Run = { id: randomUUID(), issueId: issue.id, workspaceId: issue.workspaceId, actorId: issue.qaAssignee, harness: issue.qaHarness, kind: 'qa', candidateId: issue.candidate!.id, snapshotId: snapshot.id, state: 'QUEUED', version: 1, createdAt: new Date().toISOString(), designId: issue.candidate!.designId, scopeRevision: issue.scopeRevision, checkProfileIds: [...issue.checkProfileIds] };
  store.put('run',run,issue.workspaceId); return run;
}
export function validateQaReport(store: Store, issue: Issue, actor: Actor, report: QaReport) {
  const snapshot = candidateSnapshot(store,issue);
  validateIntegration(store,issue);
  const run = store.get<Run>('run',report.runId);
  if (run.kind !== 'qa' || run.state !== 'RUNNING' || actor.runId !== run.id || run.executionActorId !== actor.id || report.actorId !== actor.id || report.sessionId !== actor.sessionId || issue.qaAssignee !== (actor.principalId ?? actor.id) || report.snapshotId !== snapshot.id || report.candidateId !== issue.candidate!.id || report.sessionId === issue.candidate!.sessionId || run.candidateId !== issue.candidate!.id) throw new DomainError('REVIEW_INDEPENDENCE_REQUIRED','Report must come from this independent assigned QA run');
  verifySnapshot(snapshot,run.executionRoot!,true);
  if (new Set(report.results.map(r => r.criterionId)).size !== issue.criteria.length || report.results.length !== issue.criteria.length || report.results.some(r => !issue.criteria.includes(r.criterionId))) throw new DomainError('QA_COVERAGE_REQUIRED','Report every assigned criterion exactly once');
  const checks = store.list<CheckRun>('check',issue.workspaceId).filter(c => c.runId === run.id);
  if (checks.some(c => ['QUEUED','RUNNING','UNCERTAIN'].includes(c.state))) throw new DomainError('CHECKS_PENDING','All checks must be settled before reporting');
  for (const result of report.results) {
    for (const id of result.evidenceIds) {
      const check = store.get<CheckRun>('check',id);
      if (check.runId !== run.id || check.snapshotId !== snapshot.id || check.actorId !== actor.id || !check.criteria.includes(result.criterionId)) throw new DomainError('EVIDENCE_STALE','Test evidence belongs to another run, snapshot, or criterion');
      if (result.result === 'PASS' && check.state !== 'PASSED') throw new DomainError('EVIDENCE_MISSING','A failed or incomplete check is not passing evidence');
      for (const file of check.testFiles) if (hash(readFileSync(inside(run.executionRoot!,file.path))) !== file.hash) throw new DomainError('EVIDENCE_STALE','Referenced QA test source changed; run a fresh check');
    }
    if (['PASS','FAIL'].includes(result.result) && !result.evidenceIds.length) throw new DomainError('EVIDENCE_MISSING','Passing and failing criteria require captured test evidence; use BLOCKED or NOT_RUN when unavailable');
  }
  if (report.findings.some(f => !issue.criteria.includes(f.criterionId))) throw new DomainError('QA_COVERAGE_REQUIRED','Findings must identify an assigned criterion');
  const referenced = new Set(report.results.flatMap(r => r.evidenceIds));
  if (report.verdict === 'PASS' && (report.results.some(r => r.result !== 'PASS') || report.findings.some(f => f.severity !== 'INFO') || (run.checkProfileIds ?? []).some(id => !checks.some(c => c.profileId === id && c.state === 'PASSED' && referenced.has(c.id))))) throw new DomainError('EVIDENCE_MISSING','QA cannot pass with missing checks, failed criteria, or unresolved findings');
  if (report.verdict === 'FAIL' && (!report.findings.length || !report.results.some(r => r.result === 'FAIL'))) throw new DomainError('FINDING_REQUIRED','QA rejection requires a failed criterion and reproducible finding');
}
export function acceptanceDigest(store: Store, issue: Issue) {
  const snapshot = candidateSnapshot(store,issue);
  for (const [id,stage] of [[issue.initialReview,'PRE_QA'],[issue.qaReview,'QA'],[issue.finalReview,'FINAL']]) {
    if (!id) throw new DomainError('EVIDENCE_MISSING','Current lead and QA reviews are required');
    const review = store.get<any>('review',id);
    if (review.issueId !== issue.id || review.candidateId !== issue.candidate!.id || review.snapshotId !== snapshot.id || review.stage !== stage || review.verdict !== 'PASS') throw new DomainError('EVIDENCE_STALE','Review does not approve the current snapshot');
    if (stage === 'QA') { const report = store.get<QaReport>('qa_report',review.reportId); if (report.verdict !== 'PASS' || report.snapshotId !== snapshot.id || store.get<Run>('run',report.runId).state !== 'SUCCEEDED') throw new DomainError('EVIDENCE_STALE','Independent QA has not completed successfully'); }
  }
  const root = issue.parentId ? store.get<Issue>('issue',issue.parentId) : issue;
  const design = root.designId ? store.get<any>('design',root.designId) : null;
  if (!design || design.status !== 'APPROVED' || design.id !== issue.candidate!.designId) throw new DomainError('APPROVAL_STALE','The candidate must match the current approved design');
  if (design.requirementDescription !== root.description) throw new DomainError('DESIGN_SCOPE_STALE','Current acceptance requires a design bound to the requirement scope');
  const workspace = store.get<Workspace>('workspace',issue.workspaceId);
  if (issue.artifactMode !== 'artifact' && root.designBindingId && root.designBindingId !== workspace.gitBindingId) throw new DomainError('DESIGN_BINDING_STALE','Approve the reopened scope against its current repository binding');
  const git = issue.gitSubmissionId ? store.get<GitSubmission>('git_submission',issue.gitSubmissionId) : null;
  const integration = validateIntegration(store,issue);
  return hash(canonical({ policyVersion: integration ? 3 : 2, designId: issue.candidate!.designId, scopeRevision: issue.scopeRevision, candidateId: issue.candidate!.id, snapshotHash: snapshot.hash, initialReview: issue.initialReview, qaReview: issue.qaReview, finalReview: issue.finalReview, artifactMode: issue.artifactMode, gitBindingId: issue.artifactMode === 'artifact' ? null : workspace.gitBindingId ?? null, git: git ? { id: git.id,bindingId: git.bindingId,sha: git.sha,repository: git.repository,subdirectory: git.subdirectory } : null,...(integration ? { integrationHash: integration.hash } : {}) }));
}
