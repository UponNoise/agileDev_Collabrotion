import type { Design, InboxKind, Issue, Run } from '../src/contracts';
import { translateSentence } from './locales.ts';

export type Locale = 'en' | 'zh-CN';

export interface Sentence {
  key: string;
  values: SentenceValues;
}

export type SentenceValue = string | number | Sentence;
export type SentenceValues = Record<string, SentenceValue>;

export const UNKNOWN_CODE_KEY = 'The service returned a state without a description';

const statusKeys = {
  waitingDesign: 'Waiting for {lead} to write the design',
  writingDesign: '{lead} is writing the design',
  designReview: 'The design awaits your approval',
  changesRequested: 'Waiting for {lead} to revise the design',
  designApproved: 'Design approved; {pm} plans the tasks next',
  ownerQuestion: '{sender} is waiting for your answer',
  progress: '{done} of {total} tasks done',
  progressWithWaiting: '{done} of {total} tasks done, {n} waiting for you',
  ready: 'Ready; waiting for {pm} to dispatch',
  dispatched: 'Dispatched; waiting for a free slot',
  developing: '{dev} is developing',
  reworking: '{dev} is reworking',
  stopped: 'Development stopped; {pm} decides next',
  runUncertain: 'Lost contact with the run; needs you',
  initialReview: "Waiting for {lead}'s initial review",
  finalReview: "QA passed; waiting for {lead}'s final review",
  qaTesting: '{qa} is testing',
  qaWaiting: 'Waiting for independent QA',
  qaUnarranged: 'Waiting for {pm} to arrange QA',
  taskAcceptance: 'Awaiting your acceptance',
  deliveryAcceptance: 'The whole delivery awaits your acceptance',
  acceptedBlocked: 'Accepted; {blocker}',
  acceptedReady: 'Accepted and ready to complete',
  initialReturned: 'Returned at the initial review; rework next',
  finalReturned: 'Returned at the final review; rework next',
  qaFailed: 'QA failed; rework next',
  needsFixes: 'You returned it (needs fixes); rework next',
  needsClarification: 'You returned it (needs clarification); rework next',
  requirementChanged: 'You changed the requirement; {lead} revises the design',
  onHold: 'On hold',
  requirementHeld: 'The requirement is on hold',
  abandoned: 'Abandoned; scope not decided',
  excluded: 'Abandoned and excluded',
  replaced: 'Abandoned; replaced by {keys}',
  done: 'Done'
} as const;

const blockerKeys: Record<string, string> = {
  RUN_UNCERTAIN: statusKeys.runUncertain,
  UNMANAGED_EXECUTION: 'An unrecorded execution needs your confirmation that it stopped',
  DESIGN_APPROVAL_REQUIRED: 'Waiting for design approval',
  DESIGN_SCOPE_STALE: 'The requirement changed; {lead} updates the design',
  DESIGN_BINDING_STALE: 'The repository binding changed; {lead} resubmits the design',
  SCOPE_REVISION_REQUIRED: 'Waiting for a revised design that you approve',
  ASSIGNEE_REQUIRED: 'Waiting for {pm} to assign a developer',
  CRITERIA_REQUIRED: 'The description or criteria are incomplete; {pm} adds them',
  SCOPE_REQUIRED: 'The description or criteria are incomplete; {pm} adds them',
  TASK_SCOPE_INCOMPLETE: 'The description or criteria are incomplete; {pm} adds them',
  CRITERIA_UNMAPPED: 'Some criteria are not mapped; {pm} maps them',
  PLAN_CRITERIA_UNMAPPED: 'Some criteria are not mapped; {pm} maps them',
  PLAN_UNKNOWN_CRITERIA: 'Some criteria are not mapped; {pm} maps them',
  PLAN_OVERLAP_UNEXPLAINED: 'Some criteria overlap; {pm} explains why',
  PLAN_REQUIRED: 'Waiting for {pm} to plan the tasks',
  PLAN_NOT_READY: 'Waiting for {pm} to plan the tasks',
  DELIVERY_SCOPE_REQUIRED: 'Waiting for {pm} to plan the tasks',
  PLAN_STALE: 'The design or tasks changed; {pm} updates the plan',
  DEPENDENCY_BLOCKED: 'Waiting for tasks it depends on',
  CHILDREN_INCOMPLETE: 'Some tasks are not done',
  LEASE_EXPIRED: 'The developer stopped responding; {pm} checks the run',
  RUN_STILL_LIVE: 'Something is still running',
  CHECKS_PENDING: 'Something is still running',
  SCOPE_EXCLUDED: 'Excluded from the delivery',
  SCOPE_DECISION_STALE: 'The scope needs your decision',
  CHILD_DISPOSITION_REQUIRED: 'The scope needs your decision',
  ON_HOLD: 'On hold, or its requirement has stopped',
  ANCESTOR_BLOCKED: 'On hold, or its requirement has stopped',
  DELIVERY_NOT_READY: 'Not at acceptance yet',
  HUMAN_ACCEPTANCE_REQUIRED: statusKeys.taskAcceptance,
  MINOR_ACKNOWLEDGEMENT_REQUIRED: 'New minor problems need another look from you',
  UNRESOLVED_DEFECTS: 'Serious problems are not fixed',
  EVIDENCE_MISSING: 'Review or QA records are incomplete; {lead} looks into it',
  EVIDENCE_STALE: 'The delivered content changed; {lead} checks it again',
  EVIDENCE_DIGEST_UNAVAILABLE: 'The delivered content changed; {lead} checks it again',
  APPROVAL_STALE: 'The delivered content changed; {lead} checks it again',
  INTEGRATION_STALE: 'The delivered content changed; {lead} checks it again',
  CHILD_ACCEPTANCE_STALE: 'The delivered content changed; {lead} checks it again',
  SNAPSHOT_REQUIRED: 'The delivered content changed; {lead} checks it again',
  GIT_VERIFICATION_REQUIRED: 'No commit attached yet; {pm} attaches it',
  GIT_VERIFICATION_PENDING: 'The commit is being verified',
  GIT_EVIDENCE_STALE: 'The commit does not match the delivery; {pm} submits it again',
  COMMIT_SNAPSHOT_MISMATCH: 'The commit does not match the delivery; {pm} submits it again',
  COMMIT_NOT_FOUND: 'The commit link is missing or wrong; {pm} corrects it',
  COMMIT_URL_INVALID: 'The commit link is missing or wrong; {pm} corrects it',
  COMMIT_REPOSITORY_MISMATCH: 'The commit link is missing or wrong; {pm} corrects it',
  GIT_BINDING_REQUIRED: 'The repository binding needs attention in Settings',
  GIT_BINDING_UNAVAILABLE: 'The repository binding needs attention in Settings',
  GIT_WORKSPACE_REQUIRED: 'The repository binding needs attention in Settings',
  REPOSITORY_INVALID: 'The repository binding needs attention in Settings',
  WORKSPACE_IDENTITY_CHANGED: 'The repository binding needs attention in Settings',
  MULTI_REPOSITORY_CLOSURE_UNSUPPORTED: 'A delivery across repositories cannot be completed yet',
  GITHUB_AUTH_REQUIRED: 'GitHub refused access to the repository',
  GITHUB_ACCESS_DENIED: 'GitHub refused access to the repository',
  GITHUB_RATE_LIMITED: 'GitHub is limiting requests; check again later',
  PROVIDER_UNAVAILABLE: 'GitHub cannot be reached, so the commit is not verified yet',
  PROVIDER_REQUEST_FAILED: 'GitHub cannot be reached, so the commit is not verified yet',
  PROVIDER_INVALID_RESPONSE: "GitHub's answer could not be verified",
  PROVIDER_RESPONSE_LIMIT: "GitHub's answer could not be verified",
  UNSUPPORTED_PROVIDER: 'Only commits on GitHub are supported',
  VERIFICATION_INTERRUPTED: 'Verification was interrupted; check again',
  VERIFICATION_COORDINATOR_LOST: 'Verification was interrupted; check again',
  ARTIFACT_POLICY: 'These files cannot be delivered'
};

const errorKeys: Record<string, string> = {
  NOT_READY: 'Not ready: {blockers}',
  INVALID_TRANSITION: 'It has already changed',
  RUN_EXISTS: 'A run has not ended; try again later',
  ROLE_DENIED: 'You cannot do this',
  SCOPE_DENIED: 'You cannot do this',
  HUMAN_CREDENTIAL_DENIED: 'You cannot do this',
  NOT_FOUND: 'It was not found and may be gone',
  STALE_FENCE: 'Ownership of the work has changed',
  EXECUTION_BINDING_REQUIRED: '{pm} must dispatch it first',
  REVIEW_INDEPENDENCE_REQUIRED: 'QA must be independent of the developer',
  UNKNOWN_OPERATION: 'The app and the service differ in version; reopen the app',
  UNAUTHENTICATED: 'The session expired; connect again',
  INVALID_INPUT: 'Check the input',
  TITLE_FORMAT: 'Check the input',
  SCHEDULE_INVALID: 'Check the input',
  IDEMPOTENCY_CONFLICT: 'This differs from an earlier submission; open it again',
  SERVICE_UNAVAILABLE: 'Nothing was recorded; your input is kept',
  INTERNAL_ERROR: 'Nothing was recorded; your input is kept',
  UNREACHABLE: 'Nothing was recorded; your input is kept',
  REQUEST_FAILED: 'Nothing was recorded; your input is kept',
  HARNESS_UNAVAILABLE: '{harness} could not be started',
  LAUNCH_FAILED: '{harness} could not be started',
  PROVIDER_FAILED: 'The model service returned an error; this run produced nothing',
  DSH_SESSION_FAILED: 'The model service returned an error; this run produced nothing',
  EXECUTION_FAILED: 'The model service returned an error; this run produced nothing',
  PROVIDER_ID_REQUIRED: 'The model service returned an error; this run produced nothing',
  PROVIDER_CONFIGURATION_REQUIRED: 'The model settings are incomplete; check the launch settings',
  DSH_PATCH_REQUIRED: 'The model settings are incomplete; check the launch settings',
  INVALID_DSH_PATCH: 'The model settings are incomplete; check the launch settings',
  INVALID_MODEL_SETTING: 'The model settings are incomplete; check the launch settings',
  INVALID_CAPACITY: 'The run limits are invalid; check the launch settings',
  INVALID_BUDGET: 'The run limits are invalid; check the launch settings',
  RUN_TIME_BUDGET: 'Stopped at the time limit',
  INTERRUPTED: 'Stopped as requested',
  INTERRUPTED_BEFORE_LAUNCH: 'Stopped as requested',
  OWNERSHIP_LOST: 'The assignment changed; this run stopped',
  DISPATCH_STALE: 'The assignment changed; this run stopped',
  CONSULT_STALE: 'The assignment changed; this run stopped',
  QUESTION_ALREADY_ANSWERED: 'The assignment changed; this run stopped',
  COORDINATOR_LOST: 'The service was interrupted; whether it stopped is unknown',
  SHUTDOWN_UNCONFIRMED: 'The service was interrupted; whether it stopped is unknown',
  STOP_UNCONFIRMED: 'The service was interrupted; whether it stopped is unknown',
  CHECK_STOP_UNCONFIRMED: 'The service was interrupted; whether it stopped is unknown',
  CHECK_COORDINATOR_LOST: 'The service was interrupted; whether it stopped is unknown',
  CHECK_TIMEOUT: 'The test ran out of time',
  CHECK_OUTPUT_LIMIT: 'The test printed too much',
  CHECK_LAUNCH_FAILED: 'The test could not be started',
  CHECK_PREPARATION_FAILED: 'The test could not be started',
  EXTERNAL_STOP_CONFIRMED: 'Stopped, as you confirmed',
  SUBMISSION_REQUIRED: 'The run ended without a delivery',
  SNAPSHOT_REQUIRED: 'The run ended without a delivery',
  QA_REPORT_REQUIRED: 'QA ended without a valid report',
  QA_EVIDENCE_INVALID: 'QA ended without a valid report',
  QA_RUN_UNAVAILABLE: 'QA ended without a valid report',
  QA_RUN_STOPPED: 'QA ended without a valid report',
  QA_BLOCKED: 'QA was blocked',
  CONSULT_REPLY_REQUIRED: 'No reply was sent',
  WORKSPACE_DIRTY: 'The workspace has uncommitted changes; not started',
  DEPENDENCY_LINK_FAILED: 'The isolated directory could not be prepared',
  DEPENDENCY_LINK_CONFLICT: 'The isolated directory could not be prepared',
  DEPENDENCY_LINK_CLEANUP_FAILED: 'The isolated directory could not be prepared',
  INVALID_EXECUTION_DEPENDENCIES: 'The isolated directory could not be prepared',
  EXECUTION_ROOT_INVALID: 'The isolated directory could not be prepared',
  EXECUTION_ROOT_EXISTS: 'The isolated directory could not be prepared',
  RUN_ID_INVALID: 'The isolated directory could not be prepared',
  SNAPSHOT_LIMIT: 'The delivery could not be sealed',
  UNMERGED_ARTIFACT: 'The delivery could not be sealed',
  SNAPSHOT_NORMALIZATION_UNAVAILABLE: 'The delivery could not be sealed',
  SNAPSHOT_ROOT_INVALID: 'The delivery could not be sealed',
  ARTIFACT_POLICY: 'These files cannot be delivered',
  WAKE_DISABLED: 'Not woken: turned off in Settings',
  WAKE_UNAVAILABLE: 'Not woken: the agent is not available',
  WAKE_BUDGET_EXHAUSTED: "Not woken: today's limit is used up",
  WAKE_NESTED: 'Not woken: an answering run cannot wake others',
  WAKE_UNCERTAIN: 'Not woken: an earlier run is not confirmed stopped',
  CONSULT_REPLY_ONLY: 'A consult can answer only its own question, once',
  CONSULT_REPLY_ALREADY_SENT: 'A consult can answer only its own question, once',
  VERSION_CONFLICT: 'This was based on an older version; reload it',
  RUN_UNCERTAIN: statusKeys.runUncertain,
  APPROVAL_STALE: 'The delivered content changed; {lead} checks it again',
  EVIDENCE_STALE: 'The delivered content changed; {lead} checks it again',
  DESIGN_SCOPE_STALE: 'The requirement changed; {lead} updates the design',
  DECISION_RISKS_STALE: 'The problems changed; review them again',
  SCOPE_CONTEXT_STALE: 'The scope changed; review it again',
  DEFECT_OBSERVATION_REQUIRED: 'The delivery observation changed; review it again'
};

const historyKeys = {
  created: 'created',
  edited: 'edited',
  wroteDesign: 'wrote the design',
  submittedDesign: 'submitted the design',
  approvedDesign: 'approved the design',
  requestedChanges: 'requested changes',
  planned: 'planned the tasks',
  assigned: 'assigned it to {name}',
  arrangedQa: 'arranged QA by {name}',
  dispatched: 'dispatched it to {name}',
  started: 'started',
  delivered: 'delivered for initial review',
  passedInitial: 'passed the initial review',
  returnedInitial: 'returned at the initial review',
  passedQa: 'passed QA',
  failedQa: 'failed QA',
  passedFinal: 'passed the final review',
  returnedFinal: 'returned at the final review',
  attachedCommit: 'attached a commit',
  verifiedCommit: 'verified the commit',
  couldNotVerify: 'could not verify the commit',
  acceptedDelivery: 'accepted the delivery',
  sentBack: 'sent the delivery back ({kind})',
  completed: 'completed it',
  held: 'held',
  resumed: 'resumed',
  abandoned: 'abandoned',
  reopened: 'reopened',
  excludedScope: 'excluded the scope',
  replacedScope: 'replaced the scope',
  restoredScope: 'restored the scope',
  lostRun: 'lost contact with the run',
  confirmedStop: 'confirmed that the run stopped',
  reported: 'reported a problem',
  confirmedProblem: 'confirmed a problem',
  ruledOut: 'ruled out a problem',
  converted: 'converted a problem into a requirement',
  withdrew: 'withdrew a problem',
  deferredProblem: 'deferred a problem',
  asked: 'asked',
  answered: 'answered',
  leftNote: 'left a note',
  woke: 'woke {harness}',
  granted: 'granted {name}',
  revoked: 'revoked the grant',
  used: 'used the grant'
} as const;

const severityKeys: Record<string, string> = {
  BLOCKER: 'Blocker',
  MAJOR: 'Major',
  MINOR: 'Minor',
  INFO: 'Info'
};

const kindKeys: Record<InboxKind, string> = {
  DESIGN_REVIEW: 'Design approval',
  DELIVERY_ACCEPTANCE: 'Delivery acceptance',
  SCOPE_DECISION: 'Scope decision',
  RUN_RECONCILE: 'Lost run',
  CLOSURE_BLOCKED: 'Waiting to close',
  DEFECT_TRIAGE: 'Problem report',
  AGENT_QUESTION: 'Agent question'
};

const rejectionKeys: Record<string, string> = {
  DEFECT: 'Needs fixes',
  SCOPE_CHANGE: 'Requirement changed',
  CLARIFICATION: 'Needs clarification'
};

export interface PartyNames {
  lead: string;
  pm: string;
  dev: string;
  qa: string;
}

export interface PartyActor {
  role: 'lead' | 'pm' | 'worker' | 'qa';
  name: string;
}

export function resolvePartyNames(
  actors: readonly PartyActor[],
  recorded: Partial<Record<keyof PartyNames, string | null | undefined>> | null | undefined,
  roleWords: PartyNames
): PartyNames {
  const pick = (party: keyof PartyNames, role: PartyActor['role']): string => {
    const name = recorded?.[party]?.trim();
    if (name) return name;
    const matches = actors.filter((actor) => actor.role === role && actor.name.trim());
    return matches.length === 1 ? matches[0]!.name : roleWords[party];
  };
  return { lead: pick('lead', 'lead'), pm: pick('pm', 'pm'), dev: pick('dev', 'worker'), qa: pick('qa', 'qa') };
}

export interface IssueStatusInput {
  state: Issue['state'];
  stage?: Issue['stage'];
  isTask: boolean;
  parentState?: Issue['state'] | null;
  designStatus?: Design['status'] | null;
  planReady?: boolean;
  blockers?: readonly string[];
  questionFrom?: string | null;
  progress?: { done: number; total: number; waiting: number } | null;
  run?: { state: Run['state']; rework?: boolean } | null;
  accepted?: boolean;
  rejection?: {
    stage?: 'PRE_QA' | 'QA' | 'FINAL' | 'USER' | null;
    classification?: 'DEFECT' | 'SCOPE_CHANGE' | 'CLARIFICATION' | null;
  } | null;
  abandonment?: { status: 'UNDECIDED' | 'EXCLUDED' | 'REPLACED'; replacementKeys?: readonly string[] } | null;
  names: PartyNames;
}

export function renderSentence(
  sentence: Sentence,
  locale: Locale,
  translator: (locale: Locale, source: string) => string = translateSentence
): string {
  const template = translator(locale, sentence.key);
  return template.replace(/\{([a-z0-9_]+)\}/gi, (placeholder, name: string) => {
    const value = sentence.values[name];
    if (value === undefined) return placeholder;
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : renderSentence(value, locale, translator);
  });
}

export function unknownCodeSentence(code: string): Sentence {
  return { key: UNKNOWN_CODE_KEY, values: { code } };
}

function ownKey(map: Record<string, string>, code: string): string | undefined {
  return Object.hasOwn(map, code) ? map[code] : undefined;
}

export function blockerSentence(code: string, values: SentenceValues = {}): Sentence {
  const key = ownKey(blockerKeys, code);
  return key ? { key, values } : unknownCodeSentence(code);
}

export function errorSentence(code: string, values: SentenceValues = {}): Sentence {
  const key = ownKey(errorKeys, code);
  return key ? { key, values } : unknownCodeSentence(code);
}

export const runResultSentence = errorSentence;
export const wakeReasonSentence = errorSentence;

export function hasSentence(code: string): boolean {
  return Object.hasOwn(blockerKeys, code) || Object.hasOwn(errorKeys, code);
}

export function codeSentence(code: string, values: SentenceValues = {}): Sentence {
  if (Object.hasOwn(blockerKeys, code)) return blockerSentence(code, values);
  if (Object.hasOwn(errorKeys, code)) return errorSentence(code, values);
  return unknownCodeSentence(code);
}

export function severitySentence(severity: string): Sentence {
  const key = ownKey(severityKeys, severity);
  return key ? { key, values: {} } : unknownCodeSentence(severity);
}

export function kindSentence(kind: string): Sentence {
  const key = ownKey(kindKeys, kind);
  return key ? { key, values: {} } : unknownCodeSentence(kind);
}

export function rejectionSentence(classification: string): Sentence {
  const key = ownKey(rejectionKeys, classification);
  return key ? { key, values: {} } : unknownCodeSentence(classification);
}

export function allSentenceKeys(): string[] {
  return [
    ...new Set([
      ...Object.values(statusKeys),
      ...Object.values(blockerKeys),
      ...Object.values(errorKeys),
      ...Object.values(historyKeys),
      ...Object.values(severityKeys),
      ...Object.values(kindKeys),
      ...Object.values(rejectionKeys),
      UNKNOWN_CODE_KEY
    ])
  ];
}

const machineEvents = new Set([
  'work_heartbeat',
  'connection_initialized',
  'run_starting',
  'run_finished',
  'run_reconciled',
  'qa_dispatched',
  'qa_check_run',
  'qa_check_finished',
  'qa_report_submit',
  'delivery_sealed',
  'candidate_invalidated',
  'design_invalidated',
  'child_started',
  'child_reopened',
  'child_scope_changed',
  'scope_child_added',
  'scope_amended',
  'scope_git_binding_set',
  'dependency_add',
  'dependency_set',
  'git_retry',
  'git_verification_started',
  'git_verification_interrupted',
  'legacy_qa_defect_resolved',
  'consult_declined'
]);

export interface HistoryEventData {
  state?: string;
  stage?: string | null;
  decision?: string;
  verdict?: string;
  kind?: string;
  action?: string;
  harness?: string;
  name?: string;
  classification?: string;
  changes?: Record<string, { before?: unknown; after?: unknown } | undefined>;
  [key: string]: unknown;
}

export function historySentence(operation: string, data: HistoryEventData = {}): Sentence | null {
  if (machineEvents.has(operation) || operation.startsWith('iteration_') || operation.endsWith('_settings_update')) {
    return null;
  }
  const before = (field: string) => data.changes?.[field]?.before;
  const after = (field: string) => data.changes?.[field]?.after;
  const simple = (key: string, values: SentenceValues = {}): Sentence => ({ key, values });
  const named = (key: string): Sentence =>
    simple(key, typeof data.name === 'string' ? { name: data.name } : {});
  switch (operation) {
    case 'issue_create':
      return simple(historyKeys.created);
    case 'issue_update':
      return simple(historyKeys.edited);
    case 'design_set':
      return simple(historyKeys.wroteDesign);
    case 'design_submit':
      return simple(historyKeys.submittedDesign);
    case 'design_decide':
      return simple(data.decision === 'APPROVED' ? historyKeys.approvedDesign : historyKeys.requestedChanges);
    case 'plan_apply':
      return simple(historyKeys.planned);
    case 'issue_assign':
      return named(historyKeys.assigned);
    case 'qa_configure':
      return named(historyKeys.arrangedQa);
    case 'work_dispatch':
      return named(historyKeys.dispatched);
    case 'work_claim':
      return simple(historyKeys.started);
    case 'work_submit':
      return simple(historyKeys.delivered);
    case 'review_submit': {
      const final = before('stage') === 'FINAL' || data.stage === 'FINAL';
      const passed = data.verdict === 'PASS';
      return simple(
        passed
          ? final
            ? historyKeys.passedFinal
            : historyKeys.passedInitial
          : final
            ? historyKeys.returnedFinal
            : historyKeys.returnedInitial
      );
    }
    case 'qa_review_completed':
      if (data.verdict === 'PASS') return simple(historyKeys.passedQa);
      if (data.verdict === 'FAIL') return simple(historyKeys.failedQa);
      if (data.verdict === 'BLOCKED') return simple('QA was blocked');
      return simple(operation);
    case 'git_submit':
      return simple(historyKeys.attachedCommit);
    case 'git_verification_finished':
      return simple(data.state === 'VERIFIED' ? historyKeys.verifiedCommit : historyKeys.couldNotVerify);
    case 'delivery_decide':
      return data.state === 'USER_REJECTED' ? null : simple(historyKeys.acceptedDelivery);
    case 'delivery_rejection_classified': {
      const classification = data.classification;
      if (classification !== 'DEFECT' && classification !== 'SCOPE_CHANGE' && classification !== 'CLARIFICATION') return null;
      return simple(historyKeys.sentBack, { kind: rejectionSentence(classification) });
    }
    case 'delivery_complete':
      return simple(historyKeys.completed);
    case 'issue_transition': {
      const beforeState = before('state');
      const afterState = after('state');
      if (afterState === 'ON_HOLD') return simple(historyKeys.held);
      if (afterState === 'ABANDONED') return simple(historyKeys.abandoned);
      if (beforeState === 'ON_HOLD') return simple(historyKeys.resumed);
      if (beforeState === 'DONE' || beforeState === 'ABANDONED') return simple(historyKeys.reopened);
      return simple(operation);
    }
    case 'scope_decide': {
      if (data.action === 'EXCLUDE') return simple(historyKeys.excludedScope);
      if (data.action === 'REPLACE') return simple(historyKeys.replacedScope);
      if (data.action === 'RESTORE') return simple(historyKeys.restoredScope);
      return simple(operation);
    }
    case 'run_reconcile':
    case 'work_reconcile':
      return simple(historyKeys.confirmedStop);
    case 'run_uncertain':
      return simple(historyKeys.lostRun);
    case 'defect_created':
    case 'defect_propose':
    case 'defect_report':
      return simple(historyKeys.reported);
    case 'defect_triaged': {
      if (data.action === 'REJECT') return simple(historyKeys.ruledOut);
      if (data.action === 'NEW_REQUIREMENT') return simple(historyKeys.converted);
      if (data.action === 'DEFER') return simple(historyKeys.deferredProblem);
      if (data.action === 'CONFIRM') return simple(historyKeys.confirmedProblem);
      return data.action === 'REOPEN' ? null : simple(operation);
    }
    case 'defect_withdrawn':
      return simple(historyKeys.withdrew);
    case 'message_sent': {
      if (data.kind === 'QUESTION') return simple(historyKeys.asked);
      if (data.kind === 'REPLY') return simple(historyKeys.answered);
      if (data.kind === 'NOTE') return simple(historyKeys.leftNote);
      return simple(operation);
    }
    case 'consult_queued':
      return simple(historyKeys.woke, typeof data.harness === 'string' ? { harness: data.harness } : {});
    case 'grant_create':
      return named(historyKeys.granted);
    case 'grant_revoke':
      return simple(historyKeys.revoked);
    case 'grant_used':
      return simple(historyKeys.used);
    default:
      return simple(operation);
  }
}

export function statusSentence(input: IssueStatusInput): Sentence {
  const base = (key: string, extra: SentenceValues = {}): Sentence => ({ key, values: { ...input.names, ...extra } });
  const names: SentenceValues = { ...input.names };
  const run = input.run;
  const dispatched = run !== undefined && run !== null && (run.state === 'QUEUED' || run.state === 'STARTING');
  if (run?.state === 'UNCERTAIN') return base(statusKeys.runUncertain);
  if (dispatched && ['NOT_STARTED', 'LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED'].includes(input.state)) {
    return base(statusKeys.dispatched);
  }
  const progressValue = input.progress;
  const hasTasks = (progressValue?.total ?? 0) > 0;
  const progress = (): Sentence => {
    const value = progressValue ?? { done: 0, total: 0, waiting: 0 };
    return value.waiting > 0
      ? base(statusKeys.progressWithWaiting, { done: value.done, total: value.total, n: value.waiting })
      : base(statusKeys.progress, { done: value.done, total: value.total });
  };
  const active = (): Sentence | null => {
    if (!run) return null;
    if (dispatched) return base(statusKeys.dispatched);
    if (run.state === 'RUNNING' || run.state === 'STOPPING') {
      return base(run.rework ? statusKeys.reworking : statusKeys.developing);
    }
    return null;
  };
  const direct = (): Sentence => active() ?? base(statusKeys.stopped);
  if (input.isTask && input.parentState === 'ON_HOLD' && !['ON_HOLD', 'DONE', 'ABANDONED'].includes(input.state)) {
    return base(statusKeys.requirementHeld);
  }
  if (!input.isTask && input.state === 'NOT_STARTED' && input.questionFrom) {
    return base(statusKeys.ownerQuestion, { sender: input.questionFrom });
  }
  switch (input.state) {
    case 'NOT_STARTED': {
      if (!input.isTask) {
        const design = input.designStatus;
        if (!design) return base(statusKeys.waitingDesign);
        if (design === 'DRAFT') return base(statusKeys.writingDesign);
        if (design === 'IN_REVIEW') return base(statusKeys.designReview);
        if (design === 'CHANGES_REQUESTED') return base(statusKeys.changesRequested);
        if (!input.planReady) return base(statusKeys.designApproved);
        if (hasTasks) return progress();
        const running = active();
        if (running) return running;
        const first = input.blockers?.[0];
        if (first) return blockerSentence(first, names);
        return base(statusKeys.ready);
      }
      const running = active();
      if (running) return running;
      const first = input.blockers?.[0];
      return first ? blockerSentence(first, names) : base(statusKeys.ready);
    }
    case 'IN_PROGRESS': {
      if (!input.isTask) return hasTasks ? progress() : direct();
      return direct();
    }
    case 'LEAD_REVIEW':
      return base(input.stage === 'FINAL' ? statusKeys.finalReview : statusKeys.initialReview);
    case 'QA_TEST': {
      if (dispatched) return base(statusKeys.qaWaiting);
      if (run && (run.state === 'RUNNING' || run.state === 'STOPPING')) return base(statusKeys.qaTesting);
      return base(statusKeys.qaUnarranged);
    }
    case 'USER_ACCEPTANCE': {
      if (input.accepted) {
        const first = input.blockers?.[0];
        return first
          ? base(statusKeys.acceptedBlocked, { blocker: blockerSentence(first, names) })
          : base(statusKeys.acceptedReady);
      }
      return base(input.isTask ? statusKeys.taskAcceptance : statusKeys.deliveryAcceptance);
    }
    case 'LEAD_REJECTED': {
      if (dispatched) return base(statusKeys.dispatched);
      const rejectedAt = input.rejection?.stage;
      const stage = rejectedAt === 'FINAL' || rejectedAt === 'PRE_QA' ? rejectedAt : input.stage;
      return base(stage === 'FINAL' ? statusKeys.finalReturned : statusKeys.initialReturned);
    }
    case 'QA_REJECTED':
      return dispatched ? base(statusKeys.dispatched) : base(statusKeys.qaFailed);
    case 'USER_REJECTED': {
      if (dispatched) return base(statusKeys.dispatched);
      const classification = input.rejection?.classification;
      if (classification === 'SCOPE_CHANGE') return base(statusKeys.requirementChanged);
      return base(classification === 'CLARIFICATION' ? statusKeys.needsClarification : statusKeys.needsFixes);
    }
    case 'ON_HOLD':
      return base(statusKeys.onHold);
    case 'ABANDONED': {
      const status = input.abandonment?.status ?? 'UNDECIDED';
      if (status === 'EXCLUDED') return base(statusKeys.excluded);
      if (status === 'REPLACED') return base(statusKeys.replaced, { keys: (input.abandonment?.replacementKeys ?? []).join(', ') });
      return base(statusKeys.abandoned);
    }
    case 'DONE':
      return base(statusKeys.done);
    default:
      return unknownCodeSentence(input.state);
  }
}
