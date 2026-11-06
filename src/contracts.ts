import { z } from 'zod';

export const roles = ['human', 'lead', 'pm', 'worker', 'qa'] as const;
export type Role = typeof roles[number];
export const harnesses = ['codex', 'claude-code', 'dsh'] as const;
export type Harness = typeof harnesses[number];
export const states = ['NOT_STARTED', 'IN_PROGRESS', 'LEAD_REVIEW', 'LEAD_REJECTED', 'QA_TEST', 'QA_REJECTED', 'USER_ACCEPTANCE', 'USER_REJECTED', 'ON_HOLD', 'ABANDONED', 'DONE'] as const;
export type State = typeof states[number];
export interface Actor { id: string; role: Role; name: string; workspaceIds: string[]; sessionId: string; principalId?: string; runId?: string }
export interface Workspace { id: string; name: string; root: string; prefix: string; sequence: number; commonDir: string | null }
export interface Design { id: string; issueId: string; content: string; criteria: string[]; status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED'; hash: string }
export interface Candidate { id: string; workerId: string; sessionId: string; designId: string; files: { path: string; hash: string }[]; hash: string; summary: string; executionRoot?: string; runId?: string; baseSha?: string; snapshotId?: string }
export interface Snapshot { id: string; workspaceId: string; issueId: string; candidateId: string; root: string; files: { path: string; hash: string; bytes: number; mode: string }[]; hash: string; createdAt: string }
export interface CheckProfile { id: string; workspaceId: string; name: string; command: string; args: string[]; criteria: string[]; timeoutMs: number; hash: string }
export interface CheckRun { id: string; workspaceId: string; issueId: string; runId: string; actorId: string; sessionId: string; candidateId: string; snapshotId: string; profileId: string; profileHash: string; state: 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'UNCERTAIN'; criteria: string[]; testFiles: { path: string; hash: string }[]; createdAt: string; startedAt?: string; finishedAt?: string; command?: string; args?: string[]; pid?: number; exitCode?: number | null; stdout?: string; stderr?: string; errorCode?: string }
export interface QaReport { id: string; workspaceId: string; issueId: string; runId: string; actorId: string; sessionId: string; candidateId: string; snapshotId: string; verdict: 'PASS' | 'FAIL' | 'BLOCKED'; results: { criterionId: string; result: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN'; evidenceIds: string[]; reason: string }[]; findings: { criterionId: string; severity: 'BLOCKER' | 'MAJOR' | 'MINOR' | 'INFO'; expected: string; actual: string; reproduce: string }[]; summary: string }
export const liveRunStates = ['QUEUED', 'STARTING', 'RUNNING', 'STOPPING', 'UNCERTAIN'] as const;
export interface Run {
  id: string; issueId: string; workspaceId: string; actorId: string; harness: Harness;
  state: typeof liveRunStates[number] | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  version: number; createdAt: string; designId: string; scopeRevision: number;
  coordinatorId?: string; executionActorId?: string; executionRoot?: string; baseSha?: string;
  providerSessionId?: string; pid?: number; startedAt?: string; finishedAt?: string;
  budgetMs?: number; coordinatorConcurrency?: number;
  kind?: 'implementation' | 'qa'; candidateId?: string; snapshotId?: string; reportId?: string; checkProfileIds?: string[];
  lastHeartbeatAt?: string; summary?: string; errorCode?: string; stopReason?: string;
}
export interface Issue {
  id: string; workspaceId: string; key: string; parentId: string | null; title: string; description: string;
  state: State; stage: 'PRE_QA' | 'FINAL' | null; version: number; scopeRevision: number;
  criteria: string[]; assignee: string | null; harness: Harness | null; dependencies: string[];
  priority: number; plannedStart: string | null; dueDate: string | null; designId: string | null;
  fence: number; lease: { actorId: string; expiresAt: number; fence: number } | null;
  candidate: Candidate | null; initialReview: string | null; qaReview: string | null;
  finalReview: string | null; savedState: { state: State; stage: Issue['stage'] } | null;
  qaAssignee?: string; qaHarness?: Harness; checkProfileIds?: string[];
  artifactMode?: 'git' | 'artifact'; artifactReason?: string; acceptedDigest?: string;
}
export class DomainError extends Error {
  constructor(public code: string, message: string, public statusCode = 409, public details?: unknown) { super(message); }
}
const id = z.string().min(1).max(150);
const text = z.string().min(1).max(65536);
const mutation = { idempotencyKey: z.string().min(1).max(200) };
const scoped = { workspaceId: id };
const target = { ...scoped, issueId: id };
const change = { ...target, ...mutation, expectedVersion: z.number().int().positive() };
export const schemas = {
  workspace_register: z.object({ ...mutation, root: text, name: z.string().min(1).max(120), prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/) }).strict(),
  workspace_list: z.object({}).strict(),
  connection_list: z.object(scoped).strict(),
  actor_enroll: z.object({ ...scoped, ...mutation, role: z.enum(['lead', 'pm', 'worker', 'qa']), name: z.string().min(1).max(120) }).strict(),
  issue_create: z.object({ ...scoped, ...mutation, parentId: id.optional(), expectedParentVersion: z.number().int().positive().optional(), title: z.string().min(1).max(300), description: z.string().max(65536).default(''), criteria: z.array(id).max(100).default([]), artifactMode: z.enum(['git', 'artifact']).optional(), artifactReason: text.optional() }).strict(),
  issue_get: z.object(target).strict(),
  issue_list: z.object({ ...scoped, state: z.enum(states).optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) }).strict(),
  issue_update: z.object({ ...change, title: z.string().min(1).max(300).optional(), description: z.string().max(65536).optional(), priority: z.number().int().min(0).max(4).optional(), plannedStart: z.iso.date().nullable().optional(), dueDate: z.iso.date().nullable().optional() }).strict(),
  design_set: z.object({ ...change, content: text, criteria: z.array(id).min(1).max(100) }).strict(),
  design_submit: z.object(change).strict(),
  design_decide: z.object({ ...change, designId: id, decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']), reason: text }).strict(),
  issue_assign: z.object({ ...change, actorId: id, harness: z.enum(harnesses) }).strict(),
  dependency_add: z.object({ ...change, dependsOn: id }).strict(),
  work_claim: z.object({ ...change, designId: id, scopeRevision: z.number().int().positive() }).strict(),
  work_heartbeat: z.object({ ...change, fence: z.number().int().positive() }).strict(),
  work_submit: z.object({ ...change, fence: z.number().int().positive(), summary: text, files: z.array(z.string().min(1).max(500)).min(1).max(32) }).strict(),
  review_submit: z.object({ ...change, candidateId: id, verdict: z.enum(['PASS', 'FAIL']), reason: text }).strict(),
  issue_transition: z.object({ ...change, action: z.enum(['hold', 'resume', 'abandon', 'reopen']), reason: text }).strict(),
  work_dispatch: z.object({ ...change, designId: id, scopeRevision: z.number().int().positive() }).strict(),
  run_list: z.object({ ...scoped, limit: z.number().int().min(1).max(100).default(20) }).strict(),
  run_get: z.object({ ...scoped, runId: id }).strict(),
  run_interrupt: z.object({ ...scoped, ...mutation, runId: id, expectedVersion: z.number().int().positive(), reason: text }).strict(),
  run_reconcile: z.object({ ...scoped, ...mutation, runId: id, expectedVersion: z.number().int().positive(), reason: text, confirmStopped: z.literal(true) }).strict(),
  check_profile_create: z.object({ ...scoped, ...mutation, name: id, command: text, args: z.array(z.string().max(2000)).max(50), criteria: z.array(id).min(1).max(100), timeoutMs: z.number().int().min(100).max(300000).default(30000) }).strict(),
  check_profile_list: z.object(scoped).strict(),
  qa_configure: z.object({ ...change, actorId: id, harness: z.enum(harnesses), checkProfileIds: z.array(id).min(1).max(20) }).strict(),
  qa_check_run: z.object({ ...change, profileId: id, testFiles: z.array(z.string().min(1).max(500)).min(1).max(20) }).strict(),
  qa_check_get: z.object({ ...scoped, checkId: id }).strict(),
  qa_report_submit: z.object({ ...change, candidateId: id, verdict: z.enum(['PASS','FAIL','BLOCKED']), summary: text, results: z.array(z.object({ criterionId: id, result: z.enum(['PASS','FAIL','BLOCKED','NOT_RUN']), evidenceIds: z.array(id).max(100), reason: text }).strict()).min(1).max(100), findings: z.array(z.object({ criterionId: id, severity: z.enum(['BLOCKER','MAJOR','MINOR','INFO']), expected: text, actual: text, reproduce: text }).strict()).max(100).default([]) }).strict(),
  evidence_get: z.object({ ...target, kind: z.enum(['snapshot','qa_report','review']), evidenceId: id }).strict(),
  delivery_decide: z.object({ ...change, candidateId: id, digest: id, decision: z.enum(['ACCEPT','REJECT']), reason: text }).strict(),
  gap_list: z.object(scoped).strict(),
  event_list: z.object({ ...scoped, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
} as const;
export type Operation = keyof typeof schemas;
export const agentOperations = Object.keys(schemas).filter(k => !['actor_enroll', 'design_decide', 'workspace_register', 'check_profile_create', 'delivery_decide'].includes(k)) as Operation[];
