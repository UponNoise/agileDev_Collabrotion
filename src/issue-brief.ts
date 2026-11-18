import type { Actor, Design, Issue, Operation, Run } from './contracts.js';
import type { DefectRecord } from './defect-contracts.js';

export interface IssueAction {
  operation: Operation;
  args: Record<string, unknown>;
}

type Party = Actor['role'] | 'coordinator' | 'git_verifier';
export interface Remedy {
  role: Party;
  operation?: Operation;
}

const remedies: Record<string, [message: string, role: Party, operation?: Operation]> = {
  DESIGN_APPROVAL_REQUIRED: ['Approve the current requirement design.', 'human', 'design_decide'],
  DESIGN_SCOPE_STALE: ['Revise the design for the current requirement scope.', 'lead', 'design_set'],
  DESIGN_BINDING_STALE: ['Revise the design for the current repository binding.', 'lead', 'design_set'],
  SCOPE_REVISION_REQUIRED: ['Submit a revised design for human approval.', 'lead', 'design_set'],
  ASSIGNEE_REQUIRED: ['Assign a worker and harness.', 'pm', 'issue_assign'],
  CRITERIA_REQUIRED: ['Set the criteria for this issue.', 'pm', 'issue_update'],
  SCOPE_REQUIRED: ['Describe the deliverable and its scope.', 'pm', 'issue_update'],
  CRITERIA_UNMAPPED: ['Map the issue criteria to the approved design.', 'pm', 'issue_update'],
  DEPENDENCY_BLOCKED: ['Resolve the unfinished dependencies.', 'pm'],
  CHILDREN_INCOMPLETE: ['Finish the in-scope children.', 'pm'],
  SCOPE_EXCLUDED: ['Restore this issue to the delivery scope.', 'human', 'scope_decide'],
  SCOPE_DECISION_STALE: ['Review the changed scope decision.', 'human', 'scope_decide'],
  ON_HOLD: ['Resume the issue or its held requirement.', 'human', 'issue_transition'],
  ANCESTOR_BLOCKED: ['Resolve the requirement that blocks this issue.', 'human'],
  UNMANAGED_EXECUTION: ['Reconcile the previous execution before dispatch.', 'human', 'work_reconcile'],
  LEASE_EXPIRED: ['Inspect the previous run before recovering ownership.', 'pm', 'run_list'],
  RUN_STILL_LIVE: ['Wait for the current execution to settle.', 'coordinator'],
  HUMAN_ACCEPTANCE_REQUIRED: ['Review and accept the current delivery.', 'human', 'delivery_decide'],
  UNRESOLVED_DEFECTS: ['Review the open defects before completion.', 'lead', 'defect_list'],
  GIT_VERIFICATION_REQUIRED: ['Submit the current candidate commit for verification.', 'pm', 'git_submit'],
  GIT_VERIFICATION_PENDING: ['Wait for verification of the submitted commit.', 'git_verifier'],
  GIT_EVIDENCE_STALE: ['Review the submitted commit and its candidate binding.', 'pm', 'evidence_get'],
  GIT_BINDING_REQUIRED: ['Bind the workspace to the delivery repository.', 'human', 'workspace_git_bind'],
  EVIDENCE_STALE: ['Inspect the delivery evidence and reconcile changed artifacts.', 'lead'],
  EVIDENCE_MISSING: ['Inspect the required delivery evidence.', 'lead'],
  APPROVAL_STALE: ['Review the current design and delivery.', 'lead'],
  COMMIT_SNAPSHOT_MISMATCH: ['Submit a commit matching the sealed snapshot.', 'pm', 'git_submit'],
  MULTI_REPOSITORY_CLOSURE_UNSUPPORTED: ['Inspect the repository references before closing.', 'lead', 'evidence_get']
};

const commandRemedies: Record<string, [action: string, role: Party | 'caller', operation?: Operation]> = {
  VERSION_CONFLICT: ['Reload the issue, run, defect or iteration before retrying with its current version.', 'caller'],
  IDEMPOTENCY_CONFLICT: ['Replay with the original arguments or use a fresh key for a new intent.', 'caller'],
  INVALID_INPUT: ['Correct the arguments using the command input schema.', 'caller'],
  UNKNOWN_OPERATION: ['Use an operation from the current tool catalog.', 'caller'],
  ROLE_DENIED: ['Use an operation in this role profile or ask the responsible role to act.', 'caller'],
  SCOPE_DENIED: ['Select a target in your assigned scope or ask the owner to inspect access.', 'caller'],
  UNAUTHENTICATED: ['Ask the owner to verify the credential and reconnect.', 'human'],
  NOT_FOUND: ['Refresh the scoped target list before retrying.', 'caller'],
  NOT_READY: ['Read the current brief and resolve its blockers before retrying.', 'caller', 'issue_get'],
  STALE_FENCE: ['Read the current lease and ask PM to reconcile if ownership changed.', 'caller', 'issue_get'],
  RUN_UNCERTAIN: ['Confirm the previous execution stopped before reconciling.', 'human', 'run_reconcile'],
  EXECUTION_BINDING_REQUIRED: ['Queue a managed assignment at the approved scope.', 'pm', 'work_dispatch'],
  REVIEW_INDEPENDENCE_REQUIRED: ['Check the current independent QA assignment and its sealed snapshot.', 'qa', 'issue_get'],
  APPROVAL_STALE: ['Refresh the reviewed issue and present the current evidence for a new decision.', 'caller', 'issue_get'],
  SERVICE_UNAVAILABLE: ['Ask the owner to inspect the local service and reconnect when available.', 'human'],
  INTERNAL_ERROR: ['Ask the owner to inspect the local service before retrying.', 'human']
};

export function commandFailure(code: string, message: string, details?: unknown) {
  const rule = Object.hasOwn(commandRemedies, code) ? commandRemedies[code] : undefined;
  const blocker = Object.hasOwn(remedies, code) ? remedies[code] : undefined;
  const [action, role, operation] = rule ?? blocker ?? ['Inspect the current evidence before retrying.', 'caller'];
  return { code, message, details: details ?? null, remedy: { role, action, ...(operation ? { operation } : {}) } };
}

export function blockerDetail(code: string, issueId: string, retryGit: boolean) {
  const rule = Object.hasOwn(remedies, code) ? remedies[code] : undefined;
  const [message, role, operation] = rule ?? (
    code.startsWith('PLAN_') || ['DELIVERY_SCOPE_REQUIRED', 'TASK_SCOPE_INCOMPLETE'].includes(code)
      ? ['Update the plan to cover the approved scope.', 'pm', 'plan_apply'] as const
      : retryGit
        ? ['Inspect and retry the submitted Git evidence.', 'pm', 'git_retry'] as const
        : ['Inspect the issue evidence and resolve the reported blocker.', 'lead'] as const
  );
  return { code, message, subjects: [issueId], remedy: { role, ...(operation ? { operation } : {}) } };
}

export function issueStatus(issue: Issue, ready: boolean) {
  const status: Record<Issue['state'], string> = {
    NOT_STARTED: ready ? 'Ready for managed dispatch.' : 'Waiting for dispatch prerequisites.',
    IN_PROGRESS: issue.lease ? 'Implementation has a managed lease.' : 'Waiting for the next implementation step.',
    LEAD_REVIEW: issue.stage === 'FINAL' ? 'Awaiting final lead review.' : 'Awaiting initial lead review.',
    LEAD_REJECTED: 'Lead review requested rework.',
    QA_TEST: 'Awaiting independent QA.',
    QA_REJECTED: 'Independent QA requested rework.',
    USER_ACCEPTANCE: 'At the human delivery and completion gate.',
    USER_REJECTED: 'Human review requested changes.',
    ON_HOLD: 'Work is on hold.',
    ABANDONED: 'Work was abandoned.',
    DONE: 'Delivery is complete.'
  };
  return status[issue.state];
}

export function waitingParty(issue: Issue, design: Design | null, activeRun: Run | undefined, blockers: ReturnType<typeof blockerDetail>[], hasAction: boolean) {
  if (hasAction || issue.state === 'DONE' || issue.state === 'ABANDONED') return null;
  if (activeRun?.state === 'UNCERTAIN') return { role: 'human', reason: 'Reconcile the uncertain run.' };
  if (activeRun && ['QUEUED', 'STARTING', 'STOPPING'].includes(activeRun.state)) {
    return { role: 'coordinator', reason: 'Wait for the managed run to settle.' };
  }
  if (issue.state === 'QA_TEST') return activeRun
    ? { role: 'qa', reason: 'The assigned QA run owns the review.' }
    : { role: 'pm', reason: 'Configure and queue independent QA.' };
  if (issue.state === 'LEAD_REVIEW') return { role: 'lead', reason: issueStatus(issue, false) };
  if (issue.state === 'IN_PROGRESS' && issue.lease && !blockers.some(blocker => ['LEASE_EXPIRED','UNMANAGED_EXECUTION','ON_HOLD'].includes(blocker.code))) {
    return { role: 'worker', reason: 'The assigned execution owns the lease.' };
  }
  if (design?.status === 'DRAFT' || design?.status === 'CHANGES_REQUESTED') {
    const designBlocker = blockers.find(blocker => blocker.code === 'DESIGN_APPROVAL_REQUIRED');
    if (designBlocker && designBlocker === blockers[0]) return { role: 'lead', reason: designBlocker.message };
  }
  const blocker = blockers[0];
  if (blocker) return { role: blocker.remedy.role, reason: blocker.message };
  return { role: 'pm', reason: 'Coordinate the next dispatch or handoff.' };
}

export function briefText(value: string, bytes: number) {
  if (Buffer.byteLength(JSON.stringify(value)) - 2 <= bytes) return value;
  let length = 0;
  let result = '';
  for (const character of value) {
    length += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (length > bytes - 3) break;
    result += character;
  }
  return result + '…';
}

export function briefIssue(issue: Issue, title = issue.title) {
  const { id, workspaceId, key, parentId, state, stage, version, scopeRevision, fence, candidate } = issue;
  return {
    id, workspaceId, key, parentId, state, stage, version, scopeRevision, fence,
    title: briefText(title, 96),
    candidate: candidate ? { id: candidate.id, snapshotId: candidate.snapshotId } : null
  };
}

export function briefDefect(defect: DefectRecord) {
  const { id, issueId, key, version, origin, state, severity } = defect;
  return { id, issueId, key, version, origin, state, severity, actual: briefText(defect.actual, 120) };
}

export function briefRun(run: Run) {
  const { id, issueId, version, kind, state, harness, actorId, errorCode, createdAt, finishedAt } = run;
  return { id, issueId, version, kind, state, harness, actorId, errorCode, createdAt, finishedAt };
}
