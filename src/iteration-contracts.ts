import { z } from 'zod';
import type { Issue, State } from './contracts.js';

export const iterationStates = ['PLANNED', 'ACTIVE', 'CLOSED'] as const;
export type IterationState = typeof iterationStates[number];
export interface IterationIssue extends Issue { iterationId?: string | null; legacyIterationLabel?: string | null }
export interface Iteration {
  id: string; workspaceId: string; name: string; goal: string; startDate: string; endDate: string; timeZone: string;
  state: IterationState; version: number; membershipRevision: number; membershipHash: string;
  createdAt: string; createdBy: string; updatedAt: string; startedAt?: string; closedAt?: string; summaryId?: string;
}
export interface MembershipPrecondition { iterationId: string; expectedVersion: number; membershipRevision: number; membershipHash: string }
export interface IssuePrecondition { issueId: string; expectedVersion: number }
export interface MembershipChange extends IssuePrecondition { iterationId: string | null }
export interface LegacyAdoption { label: string; matches: IssuePrecondition[]; matchHash: string; memberships: MembershipPrecondition[] }
export interface IterationMembershipEvent {
  id: string; workspaceId: string; iterationId: string; issueId: string; kind: 'ADD' | 'REMOVE'; at: string;
  sequence: number; actorId: string; transactionId: string; issueVersion: number; fromIterationId: string | null;
  toIterationId: string | null; state: State; parentId: string | null; designStatus: string | null;
}
export interface IterationSummaryMember {
  issueId: string; key: string; state: State; disposition: 'DONE' | 'ABANDONED' | 'CARRIED' | 'BACKLOG';
  targetIterationId: string | null; excluded: boolean;
}
export interface IterationSummary {
  id: string; workspaceId: string; iterationId: string; iterationVersion: number; closedAt: string; actorId: string;
  membershipRevision: number; membershipHash: string; members: IterationSummaryMember[];
  counts: { done: number; abandoned: number; excluded: number; carried: number; returned: number; byState: Record<State, number> };
  openDefects: { defectId: string; issueId: string; severity: string }[];
  humanDecisions: { sequence: number; issueId: string; operation: string; actorId: string; at: string }[];
  runs: { runId: string; issueId: string; state: string; sequence: number | null }[];
}

const id = z.string().min(1).max(150);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const mutation = { idempotencyKey: z.string().min(1).max(200) };
const scoped = { workspaceId: id };
const target = { ...scoped, iterationId: id };
const reason = z.string().min(1).max(65536);
const issueVersion = z.object({ issueId: id, expectedVersion: z.number().int().positive() }).strict();
export const iterationMembershipPreconditionSchema = z.object({ iterationId: id, expectedVersion: z.number().int().positive(), membershipRevision: z.number().int().nonnegative(), membershipHash: digest }).strict();
const membership = iterationMembershipPreconditionSchema;
const adoption = z.object({ label: z.string().min(1).max(120), matches: z.array(issueVersion).max(10000), matchHash: digest, memberships: z.array(membership).max(100) }).strict();
const page = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) };
const dateRange = { startDate: z.iso.date(), endDate: z.iso.date() };
const timeZone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Use a supported IANA time zone');

export const iterationSchemas = {
  iteration_create: z.object({ ...scoped, ...mutation, name: z.string().trim().min(1).max(120), goal: z.string().max(2000), ...dateRange, timeZone, adoption: adoption.optional(), reason }).strict(),
  iteration_update: z.object({ ...target, ...mutation, expectedVersion: z.number().int().positive(), name: z.string().trim().min(1).max(120).optional(), goal: z.string().max(2000).optional(), startDate: z.iso.date().optional(), endDate: z.iso.date().optional(), reason }).strict(),
  iteration_start: z.object({ ...target, ...mutation, expectedVersion: z.number().int().positive(), reason }).strict(),
  iteration_close: z.object({ ...target, ...mutation, expectedVersion: z.number().int().positive(), membershipRevision: z.number().int().nonnegative(), membershipHash: digest, members: z.array(issueVersion).max(10000), dispositions: z.array(z.object({ issueId: id, iterationId: id.nullable() }).strict()).max(10000), destinations: z.array(membership).max(100), reason }).strict(),
  iteration_membership_set: z.object({ ...scoped, ...mutation, changes: z.array(z.object({ issueId: id, expectedVersion: z.number().int().positive(), iterationId: id.nullable() }).strict()).min(1).max(10000), memberships: z.array(membership).max(100), adoption: z.object({ label: z.string().min(1).max(120), matches: z.array(issueVersion).max(10000), matchHash: digest }).strict().optional(), reason }).strict(),
  iteration_list: z.object({ ...scoped, state: z.enum(iterationStates).optional(), ...page, legacyLabel: z.string().min(1).max(120).optional() }).strict(),
  iteration_get: z.object({ ...target, ...page, view: z.enum(['summary', 'full', 'flow', 'markdown']).default('summary'), flowFrom: z.iso.date().optional(), flowLimit: z.number().int().min(1).max(366).default(31), legacyLabel: z.string().min(1).max(120).optional() }).strict()
} as const;
export type IterationOperation = keyof typeof iterationSchemas;
export const iterationReadOperations = ['iteration_list', 'iteration_get'] as const;
export function isIterationOperation(value: string): value is IterationOperation { return Object.hasOwn(iterationSchemas, value); }
