import { defectCoreSchemas, defectFindingSchema } from './defect-contracts.js';
import { iterationSchemas, iterationMembershipPreconditionSchema } from './iteration-contracts.js';
import { z } from 'zod';

export const roles = ['human', 'lead', 'pm', 'worker', 'qa'] as const;
export type Role = typeof roles[number];
export const harnesses = ['codex', 'claude-code', 'dsh'] as const;
export type Harness = typeof harnesses[number];
export const states = ['NOT_STARTED', 'IN_PROGRESS', 'LEAD_REVIEW', 'LEAD_REJECTED', 'QA_TEST', 'QA_REJECTED', 'USER_ACCEPTANCE', 'USER_REJECTED', 'ON_HOLD', 'ABANDONED', 'DONE'] as const;
export type State = typeof states[number];
export const inboxKinds = ['DESIGN_REVIEW', 'DELIVERY_ACCEPTANCE', 'SCOPE_DECISION', 'RUN_RECONCILE', 'CLOSURE_BLOCKED'] as const;
export type InboxKind = typeof inboxKinds[number];
export interface Actor { id: string; role: Role; name: string; workspaceIds: string[]; sessionId: string; principalId?: string; runId?: string }
export interface Workspace { id: string; name: string; root: string; prefix: string; sequence: number; commonDir: string | null; gitBindingId?: string }
export interface GitBinding { id: string; workspaceId: string; repository: string; subdirectory: string; remote: string; actorId: string; createdAt: string }
export interface GitRepositoryEntry { repository: string; subdirectory: string; sha: string; url: string }
export interface GitSubmission { id: string; workspaceId: string; issueId: string; candidateId: string; snapshotId: string; bindingId: string; entries: GitRepositoryEntry[]; actorId: string; createdAt: string; state: 'QUEUED' | 'VERIFYING' | 'VERIFIED' | 'UNAVAILABLE' | 'FAILED' | 'STALE'; attempt: number; currentAttemptId?: string; errorCode?: string; verifiedAt?: string; rootTreeSha?: string; treeSha?: string; expectedTreeSha?: string }
export interface GitAttempt { id: string; submissionId: string; workspaceId: string; issueId: string; attempt: number; entryIndex: number; treeComparison: boolean; evidenceRole: 'snapshot' | 'reference'; startedAt: string; finishedAt?: string; state: 'VERIFYING' | 'VERIFIED' | 'UNAVAILABLE' | 'FAILED' | 'STALE'; apiVersion: string; repository: string; sha: string; errorCode?: string; rootTreeSha?: string; treeSha?: string; expectedTreeSha?: string }
export interface Design { id: string; issueId: string; content: string; criteria: string[]; status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED'; hash: string; requirementDescription?: string }
export const grantActions = ['hold', 'resume', 'abandon', 'reopen', 'complete'] as const;
export interface Grant { id: string; workspaceId: string; issueId: string; grantorId: string; granteeId: string; action: typeof grantActions[number]; scopeRevision: number; designId: string | null; scopeHash: string; candidateId?: string; digest?: string; expiresAt: string; maxUses: number; uses: number; version: number; reason: string; createdAt: string; revokedAt?: string; revokedBy?: string; revocationReason?: string }
export interface Plan { id: string; workspaceId: string; issueId: string; designId: string | null; mode: 'DRAFT' | 'READY'; actorId: string; reason: string; createdAt: string; scopeHash: string; hash: string; integrationCriteria: string[]; overlapReasons: Record<string,string>; tasks: { issueId: string; scopeRevision: number; title: string; description: string; criteria: string[]; dependencies: string[] }[] }
export interface ScopeBinding { issueId: string; parentId: string; version: number; scopeRevision: number; title: string; description: string; criteria: string[]; hash: string }
export interface ScopeDecision { id: string; workspaceId: string; issueId: string; childId: string; designId: string; designHash: string; action: 'EXCLUDE' | 'REPLACE' | 'RESTORE'; actorId: string; reason: string; createdAt: string; previousDecisionId: string | null; target: ScopeBinding; replacements: ScopeBinding[]; hash: string }
export interface ScopeState { status: 'INCLUDED' | 'EXCLUDED' | 'STALE'; decision: ScopeDecision | null; blocking: string[] }
export interface Coverage { ready: boolean; status: string; blocking: string[]; criteria: { criterionId: string; tasks: { issueId: string; key: string; state: State }[]; integration: boolean; overlap: boolean; overlapReason: string | null; delivered: boolean }[]; unknown: string[]; children: { total: number; inScope: number; done: number; excluded: number; abandoned: number; staleExclusions: number }; unassigned: string[]; unscheduled: string[] }
export interface IntegrationManifest { planId: string; planScopeHash: string; hash: string; children: { issueId: string; candidateId: string; snapshotId: string; snapshotHash: string; digest: string; commitUrl?: string }[]; excluded?: { issueId: string; decisionId: string; decisionHash: string; replacementIds: string[] }[] }
export interface Candidate { id: string; workerId: string; sessionId: string; designId: string; files: { path: string; hash: string }[]; hash: string; summary: string; executionRoot?: string; runId?: string; baseSha?: string; snapshotId?: string; digestPolicy?: 2 | 3 | 4; integration?: IntegrationManifest }
export interface Snapshot { id: string; workspaceId: string; issueId: string; candidateId: string; root: string; files: { path: string; hash: string; bytes: number; mode: string; blob?: string }[]; hash: string; createdAt: string }
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
  priority: number; plannedStart: string | null; dueDate: string | null; designId: string | null; designBindingId?: string;
  fence: number; lease: { actorId: string; expiresAt: number; fence: number } | null;
  candidate: Candidate | null; initialReview: string | null; qaReview: string | null;
  finalReview: string | null; savedState: { state: State; stage: Issue['stage'] } | null;
  qaAssignee?: string; qaHarness?: Harness; checkProfileIds?: string[];
  artifactMode?: 'git' | 'artifact'; artifactReason?: string; acceptedDigest?: string; gitSubmissionId?: string;
  aggregate?: boolean; planId?: string; scopeDecisionId?: string; unmanagedExecution?: boolean; estimate?: { value: number; unit: 'hours' | 'points'; confidence: 'low' | 'medium' | 'high' } | null; iteration?: string | null; iterationId?: string | null; legacyIterationLabel?: string | null;
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
const estimate = z.object({ value: z.number().positive().max(100000), unit: z.enum(['hours','points']), confidence: z.enum(['low','medium','high']) }).strict().nullable();
const schedule = { priority: z.number().int().min(0).max(4).optional(),plannedStart: z.iso.date().nullable().optional(),dueDate: z.iso.date().nullable().optional(),estimate: estimate.optional(),iterationId: id.nullable().optional() };
const retiredIterationError = { error: (issue: z.core.$ZodRawIssue) => issue.code === 'unrecognized_keys' && (issue.keys as string[]).some(key => ['iteration','legacyIterationLabel'].includes(key)) ? 'Use iterationId; legacyIterationLabel is read-only' : undefined };
const planTask = z.object({ ref: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,49}$/),issueId: id.optional(),expectedVersion: z.number().int().positive().optional(),title: z.string().min(1).max(300),description: z.string().max(65536).optional(),criteria: z.array(id).max(100).optional(),dependencies: z.array(z.union([z.object({ ref: id }).strict(),z.object({ issueId: id }).strict()])).max(100).optional(),assigneeId: id.nullable().optional(),harness: z.enum(harnesses).nullable().optional(),...schedule },retiredIterationError).strict();
const delivery = { ...change, candidateId: id, digest: id, reason: text };
const deliveryDecisionSchema = z.union([
  z.object({ ...delivery, decision: z.literal('ACCEPT') }).strict(),
  z.object({ ...delivery, decision: z.literal('REJECT'), classification: z.literal('DEFECT'), findings: z.array(defectFindingSchema).min(1).max(20) }).strict(),
  z.object({ ...delivery, decision: z.literal('REJECT'), classification: z.enum(['SCOPE_CHANGE','CLARIFICATION']) }).strict()
]);
export const schemas = {
  ...iterationSchemas,
  defect_propose: defectCoreSchemas.propose.extend(mutation),
  defect_report: defectCoreSchemas.report.extend(mutation),
  defect_triage: defectCoreSchemas.triage.extend(mutation),
  defect_withdraw: defectCoreSchemas.withdraw.extend(mutation),
  defect_list: defectCoreSchemas.list,
  defect_get: defectCoreSchemas.get,
  workspace_register: z.object({ ...mutation, root: text, name: z.string().min(1).max(120), prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/) }).strict(),
  workspace_list: z.object({}).strict(),
  inbox_list: z.object({ workspaceId: id.optional(),kind: z.enum(inboxKinds).optional(),offset: z.number().int().nonnegative().default(0),limit: z.number().int().min(1).max(100).default(20) }).strict(),
  inbox_settings_get: z.object(scoped).strict(),
  inbox_settings_update: z.object({ ...scoped,...mutation,expectedVersion: z.number().int().nonnegative(),agingThresholdHours: z.number().int().min(1).max(168) }).strict(),
  ui_workspace: z.object({ ...scoped,search: z.string().max(300).default(''),state: z.enum(states).optional(),view: z.enum(['backlog','reviews']).default('backlog'),offset: z.number().int().nonnegative().default(0),limit: z.number().int().min(1).max(100).default(20),afterCursor: z.number().int().nonnegative().optional() }).strict(),
  ui_issue: z.object({ ...target,after: z.number().int().nonnegative().default(0),limit: z.number().int().min(1).max(100).default(30) }).strict(),
  ui_runs: z.object({ ...scoped,offset: z.number().int().nonnegative().default(0),limit: z.number().int().min(1).max(100).default(20) }).strict(),
  workspace_git_bind: z.object({ ...scoped, ...mutation, remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/).default('origin'), expectedBindingId: id.nullable().default(null) }).strict(),
  connection_list: z.object(scoped).strict(),
  actor_enroll: z.object({ ...scoped, ...mutation, role: z.enum(['lead', 'pm', 'worker', 'qa']), name: z.string().min(1).max(120) }).strict(),
  issue_create: z.object({ ...scoped, ...mutation, parentId: id.optional(), expectedParentVersion: z.number().int().positive().optional(), title: z.string().min(1).max(300), description: z.string().max(65536).default(''), criteria: z.array(id).max(100).default([]), artifactMode: z.enum(['git', 'artifact']).optional(), artifactReason: text.optional() }).strict(),
  issue_get: z.object(target).strict(),
  issue_list: z.object({ ...scoped, state: z.enum(states).optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) }).strict(),
  issue_update: z.object({ ...change, title: z.string().min(1).max(300).optional(), description: z.string().max(65536).optional(), criteria: z.array(id).max(100).optional(),...schedule,memberships: z.array(iterationMembershipPreconditionSchema).max(100).default([]) },retiredIterationError).strict(),
  plan_apply: z.object({ ...change,memberships: z.array(iterationMembershipPreconditionSchema).max(100).default([]),expectedPlanId: id.nullable().default(null),designId: id.nullable(),mode: z.enum(['DRAFT','READY']),tasks: z.array(planTask).max(100),integrationCriteria: z.array(id).max(100).default([]),overlapReasons: z.record(id,text).refine(value => Object.keys(value).length <= 100).default({}),reason: text }).strict(),
  plan_get: z.object({ ...target,planId: id.optional(),view: z.enum(['summary','full']).default('summary'),offset: z.number().int().nonnegative().default(0),limit: z.number().int().min(1).max(100).default(20) }).strict(),
  scope_get: z.object({ ...target,offset: z.number().int().nonnegative().default(0),limit: z.number().int().min(1).max(100).default(20) }).strict(),
  scope_decide: z.object({ ...change,expectedParentVersion: z.number().int().positive(),designId: id,expectedDecisionId: id.nullable().default(null),scopeHash: id,childScopeHash: id,action: z.enum(['EXCLUDE','REPLACE','RESTORE']),replacements: z.array(z.object({ issueId: id,expectedVersion: z.number().int().positive(),scopeHash: id }).strict()).max(100).default([]),reason: text,reopenParent: z.boolean().default(false),reopenChild: z.boolean().default(false) }).strict(),
  integration_get: z.object({ ...target,offset: z.number().int().nonnegative().default(0),limit: z.number().int().min(1).max(100).default(20) }).strict(),
  artifact_read: z.object({ ...target,snapshotId: id,path: z.string().min(1).max(500),offset: z.number().int().nonnegative().default(0),limit: z.number().int().min(1).max(65536).default(16384),encoding: z.enum(['utf8','base64']).default('utf8') }).strict(),
  design_set: z.object({ ...change, content: text, criteria: z.array(id).min(1).max(100) }).strict(),
  design_submit: z.object(change).strict(),
  design_decide: z.object({ ...change, designId: id, decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']), reason: text }).strict(),
  issue_assign: z.object({ ...change, actorId: id.nullable(), harness: z.enum(harnesses).nullable() }).strict(),
  grant_create: z.object({ ...change, granteeId: id, action: z.enum(grantActions), scopeHash: id, expiresAt: z.iso.datetime(), maxUses: z.number().int().min(1).max(10).default(1), reason: text, candidateId: id.optional(), digest: id.optional() }).strict(),
  grant_revoke: z.object({ ...change, grantId: id, expectedGrantVersion: z.number().int().positive(), reason: text }).strict(),
  grant_list: z.object({ ...target, limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().nonnegative().default(0) }).strict(),
  dependency_add: z.object({ ...change, dependsOn: id }).strict(),
  dependency_set: z.object({ ...change, dependsOn: z.array(id).max(100) }).strict(),
  work_claim: z.object({ ...change, designId: id, scopeRevision: z.number().int().positive() }).strict(),
  work_heartbeat: z.object({ ...change, fence: z.number().int().positive() }).strict(),
  work_submit: z.object({ ...change, fence: z.number().int().positive(), summary: text, files: z.array(z.string().min(1).max(500)).min(1).max(32) }).strict(),
  work_reconcile: z.object({ ...change,fence: z.number().int().nonnegative(),candidateId: id.nullable().default(null),confirmStopped: z.literal(true),reason: text }).strict(),
  review_submit: z.object({ ...change, candidateId: id, verdict: z.enum(['PASS', 'FAIL']), reason: text }).strict(),
  issue_transition: z.object({ ...change, action: z.enum(['hold', 'resume', 'abandon', 'reopen']), reason: text, grantId: id.optional() }).strict(),
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
  evidence_get: z.object({ ...target, kind: z.enum(['snapshot','qa_report','review','git_submission','git_attempt','git_binding','defect','scope_decision']), evidenceId: id }).strict(),
  delivery_decide: deliveryDecisionSchema,
  git_submit: z.object({ ...change, candidateId: id, commitUrl: z.string().min(1).max(1000), additionalCommits: z.array(z.object({ repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/), commitUrl: z.string().min(1).max(1000) }).strict()).max(20).default([]) }).strict(),
  git_retry: z.object({ ...change, submissionId: id }).strict(),
  delivery_complete: z.object({ ...change, grantId: id.optional() }).strict(),
  gap_list: z.object(scoped).strict(),
  event_list: z.object({ ...scoped, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
} as const;
export type Operation = keyof typeof schemas;
export const agentOperations = Object.keys(schemas).filter(k => !k.startsWith('ui_') && !['actor_enroll', 'design_decide', 'workspace_register', 'workspace_git_bind', 'check_profile_create', 'delivery_decide', 'grant_create', 'grant_revoke','scope_decide','work_reconcile','inbox_list','inbox_settings_get','inbox_settings_update','defect_report','defect_triage','defect_withdraw'].includes(k)) as Operation[];
