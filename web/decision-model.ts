import type { InboxKind } from '../src/contracts';

export type ListGroup = 'needs-you' | 'accepted' | 'later';

export const LIST_GROUPS: readonly ListGroup[] = ['needs-you', 'accepted', 'later'];

export interface DecisionEntryView {
  kind: InboxKind;
  blocking: boolean;
  defect?: { confirmable?: boolean } | null;
}

export function listGroup(entry: DecisionEntryView): ListGroup {
  if (entry.kind === 'CLOSURE_BLOCKED') return 'accepted';
  if (entry.kind === 'DEFECT_TRIAGE') return entry.defect?.confirmable === true ? 'needs-you' : 'later';
  return 'needs-you';
}

export function groupEntries<T extends DecisionEntryView>(
  entries: readonly T[]
): { group: ListGroup; entries: T[] }[] {
  const grouped = LIST_GROUPS.map((group) => ({ group, entries: [] as T[] }));
  for (const entry of entries) grouped[LIST_GROUPS.indexOf(listGroup(entry))]!.entries.push(entry);
  return grouped;
}

export interface ContentTarget {
  designId?: string | null;
  designHash?: string | null;
  revisionHash?: string | null;
  candidateId?: string | null;
  digest?: string | null;
  runId?: string | null;
  runVersion?: number | null;
  fence?: number | null;
  messageId?: string | null;
  defectId?: string | null;
  defectVersion?: number | null;
}

export interface ScopeContent {
  designId: string;
  scopeHash: string;
  childScopeHash: string;
  replacements: readonly string[];
}

export interface DefectContent {
  id: string;
  version: number;
  observation?: string | null;
}

export interface ContentKeyInput {
  kind: InboxKind;
  target: ContentTarget;
  scope?: ScopeContent | null;
  defect?: DefectContent | null;
  blockers?: readonly string[] | null;
}

function key(kind: string, ...values: unknown[]): string {
  return JSON.stringify([kind, ...values]);
}

export function contentKey(input: ContentKeyInput): string {
  const target = input.target;
  switch (input.kind) {
    case 'DESIGN_REVIEW':
      return key('design', target.designId ?? null, target.designHash ?? target.revisionHash ?? null);
    case 'DELIVERY_ACCEPTANCE':
      return key('delivery', target.candidateId ?? null, target.digest ?? null);
    case 'SCOPE_DECISION': {
      const scope = input.scope;
      return key(
        'scope',
        scope?.designId ?? null,
        scope?.scopeHash ?? null,
        scope?.childScopeHash ?? null,
        [...(scope?.replacements ?? [])].sort()
      );
    }
    case 'RUN_RECONCILE':
      return target.runId
        ? key('run', target.runId, target.runVersion ?? null)
        : key('work', target.fence ?? null, target.candidateId ?? null);
    case 'CLOSURE_BLOCKED':
      return key('closure', target.digest ?? null, [...new Set(input.blockers ?? [])].sort());
    case 'DEFECT_TRIAGE': {
      const defect = input.defect;
      return key(
        'defect',
        defect?.id ?? target.defectId ?? null,
        defect?.version ?? target.defectVersion ?? null,
        defect?.observation ?? null
      );
    }
    case 'AGENT_QUESTION':
      return key('question', target.messageId ?? null);
    default:
      return key('unknown', input.kind);
  }
}

export interface CardState {
  contentKey: string;
  riskHash: string | null;
  issueVersion: number;
}

export interface CardShown extends CardState {
  entryId: string;
}

export function cardShown(
  input: ContentKeyInput & { entryId: string; issueVersion: number; riskHash?: string | null }
): CardShown {
  return {
    entryId: input.entryId,
    issueVersion: input.issueVersion,
    riskHash: input.riskHash ?? null,
    contentKey: contentKey(input)
  };
}

export type CardChange = 'unchanged' | 'version-only' | 'changed';

export function cardChange(shown: CardState, current: CardState): CardChange {
  if (shown.contentKey !== current.contentKey || shown.riskHash !== current.riskHash) return 'changed';
  return shown.issueVersion === current.issueVersion ? 'unchanged' : 'version-only';
}

export function canResubmit(shown: CardState, current: CardState): boolean {
  return (
    shown.contentKey === current.contentKey &&
    shown.riskHash === current.riskHash &&
    shown.issueVersion !== current.issueVersion
  );
}

export interface VersionConflictInput {
  shown: CardState;
  current: CardState;
  previousIdempotencyKey: string;
  nextIdempotencyKey: string;
  alreadyResubmitted: boolean;
}

export type ConflictOutcome =
  | { action: 'resubmit'; issueVersion: number; idempotencyKey: string }
  | { action: 'changed'; contentKey: string; riskHash: string | null }
  | { action: 'stop'; reason: 'already-resubmitted' | 'no-new-version' | 'new-key-required' };

export function afterVersionConflict(input: VersionConflictInput): ConflictOutcome {
  if (input.alreadyResubmitted) return { action: 'stop', reason: 'already-resubmitted' };
  if (input.shown.contentKey !== input.current.contentKey || input.shown.riskHash !== input.current.riskHash) {
    return { action: 'changed', contentKey: input.current.contentKey, riskHash: input.current.riskHash };
  }
  if (input.shown.issueVersion === input.current.issueVersion) return { action: 'stop', reason: 'no-new-version' };
  if (!input.nextIdempotencyKey || input.nextIdempotencyKey === input.previousIdempotencyKey) {
    return { action: 'stop', reason: 'new-key-required' };
  }
  return { action: 'resubmit', issueVersion: input.current.issueVersion, idempotencyKey: input.nextIdempotencyKey };
}

export const CHANGED_CONTENT_CODES = [
  'APPROVAL_STALE',
  'DECISION_RISKS_STALE',
  'DESIGN_SCOPE_STALE',
  'SCOPE_CONTEXT_STALE',
  'DEFECT_OBSERVATION_REQUIRED'
] as const;

export function isChangedContentCode(code: string): boolean {
  return (CHANGED_CONTENT_CODES as readonly string[]).includes(code);
}

export const DECISION_GUARD_MS = 600;

export interface DecisionGuard {
  arm(): void;
  blocked(): boolean;
  remainingMs(): number;
}

export function createDecisionGuard(clock: () => number): DecisionGuard {
  let armedAt = clock();
  return {
    arm() {
      armedAt = clock();
    },
    blocked() {
      return clock() - armedAt < DECISION_GUARD_MS;
    },
    remainingMs() {
      return Math.max(0, DECISION_GUARD_MS - (clock() - armedAt));
    }
  };
}
