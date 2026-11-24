import type { InboxKind, QaReport, State } from '../src/contracts';
import type { DecisionRiskView, DefectSeverity } from '../src/defect-contracts';

export const SEVERITY_ORDER: readonly DefectSeverity[] = ['BLOCKER', 'MAJOR', 'MINOR', 'INFO'];

export interface Intent {
  keyFor(input: object): string;
  adopt(input: object, key: string): void;
  clear(): void;
}

export function createIntent(newKey: () => string = () => crypto.randomUUID()): Intent {
  let current: { payload: string; key: string } | null = null;
  return {
    keyFor(input) {
      const payload = JSON.stringify(input);
      if (!current || current.payload !== payload) current = { payload, key: newKey() };
      return current.key;
    },
    adopt(input, key) {
      current = { payload: JSON.stringify(input), key };
    },
    clear() {
      current = null;
    }
  };
}

export type Preview = { kind: 'text'; text: string } | { kind: 'binary' };

export function decodeWindow(bytes: Uint8Array, complete: boolean): Preview {
  if (bytes.includes(0)) return { kind: 'binary' };
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const trimLimit = complete ? 0 : 3;
  for (let trim = 0; trim <= trimLimit && trim <= bytes.length; trim++) {
    try {
      return { kind: 'text', text: decoder.decode(bytes.subarray(0, bytes.length - trim)) };
    } catch {
      continue;
    }
  }
  return { kind: 'binary' };
}

export function base64Bytes(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export const PREVIEW_FIRST_BYTES = 16 * 1024;
export const PREVIEW_MAX_BYTES = 64 * 1024;

export function previewWindow(loaded: number, total: number): { offset: number; limit: number } | null {
  const ceiling = Math.min(total, PREVIEW_MAX_BYTES);
  if (loaded >= ceiling) return null;
  const limit = loaded === 0 ? Math.min(PREVIEW_FIRST_BYTES, ceiling) : ceiling - loaded;
  return { offset: loaded, limit };
}

export type Problem = {
  id: string;
  key: string | null;
  state: 'OPEN' | 'PROPOSED' | 'FINDING';
  severity: DefectSeverity;
  criterionIds: string[];
  expected: string;
  actual: string;
  reproduce: string;
};

export function problemsOf(risks: DecisionRiskView | undefined | null): Problem[] {
  if (!risks) return [];
  const recorded = new Set(
    risks.defects.filter((defect) => defect.source.kind === 'QA_REPORT' && risks.qaReport && defect.source.id === risks.qaReport.id)
      .map((defect) => `${defect.source.id}:${defect.source.index ?? ''}`)
  );
  const problems: Problem[] = risks.defects.map((defect) => ({
    id: defect.id,
    key: defect.key,
    state: defect.state === 'PROPOSED' ? 'PROPOSED' : 'OPEN',
    severity: defect.severity,
    criterionIds: defect.criterionIds,
    expected: defect.expected,
    actual: defect.actual,
    reproduce: defect.reproduce
  }));
  for (const finding of risks.qaReport?.findings ?? []) {
    if (recorded.has(finding.id)) continue;
    problems.push({
      id: finding.id,
      key: null,
      state: 'FINDING',
      severity: finding.severity,
      criterionIds: [finding.criterionId],
      expected: finding.expected,
      actual: finding.actual,
      reproduce: finding.reproduce
    });
  }
  return problems.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );
}

export interface ProblemCounts {
  open: Record<DefectSeverity, number>;
  unconfirmed: number;
  openMinor: number;
  blocking: number;
}

export function countProblems(problems: readonly Problem[]): ProblemCounts {
  const open: Record<DefectSeverity, number> = { BLOCKER: 0, MAJOR: 0, MINOR: 0, INFO: 0 };
  let unconfirmed = 0;
  for (const problem of problems) {
    if (problem.state === 'PROPOSED') unconfirmed += 1;
    else open[problem.severity] += 1;
  }
  return { open, unconfirmed, openMinor: open.MINOR, blocking: open.BLOCKER + open.MAJOR };
}

export interface DeliveryChoice {
  primary: 'accept' | 'needs-fixes';
  minorCount: number;
}

export function deliveryChoice(problems: readonly Problem[]): DeliveryChoice {
  const counts = countProblems(problems);
  return { primary: counts.blocking > 0 ? 'needs-fixes' : 'accept', minorCount: counts.openMinor };
}

export type DefectConfirm = 'acceptance' | 'closed' | 'none';

export function defectConfirm(confirmable: boolean, issueState: State): DefectConfirm {
  if (!confirmable) return 'none';
  if (issueState === 'USER_ACCEPTANCE') return 'acceptance';
  if (issueState === 'DONE') return 'closed';
  return 'none';
}

export function closedDefectPrimary(severity: DefectSeverity): 'fix-now' | 'fix-later' {
  return severity === 'BLOCKER' || severity === 'MAJOR' ? 'fix-now' : 'fix-later';
}

export interface TriageBase {
  workspaceId: string;
  defectId: string;
  expectedVersion: number;
  expectedIssueVersion: number;
}

export function confirmInput(
  base: TriageBase,
  severity: DefectSeverity,
  observation: object,
  disposition?: { kind: 'REOPEN'; reason: string } | { kind: 'DEFER' }
) {
  return {
    ...base,
    action: 'CONFIRM' as const,
    severity,
    observation,
    ...(disposition ? { disposition: disposition.kind } : {}),
    ...(disposition?.kind === 'REOPEN' ? { reason: disposition.reason } : {})
  };
}

export function rejectInput(base: TriageBase, reason: string) {
  return { ...base, action: 'REJECT' as const, reason };
}

export function convertInput(base: TriageBase, reason: string, title: string, description: string) {
  return { ...base, action: 'NEW_REQUIREMENT' as const, reason, requirement: { title, description } };
}

export interface RequirementDraftLabels {
  problem: string;
  expected: string;
  steps: string;
}

const defaultDraftLabels: RequirementDraftLabels = {
  problem: 'Problem {key}: {summary}',
  expected: 'Expected behavior',
  steps: 'Steps'
};

export function requirementDraft(
  defect: { key: string; expected: string; reproduce: string; actual: string },
  labels: RequirementDraftLabels = defaultDraftLabels
) {
  const summary = defect.actual.replace(/\s+/g, ' ').trim();
  return {
    title: labels.problem.replace('{key}', () => defect.key).replace('{summary}', () => summary).slice(0, 300),
    description: `${labels.expected}\n\n${defect.expected}\n\n${labels.steps}\n\n${defect.reproduce}`
  };
}

export interface OpenEntryRef {
  id: string;
  workspaceId: string;
  issueId: string;
  kind: InboxKind;
  target: {
    defectId?: string;
    messageId?: string;
    runId?: string;
  };
}

export function matchOpenEntry<T extends OpenEntryRef>(entries: readonly T[], open: T): T | null {
  const exact = entries.find((entry) => entry.id === open.id);
  if (exact) return exact;
  return entries.find((entry) => {
    if (entry.workspaceId !== open.workspaceId || entry.issueId !== open.issueId || entry.kind !== open.kind) return false;
    if (open.kind === 'DEFECT_TRIAGE') return !!open.target.defectId && entry.target.defectId === open.target.defectId;
    if (open.kind === 'AGENT_QUESTION') return !!open.target.messageId && entry.target.messageId === open.target.messageId;
    if (open.kind === 'RUN_RECONCILE') return (entry.target.runId ?? null) === (open.target.runId ?? null);
    return true;
  }) ?? null;
}

export interface InboxNextRef {
  issueId: string;
  kind: InboxKind;
  status: 'WAITING' | 'BLOCKED' | 'READY_TO_COMPLETE';
  blockers: readonly string[];
}

export type EntryNext =
  | { key: string; blocker?: undefined }
  | { key: 'Accepted; {blocker}'; blocker: string };

export function nextFromEntries(
  entries: readonly InboxNextRef[],
  issueId: string,
  isParent = false
): EntryNext | null {
  const mine = entries.filter((entry) => entry.issueId === issueId);
  const closure = mine.find((entry) => entry.kind === 'CLOSURE_BLOCKED');
  if (closure) {
    if (closure.status === 'READY_TO_COMPLETE' || !closure.blockers.length) {
      return { key: 'Accepted and ready to complete' };
    }
    return { key: 'Accepted; {blocker}', blocker: closure.blockers[0]! };
  }
  const delivery = mine.find((entry) => entry.kind === 'DELIVERY_ACCEPTANCE');
  if (delivery) {
    if (delivery.blockers.includes('MINOR_ACKNOWLEDGEMENT_REQUIRED')) {
      return { key: 'New minor problems need another look from you' };
    }
    return { key: isParent ? 'The whole delivery awaits your acceptance' : 'Awaiting your acceptance' };
  }
  if (mine.some((entry) => entry.kind === 'DESIGN_REVIEW')) {
    return { key: 'The design awaits your approval' };
  }
  if (mine.some((entry) => entry.kind === 'SCOPE_DECISION')) {
    return { key: 'The scope needs your decision' };
  }
  if (mine.some((entry) => entry.kind === 'RUN_RECONCILE')) {
    return { key: 'Lost contact with the run; needs you' };
  }
  return null;
}

export interface DeliverySnapshot {
  candidateId: string | null;
  snapshotId: string | null;
  criteria: readonly string[];
  decisionRisks?: DecisionRiskView | null;
  qa: Pick<QaReport, 'id' | 'verdict' | 'results'> | null;
  initial: { id: string; verdict: 'PASS' | 'FAIL' } | null;
  final: { id: string; verdict: 'PASS' | 'FAIL' } | null;
  git: { state: string; entries: readonly { repository: string; sha: string }[] } | null;
}

export type DeliveryChangeItem =
  | { kind: 'candidate' }
  | { kind: 'problem-added'; unconfirmed: boolean; severity: DefectSeverity; summary: string }
  | { kind: 'problem-removed'; severity: DefectSeverity; summary: string }
  | { kind: 'problem-confirmed'; severity: DefectSeverity; summary: string }
  | { kind: 'problem-severity'; before: DefectSeverity; after: DefectSeverity; summary: string }
  | { kind: 'problem-updated'; severity: DefectSeverity; summary: string }
  | { kind: 'commit-attached' }
  | { kind: 'commit-removed' }
  | { kind: 'commit-verified' }
  | { kind: 'commit-state' }
  | { kind: 'qa-criterion'; criterion: string; before: string | null; after: string | null }
  | { kind: 'qa-changed' }
  | { kind: 'initial-review' }
  | { kind: 'final-review' };

export function deliveryChanges(before: DeliverySnapshot, after: DeliverySnapshot): DeliveryChangeItem[] {
  const items: DeliveryChangeItem[] = [];
  if (before.candidateId !== after.candidateId || before.snapshotId !== after.snapshotId) {
    items.push({ kind: 'candidate' });
  }
  const prevProblems = new Map(problemsOf(before.decisionRisks).map((problem) => [problem.id, problem]));
  const nextProblems = new Map(problemsOf(after.decisionRisks).map((problem) => [problem.id, problem]));
  for (const [id, next] of nextProblems) {
    const prev = prevProblems.get(id);
    const summary = firstLine(next.actual, 80);
    if (!prev) {
      items.push({ kind: 'problem-added', unconfirmed: next.state === 'PROPOSED', severity: next.severity, summary });
      continue;
    }
    if (prev.state === 'PROPOSED' && next.state !== 'PROPOSED') {
      items.push({ kind: 'problem-confirmed', severity: next.severity, summary });
    }
    if (prev.severity !== next.severity) {
      items.push({ kind: 'problem-severity', before: prev.severity, after: next.severity, summary });
    } else if (
      prev.state === next.state &&
      (prev.actual !== next.actual || prev.expected !== next.expected || prev.reproduce !== next.reproduce)
    ) {
      items.push({ kind: 'problem-updated', severity: next.severity, summary });
    }
  }
  for (const [id, prev] of prevProblems) {
    if (!nextProblems.has(id)) {
      items.push({ kind: 'problem-removed', severity: prev.severity, summary: firstLine(prev.actual, 80) });
    }
  }
  const commitKey = (git: DeliverySnapshot['git']) =>
    (git?.entries ?? []).map((entry) => `${entry.repository}@${entry.sha}`).join(',');
  if (commitKey(before.git) !== commitKey(after.git)) {
    items.push({ kind: after.git?.entries.length ? 'commit-attached' : 'commit-removed' });
  } else if ((before.git?.state ?? null) !== (after.git?.state ?? null)) {
    items.push({ kind: after.git?.state === 'VERIFIED' ? 'commit-verified' : 'commit-state' });
  }
  const criterionNames = [...new Set([
    ...before.criteria,
    ...after.criteria,
    ...(before.qa?.results.map((result) => result.criterionId) ?? []),
    ...(after.qa?.results.map((result) => result.criterionId) ?? [])
  ])];
  let qaDiff = false;
  for (const criterion of criterionNames) {
    const prevResult = before.qa?.results.find((result) => result.criterionId === criterion)?.result ?? null;
    const nextResult = after.qa?.results.find((result) => result.criterionId === criterion)?.result ?? null;
    if (prevResult !== nextResult) {
      qaDiff = true;
      items.push({ kind: 'qa-criterion', criterion, before: prevResult, after: nextResult });
    }
  }
  if (!qaDiff && (before.qa?.id !== after.qa?.id || before.qa?.verdict !== after.qa?.verdict)) {
    items.push({ kind: 'qa-changed' });
  }
  if (before.initial?.id !== after.initial?.id || before.initial?.verdict !== after.initial?.verdict) {
    items.push({ kind: 'initial-review' });
  }
  if (before.final?.id !== after.final?.id || before.final?.verdict !== after.final?.verdict) {
    items.push({ kind: 'final-review' });
  }
  return items;
}

export function rowTitle(entry: {
  kind: InboxKind;
  title: string;
  question?: { body: string };
  defect?: { summary: string };
}): string {
  if (entry.kind === 'AGENT_QUESTION' && entry.question) return firstLine(entry.question.body);
  if (entry.kind === 'DEFECT_TRIAGE' && entry.defect) return firstLine(entry.defect.summary);
  return entry.title;
}

export function firstLine(text: string, limit = 120): string {
  const line = text.split(/\r?\n/).find((part) => part.trim())?.trim() ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function formatAge(ageMs: number | null): { key: string; count?: number } | null {
  if (ageMs === null) return null;
  if (ageMs < 60000) return { key: 'Less than a minute' };
  if (ageMs < 3600000) return { key: '{count} min', count: Math.floor(ageMs / 60000) };
  return { key: '{count} h', count: Math.floor(ageMs / 3600000) };
}

export function lastDecidedRevision<T extends { id: string; status: string }>(
  history: readonly T[],
  currentId: string
): T | null {
  return history.find((design) => design.id !== currentId && (design.status === 'APPROVED' || design.status === 'CHANGES_REQUESTED')) ?? null;
}
