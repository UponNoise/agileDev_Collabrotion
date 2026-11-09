import type {
  Actor,
  CheckProfile,
  CheckRun,
  Coverage,
  Design,
  GitSubmission,
  Issue,
  Plan,
  Run,
  ScopeState,
  Snapshot,
  Workspace
} from '../src/contracts';

export type DisplayIssue = Issue & { url: string; titleSuffix: string; scope?: { status: ScopeState['status']; decisionId: string | null; action: string | null; blocking: string[] } };
export type View = 'backlog' | 'board' | 'reviews' | 'runs' | 'settings';
export interface WorkspaceData {
  workspace: Workspace;
  cursor: number;
  total: number;
  nextOffset: number | null;
  issues: DisplayIssue[];
  statusCounts: Record<string, number>;
  actors: Actor[];
  profiles: CheckProfile[];
  designs: Pick<Design, 'id' | 'issueId' | 'status'>[];
  connections: { id: string; actorId: string; client: { name: string; version: string }; initializedAt: string }[];
}
export interface IssueData {
  issue: DisplayIssue;
  parent: Issue | null;
  design: Design | null;
  revision: number | null;
  designHistory: Design[];
  deliveryDigest: string | null;
  authorizationScopeHash: string;
  git: GitSubmission | null;
  closureBlocked: string[];
  readiness: { ready: boolean; blocking: string[] };
  executionRecovery: { required: boolean; fence: number; candidateId: string | null };
  planning: {
    planId: string | null;
    ready: boolean;
    status: string;
    blocking: string[];
    children: Coverage['children'];
  } | null;
  nextActions: string[];
  history: {
    sequence: number;
    actorId: string;
    actorName: string;
    operation: string;
    targetId: string;
    data: unknown;
    at: string;
  }[];
  nextAfter: number | null;
  evidence: { kind: string; id: string; state?: string; verdict?: string; createdAt?: string }[];
  checks: CheckRun[];
  runs: Run[];
  snapshot: Omit<Snapshot, 'root'> | null;
}
export interface PlanData {
  issue: DisplayIssue;
  plan: Plan | null;
  coverage: Coverage & { totalCriteria: number; nextOffset: number | null };
  children: DisplayIssue[];
  history: Pick<Plan, 'id' | 'mode' | 'createdAt' | 'hash'>[];
}
export interface ScopeData {
  issue: DisplayIssue;
  design: Design | null;
  scopeHash: string;
  children: { issue: DisplayIssue; scopeHash: string; scope: ScopeState }[];
  total: number;
  nextOffset: number | null;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
  }
}
let csrf: string | null = null;
export function setCsrf(value: string | null) {
  csrf = value;
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers:
      body === undefined ? {} : { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false)
    throw new ApiError(
      data.error?.code ?? 'REQUEST_FAILED',
      data.error?.message ?? 'The local request failed',
      response.status
    );
  return data;
}
export async function command<T>(operation: string, input: object): Promise<T> {
  return (await request<{ result: T }>(`/api/command/${operation}`, input)).result;
}
export const mutation = <T>(operation: string, input: object) =>
  command<T>(operation, {
    ...input,
    idempotencyKey: (input as Record<string, unknown>).idempotencyKey ?? crypto.randomUUID()
  });
export const formKey = (data: FormData) => ({ idempotencyKey: String(data.get('idempotencyKey')) });
export const lines = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
export const errorText = (error: unknown) =>
  error instanceof ApiError
    ? `${error.code}: ${error.message}`
    : 'The local service could not be reached. Your input has been kept.';
export const dateText = (value?: string | number | null) => (value ? new Date(value).toLocaleString() : 'Not recorded');
export const harnessName = (value?: string | null) =>
  value === 'codex' ? 'Codex' : value === 'dsh' ? 'DSH' : value === 'claude-code' ? 'Claude Code' : '—';
export function stateLabel(issue: Issue, designs: WorkspaceData['designs'] = []) {
  if (
    issue.state === 'NOT_STARTED' &&
    !issue.parentId &&
    designs.find((d) => d.id === issue.designId)?.status === 'IN_REVIEW'
  )
    return 'Design review';
  if (issue.state === 'LEAD_REVIEW') return issue.stage === 'FINAL' ? 'Final lead review' : 'Initial lead review';
  return (
    (
      {
        NOT_STARTED: 'Not started',
        IN_PROGRESS: 'In development',
        LEAD_REJECTED: 'Lead rejected',
        QA_TEST: 'QA testing',
        QA_REJECTED: 'QA rejected',
        USER_ACCEPTANCE: 'User acceptance',
        USER_REJECTED: 'User rejected',
        ON_HOLD: 'On hold',
        ABANDONED: 'Abandoned',
        DONE: 'Implemented'
      } as Record<string, string>
    )[issue.state] ?? issue.state
  );
}
