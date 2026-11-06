import { z } from 'zod';

export const roles = ['human', 'lead', 'pm', 'worker', 'qa'] as const;
export type Role = typeof roles[number];
export const harnesses = ['codex', 'claude-code', 'dsh'] as const;
export type Harness = typeof harnesses[number];
export const states = ['NOT_STARTED', 'IN_PROGRESS', 'LEAD_REVIEW', 'LEAD_REJECTED', 'QA_TEST', 'QA_REJECTED', 'USER_ACCEPTANCE', 'USER_REJECTED', 'ON_HOLD', 'ABANDONED', 'DONE'] as const;
export type State = typeof states[number];
export interface Actor { id: string; role: Role; name: string; workspaceIds: string[]; sessionId: string }
export interface Workspace { id: string; name: string; root: string; prefix: string; sequence: number; commonDir: string | null }
export interface Design { id: string; issueId: string; content: string; criteria: string[]; status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED'; hash: string }
export interface Candidate { id: string; workerId: string; sessionId: string; designId: string; files: { path: string; hash: string }[]; hash: string; summary: string }
export interface Issue {
  id: string; workspaceId: string; key: string; parentId: string | null; title: string; description: string;
  state: State; stage: 'PRE_QA' | 'FINAL' | null; version: number; scopeRevision: number;
  criteria: string[]; assignee: string | null; harness: Harness | null; dependencies: string[];
  priority: number; plannedStart: string | null; dueDate: string | null; designId: string | null;
  fence: number; lease: { actorId: string; expiresAt: number; fence: number } | null;
  candidate: Candidate | null; initialReview: string | null; qaReview: string | null;
  finalReview: string | null; savedState: { state: State; stage: Issue['stage'] } | null;
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
  issue_create: z.object({ ...scoped, ...mutation, parentId: id.optional(), expectedParentVersion: z.number().int().positive().optional(), title: z.string().min(1).max(300), description: z.string().max(65536).default(''), criteria: z.array(id).max(100).default([]) }).strict(),
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
  gap_list: z.object(scoped).strict(),
  event_list: z.object({ ...scoped, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
} as const;
export type Operation = keyof typeof schemas;
export const agentOperations = Object.keys(schemas).filter(k => !['actor_enroll', 'design_decide', 'workspace_register'].includes(k)) as Operation[];
