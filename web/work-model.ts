import type { Actor, Design, Harness, InboxKind, Issue, Run } from '../src/contracts';
import type { DisplayIssue, InboxEntry, IssueData, WorkspaceData } from './api';
import { listGroup } from './decision-model.ts';
import { historySentence, resolvePartyNames, statusSentence } from './sentences.ts';
import type { HistoryEventData, IssueStatusInput, PartyActor, PartyNames, Sentence } from './sentences.ts';

export type StatusIconKind = 'todo' | 'dev' | 'review' | 'you' | 'done' | 'rework' | 'crit' | 'hold' | 'gone';

export interface RequirementProgress {
  done: number;
  total: number;
  waiting: number;
}

export interface BoardColumn {
  id: 'todo' | 'dev' | 'review' | 'qa' | 'acceptance' | 'done';
  labelKey: string;
  icon: StatusIconKind;
  progress?: number;
  items: DisplayIssue[];
}

export interface IssueStep {
  id: string;
  labelKey: string;
  status: 'done' | 'cur' | 'todo';
}

export type MoreActionKind =
  | 'scope'
  | 'plan'
  | 'design'
  | 'design_submit'
  | 'decomposition'
  | 'create_task'
  | 'assignment'
  | 'qa'
  | 'dispatch'
  | 'git'
  | 'grants'
  | 'restore'
  | 'hold'
  | 'resume'
  | 'abandon'
  | 'reopen';

export interface MoreAction {
  id: MoreActionKind;
  labelKey: string;
  group: 'forms' | 'lifecycle';
}

export function isNeedsYou(entry: Pick<InboxEntry, 'kind' | 'blocking' | 'defect'>): boolean {
  return listGroup(entry) === 'needs-you';
}

export function isActionableEntry(entry: Pick<InboxEntry, 'kind' | 'blocking' | 'defect' | 'status'>): boolean {
  return isNeedsYou(entry) || (entry.kind === 'CLOSURE_BLOCKED' && entry.status === 'READY_TO_COMPLETE');
}

export type ActiveRunLike = Pick<Run, 'id' | 'issueId' | 'kind' | 'state' | 'actorId' | 'harness' | 'createdAt'> & {
  startedAt?: string | null;
};

export type WorkData = WorkspaceData & { blockersByIssue?: ReadonlyMap<string, readonly string[]> };

export function activeRunForIssue(runs: readonly ActiveRunLike[], issueId: string): ActiveRunLike | null {
  return runs.find((run) => run.issueId === issueId && run.kind !== 'consult') ?? null;
}

export function requirementProgress(
  requirementId: string,
  issues: readonly DisplayIssue[],
  entries: readonly Pick<InboxEntry, 'issueId' | 'kind' | 'blocking' | 'defect'>[]
): RequirementProgress {
  const children = issues.filter((issue) => issue.parentId === requirementId);
  const inScope = children.filter((child) => child.state !== 'ABANDONED' && child.scope?.status !== 'EXCLUDED');
  const childIds = new Set(children.map((child) => child.id));
  const waiting = entries.filter(
    (entry) => isNeedsYou(entry) && (entry.issueId === requirementId || childIds.has(entry.issueId))
  ).length;
  return {
    done: inScope.filter((child) => child.state === 'DONE').length,
    total: inScope.length,
    waiting
  };
}

function agentParties(actors: readonly Actor[]): PartyActor[] {
  return actors.filter(
    (actor): actor is Actor & { role: PartyActor['role'] } => actor.role !== 'human'
  );
}

function actorName(actors: readonly Actor[], id?: string | null): string | null {
  if (!id) return null;
  return actors.find((actor) => actor.id === id)?.name ?? null;
}

export function partyNamesForIssue(
  actors: readonly Actor[],
  issue: Pick<Issue, 'assignee' | 'qaAssignee'>,
  roleWords: PartyNames
): PartyNames {
  return resolvePartyNames(
    agentParties(actors),
    { dev: actorName(actors, issue.assignee), qa: actorName(actors, issue.qaAssignee) },
    roleWords
  );
}

export function issueStatusForWorkspace(
  issue: DisplayIssue,
  workspace: Pick<WorkData, 'issues' | 'designs' | 'actors' | 'activeRuns' | 'blockersByIssue'>,
  entries: readonly InboxEntry[],
  roleWords: PartyNames
): Sentence {
  const byId = new Map(workspace.issues.map((item) => [item.id, item]));
  const parent = issue.parentId ? byId.get(issue.parentId) ?? null : null;
  const designId = parent?.designId ?? issue.designId;
  const designStatus = workspace.designs.find((design) => design.id === designId)?.status ?? null;
  const run = activeRunForIssue(workspace.activeRuns, issue.id);
  const mine = entries.filter((entry) => entry.issueId === issue.id);
  const question = mine.find((entry) => entry.kind === 'AGENT_QUESTION');
  const closure = mine.find((entry) => entry.kind === 'CLOSURE_BLOCKED');
  const progress = !issue.parentId ? requirementProgress(issue.id, workspace.issues, entries) : null;
  const hasChildren = !issue.parentId && workspace.issues.some((child) => child.parentId === issue.id);
  const blockers = closure
    ? closure.blockers
    : workspace.blockersByIssue?.get(issue.id) ?? mine.flatMap((entry) => entry.blockers).concat(issue.scope?.blocking ?? []);
  const abandonment: IssueStatusInput['abandonment'] =
    issue.state !== 'ABANDONED'
      ? null
      : issue.scope?.action === 'EXCLUDE'
        ? { status: 'EXCLUDED' }
        : issue.scope?.action === 'REPLACE'
          ? { status: 'REPLACED', replacementKeys: [] }
          : { status: 'UNDECIDED' };
  const input: IssueStatusInput = {
    state: issue.state,
    stage: issue.stage,
    isTask: Boolean(issue.parentId),
    parentState: parent?.state ?? null,
    designStatus,
    planReady: Boolean(issue.planId) || hasChildren,
    blockers,
    questionFrom: question ? (question.question?.senderName ?? question.pendingBy?.name ?? null) : null,
    progress,
    run: run ? { state: run.state, rework: Boolean(issue.initialReview || issue.qaReview || issue.finalReview) } : null,
    accepted: Boolean(issue.acceptedDigest || closure),
    abandonment,
    names: partyNamesForIssue(workspace.actors, issue, roleWords)
  };
  return statusSentence(input);
}

export function issueStatusForPacket(
  packet: IssueData,
  workspace: Pick<WorkspaceData, 'issues' | 'actors' | 'activeRuns'>,
  entries: readonly InboxEntry[],
  roleWords: PartyNames
): Sentence {
  const issue = packet.issue;
  const liveRun =
    packet.runs.find(
      (run) =>
        run.kind !== 'consult' &&
        ['QUEUED', 'STARTING', 'RUNNING', 'STOPPING', 'UNCERTAIN'].includes(run.state)
    ) ?? activeRunForIssue(workspace.activeRuns, issue.id);
  const mine = entries.filter((entry) => entry.issueId === issue.id);
  const question = mine.find((entry) => entry.kind === 'AGENT_QUESTION');
  const progress = !issue.parentId ? requirementProgress(issue.id, workspace.issues, entries) : null;
  const isRejection = ['LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED'].includes(issue.state);
  const rejectedClassification =
    issue.state === 'USER_REJECTED'
      ? (() => {
          const event = [...packet.history]
            .reverse()
            .find((item) => item.operation === 'delivery_rejection_classified');
          const value = (event?.data as Record<string, unknown> | undefined)?.classification;
          return value === 'DEFECT' || value === 'SCOPE_CHANGE' || value === 'CLARIFICATION' ? value : null;
        })()
      : null;
  const abandonment: IssueStatusInput['abandonment'] =
    issue.state !== 'ABANDONED'
      ? null
      : issue.scope?.action === 'EXCLUDE'
        ? { status: 'EXCLUDED' }
        : issue.scope?.action === 'REPLACE'
          ? { status: 'REPLACED', replacementKeys: [] }
          : { status: 'UNDECIDED' };
  const accepted = Boolean(issue.acceptedDigest && issue.acceptedDigest === packet.deliveryDigest);
  const blockers = issue.state === 'USER_ACCEPTANCE' ? packet.closureBlocked : packet.readiness.blocking;
  return statusSentence({
    state: issue.state,
    stage: issue.stage,
    isTask: Boolean(issue.parentId),
    parentState: packet.parent?.state ?? null,
    designStatus: packet.design?.status ?? null,
    planReady: packet.planning ? packet.planning.ready : Boolean(issue.planId),
    blockers,
    questionFrom: question ? (question.question?.senderName ?? question.pendingBy?.name ?? null) : null,
    progress,
    run: liveRun ? { state: liveRun.state, rework: Boolean(packet.lastRejection) } : null,
    accepted,
    rejection: isRejection
      ? {
          stage: packet.lastRejection?.stage ?? issue.stage,
          classification: rejectedClassification
        }
      : null,
    abandonment,
    names: partyNamesForIssue(workspace.actors, issue, roleWords)
  });
}

export function issueIconKind(
  issue: Pick<Issue, 'state' | 'stage'>,
  run?: Pick<Run, 'state'> | null
): { kind: StatusIconKind; progress?: number } {
  if (run?.state === 'UNCERTAIN') return { kind: 'crit' };
  switch (issue.state) {
    case 'NOT_STARTED':
      return { kind: 'todo' };
    case 'IN_PROGRESS':
      return { kind: 'dev', progress: 0.25 };
    case 'LEAD_REVIEW':
      return { kind: 'review', progress: issue.stage === 'FINAL' ? 0.75 : 0.42 };
    case 'QA_TEST':
      return { kind: 'review', progress: 0.58 };
    case 'USER_ACCEPTANCE':
      return { kind: 'you', progress: 0.9 };
    case 'DONE':
      return { kind: 'done' };
    case 'ON_HOLD':
      return { kind: 'hold' };
    case 'ABANDONED':
      return { kind: 'gone' };
    default:
      return { kind: 'rework' };
  }
}

export function matchesFilter(issue: DisplayIssue, filterText: string, parentTitle?: string | null): boolean {
  const query = filterText.trim().toLowerCase();
  if (!query) return true;
  const haystack = `${issue.key} ${issue.titleSuffix} ${parentTitle ?? ''}`.toLowerCase();
  return haystack.includes(query);
}

const REWORK_STATES = new Set(['LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED']);

export function boardColumns(
  issues: readonly DisplayIssue[],
  filterText: string
): { columns: BoardColumn[]; notOnBoard: DisplayIssue[] } {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const parentsWithKids = new Set(issues.filter((issue) => issue.parentId).map((issue) => issue.parentId!));
  const boardItems = issues.filter((issue) => {
    const isTaskOrActiveStandalone =
      Boolean(issue.parentId) || (!parentsWithKids.has(issue.id) && issue.state !== 'NOT_STARTED');
    if (!isTaskOrActiveStandalone) return false;
    const parent = issue.parentId ? byId.get(issue.parentId) : null;
    return matchesFilter(issue, filterText, parent?.titleSuffix);
  });
  const columns: BoardColumn[] = [
    {
      id: 'todo',
      labelKey: 'To do',
      icon: 'todo',
      items: boardItems.filter((issue) => issue.state === 'NOT_STARTED')
    },
    {
      id: 'dev',
      labelKey: 'Development',
      icon: 'dev',
      progress: 0.25,
      items: boardItems.filter((issue) => issue.state === 'IN_PROGRESS' || REWORK_STATES.has(issue.state))
    },
    {
      id: 'review',
      labelKey: 'Review',
      icon: 'review',
      progress: 0.42,
      items: boardItems.filter((issue) => issue.state === 'LEAD_REVIEW')
    },
    {
      id: 'qa',
      labelKey: 'Independent QA',
      icon: 'review',
      progress: 0.58,
      items: boardItems.filter((issue) => issue.state === 'QA_TEST')
    },
    {
      id: 'acceptance',
      labelKey: 'Your acceptance',
      icon: 'you',
      progress: 0.9,
      items: boardItems.filter((issue) => issue.state === 'USER_ACCEPTANCE')
    },
    {
      id: 'done',
      labelKey: 'Done',
      icon: 'done',
      items: boardItems.filter((issue) => issue.state === 'DONE')
    }
  ];
  const notOnBoard = boardItems.filter((issue) => issue.state === 'ON_HOLD' || issue.state === 'ABANDONED');
  return { columns, notOnBoard };
}

export function issueSteps(
  issue: Pick<Issue, 'parentId' | 'state' | 'stage'>,
  designStatus: Design['status'] | null,
  hasTasks: boolean
): IssueStep[] {
  if (issue.state === 'ON_HOLD' || issue.state === 'ABANDONED') return [];
  if (issue.parentId) {
    const labels: [string, string][] = [
      ['dev', 'Develop'],
      ['initial', 'Initial review'],
      ['qa', 'Independent QA'],
      ['final', 'Final review'],
      ['accept', 'Your acceptance']
    ];
    const index =
      issue.state === 'DONE'
        ? 5
        : issue.state === 'USER_ACCEPTANCE'
          ? 4
          : issue.state === 'LEAD_REVIEW'
            ? issue.stage === 'FINAL'
              ? 3
              : 1
            : issue.state === 'QA_TEST'
              ? 2
              : 0;
    return labels.map(([id, labelKey], position) => ({
      id,
      labelKey,
      status: position < index ? 'done' : position === index ? 'cur' : 'todo'
    }));
  }
  const labels: [string, string][] = [
    ['design', 'Design'],
    ['plan', 'Plan'],
    ['tasks', 'Tasks'],
    ['accept', 'Whole acceptance']
  ];
  const index =
    issue.state === 'DONE'
      ? 4
      : issue.state === 'USER_ACCEPTANCE'
        ? 3
        : designStatus !== 'APPROVED'
          ? 0
          : !hasTasks
            ? 1
            : 2;
  return labels.map(([id, labelKey], position) => ({
    id,
    labelKey,
    status: position < index ? 'done' : position === index ? 'cur' : 'todo'
  }));
}

export interface EnrichedHistoryItem {
  sequence: number;
  actorName: string;
  at: string;
  sentence: Sentence;
  reason: string | null;
}

export function enrichHistoryEvents(
  events: readonly IssueData['history'][number][],
  actors: readonly Actor[],
  runs: readonly Pick<Run, 'id' | 'actorId'>[],
  issue: Pick<Issue, 'assignee'>,
  formatHarness: (value?: string | null) => string
): EnrichedHistoryItem[] {
  const deliveryReasons = new Map<string, string>();
  for (const event of events) {
    if (event.operation === 'delivery_decide' && event.data && typeof event.data === 'object') {
      const record = event.data as Record<string, unknown>;
      if (typeof record.approvalId === 'string' && typeof record.reason === 'string' && record.reason.trim()) {
        deliveryReasons.set(record.approvalId, record.reason.trim());
      }
    }
  }
  const out: EnrichedHistoryItem[] = [];
  for (const event of events) {
    const raw = (event.data && typeof event.data === 'object' ? event.data : {}) as HistoryEventData;
    const data: HistoryEventData = { ...raw };
    if (event.operation === 'issue_assign') {
      const targetId = typeof raw.changes?.assignee?.after === 'string' ? raw.changes.assignee.after : null;
      const found = actorName(actors, targetId);
      if (found) data.name = found;
    } else if (event.operation === 'qa_configure') {
      const targetId = typeof raw.changes?.qaAssignee?.after === 'string' ? raw.changes.qaAssignee.after : null;
      const found = actorName(actors, targetId);
      if (found) data.name = found;
    } else if (event.operation === 'work_dispatch') {
      const runId = typeof raw.runId === 'string' ? raw.runId : null;
      const run = runId ? runs.find((item) => item.id === runId) : null;
      const found = actorName(actors, run?.actorId ?? issue.assignee);
      if (found) data.name = found;
    } else if (event.operation === 'grant_create') {
      const granteeId = typeof raw.granteeId === 'string' ? raw.granteeId : null;
      const found = actorName(actors, granteeId);
      if (found) data.name = found;
    } else if (event.operation === 'consult_queued' && typeof raw.harness === 'string') {
      data.harness = formatHarness(raw.harness);
    }
    const sentence = historySentence(event.operation, data);
    if (!sentence) continue;
    let reason: string | null =
      typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : null;
    if (!reason && event.operation === 'delivery_rejection_classified' && typeof raw.approvalId === 'string') {
      reason = deliveryReasons.get(raw.approvalId) ?? null;
    }
    out.push({
      sequence: event.sequence,
      actorName: event.actorName,
      at: event.at,
      sentence,
      reason
    });
  }
  return out.reverse();
}

export function moreActionsForIssue(packet: IssueData): MoreAction[] {
  const issue = packet.issue;
  const root = packet.parent ?? issue;
  const terminal = issue.state === 'DONE' || issue.state === 'ABANDONED';
  const rootTerminal = root.state === 'DONE' || root.state === 'ABANDONED';
  const canAssign =
    issue.state === 'NOT_STARTED' ||
    issue.state.endsWith('REJECTED') ||
    (!issue.parentId &&
      issue.state === 'IN_PROGRESS' &&
      !issue.candidate &&
      !issue.lease &&
      Boolean(packet.planning?.ready) &&
      packet.planning!.children.inScope > 0 &&
      packet.planning!.children.done === packet.planning!.children.inScope);
  const actions: MoreAction[] = [];

  if (!terminal) {
    actions.push({ id: 'scope', labelKey: 'Edit', group: 'forms' });
    actions.push({ id: 'plan', labelKey: 'Edit schedule', group: 'forms' });
  }
  if (!issue.parentId && !rootTerminal) {
    actions.push({ id: 'design', labelKey: packet.design ? 'Edit design' : 'Write design', group: 'forms' });
    if (packet.design?.status === 'DRAFT') {
      actions.push({ id: 'design_submit', labelKey: 'Request design review', group: 'forms' });
    }
    if (packet.planning || packet.design?.status === 'APPROVED') {
      actions.push({ id: 'decomposition', labelKey: 'Plan tasks', group: 'forms' });
    }
    actions.push({ id: 'create_task', labelKey: 'New task', group: 'forms' });
  }
  if (canAssign) {
    actions.push({ id: 'assignment', labelKey: 'Assign developer', group: 'forms' });
  }
  if (
    !['DONE', 'ABANDONED', 'USER_ACCEPTANCE'].includes(issue.state) &&
    !(issue.state === 'LEAD_REVIEW' && issue.stage === 'FINAL')
  ) {
    actions.push({ id: 'qa', labelKey: 'Configure QA', group: 'forms' });
  }
  if (canAssign && packet.readiness.ready) {
    actions.push({ id: 'dispatch', labelKey: 'Dispatch', group: 'forms' });
  }
  if (
    issue.candidate?.snapshotId &&
    issue.artifactMode === 'git' &&
    ['LEAD_REVIEW', 'QA_TEST', 'USER_ACCEPTANCE'].includes(issue.state)
  ) {
    actions.push({ id: 'git', labelKey: 'Attach commit', group: 'forms' });
  }
  if (!terminal) {
    actions.push({ id: 'grants', labelKey: 'Grant an agent', group: 'forms' });
  }
  if (
    issue.parentId &&
    issue.scopeDecisionId &&
    issue.scope?.action &&
    issue.scope.action !== 'RESTORE'
  ) {
    actions.push({ id: 'restore', labelKey: 'Restore to the scope', group: 'lifecycle' });
  }
  if (terminal) {
    if (!issue.scopeDecisionId || issue.scope?.action === 'RESTORE') {
      actions.push({ id: 'reopen', labelKey: 'Reopen', group: 'lifecycle' });
    }
  } else if (issue.state === 'ON_HOLD') {
    actions.push({ id: 'resume', labelKey: 'Resume', group: 'lifecycle' });
    actions.push({ id: 'abandon', labelKey: 'Abandon', group: 'lifecycle' });
  } else {
    actions.push({ id: 'hold', labelKey: 'Hold', group: 'lifecycle' });
    actions.push({ id: 'abandon', labelKey: 'Abandon', group: 'lifecycle' });
  }
  return actions;
}

export function inferAgentHarness(
  actor: Pick<Actor, 'id' | 'role'>,
  connections: readonly WorkspaceData['connections'][number][],
  issues: readonly Pick<Issue, 'assignee' | 'harness' | 'qaAssignee' | 'qaHarness'>[]
): Harness | null {
  const actorConnections = connections
    .filter((connection) => connection.actorId === actor.id)
    .sort((a, b) => Date.parse(b.initializedAt) - Date.parse(a.initializedAt));
  for (const connection of actorConnections) {
    const name = connection.client.name.trim().toLowerCase();
    if (['codex', 'codex-cli', 'codex-mcp-client', 'openai codex'].includes(name)) return 'codex';
    if (['claude code', 'claude-code', 'claude-code-client'].includes(name)) return 'claude-code';
    if (['dsh', 'dsh-mcp-client', 'deepseek harness', 'deepseek-harness'].includes(name)) return 'dsh';
  }
  for (const issue of issues) {
    if (actor.role === 'worker' && issue.assignee === actor.id && issue.harness) return issue.harness;
    if (actor.role === 'qa' && issue.qaAssignee === actor.id && issue.qaHarness) return issue.qaHarness;
  }
  return null;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function decisionActionVerb(kind: InboxKind): string {
  switch (kind) {
    case 'DESIGN_REVIEW':
      return 'Review the design';
    case 'DELIVERY_ACCEPTANCE':
      return 'Review the delivery';
    case 'SCOPE_DECISION':
      return 'Decide the scope';
    case 'RUN_RECONCILE':
      return 'Check the run';
    case 'CLOSURE_BLOCKED':
      return 'Complete it';
    case 'DEFECT_TRIAGE':
      return 'See the report';
    case 'AGENT_QUESTION':
      return 'Answer';
  }
}

export function actorInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && /^[A-Za-z0-9]/.test(words[0]!) && /^[A-Za-z0-9]/.test(words[1]!)) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}
