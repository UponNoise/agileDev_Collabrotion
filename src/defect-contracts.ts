import { z } from 'zod';

export const defectSeverities = ['BLOCKER', 'MAJOR', 'MINOR', 'INFO'] as const;
export const defectOrigins = ['QA', 'USER_ACCEPTANCE', 'ESCAPED'] as const;
export const defectStates = ['PROPOSED', 'OPEN', 'RESOLVED', 'WAIVED', 'REJECTED', 'WITHDRAWN', 'CONVERTED'] as const;
export type DefectSeverity = typeof defectSeverities[number];
export type DefectOrigin = typeof defectOrigins[number];
export type DefectState = typeof defectStates[number];

export interface DefectObservation {
  kind: 'ISSUE_SCOPE' | 'SNAPSHOT' | 'DELIVERY';
  issueVersion: number | null;
  scopeRevision: number | null;
  designId: string | null;
  candidateId: string | null;
  snapshotId: string | null;
  snapshotHash: string | null;
  digest: string | null;
}
export interface DefectSource {
  kind: 'QA_REPORT' | 'DELIVERY_REJECTION' | 'HUMAN_REPORT' | 'AGENT_PROPOSAL' | 'HUMAN_TRIAGE';
  id: string;
  index?: number;
}
export interface DefectRecord {
  id: string;
  workspaceId: string;
  issueId: string;
  key: string;
  version: number;
  registryVersion: 1;
  origin: DefectOrigin | null;
  state: DefectState;
  severity: DefectSeverity;
  criterionIds: string[];
  reproduce: string;
  expected: string;
  actual: string;
  observation: DefectObservation;
  initialObservation: DefectObservation;
  reporterId: string | null;
  ownerId: string | null;
  source: DefectSource;
  proposalSource?: DefectSource;
  createdAt: string | null;
  updatedAt: string | null;
  confirmedBy?: string;
  triageId?: string;
  withdrawalId?: string;
  reportId?: string;
  candidateId?: string;
  snapshotId?: string;
  criterionId?: string;
  resolutionReportId?: string;
  legacy?: boolean;
}
export interface DefectFinding {
  severity: DefectSeverity;
  criterionIds: string[];
  reproduce: string;
  expected: string;
  actual: string;
}
export interface DefectSet {
  revision: number;
  hash: string;
  members: { id: string; version: number }[];
}
export interface DefectRejectionRecord {
  id: string;
  workspaceId: string;
  issueId: string;
  requirementId: string;
  actorId: string;
  classification: 'DEFECT' | 'SCOPE_CHANGE' | 'CLARIFICATION';
  candidateId: string;
  digest: string;
  designId: string | null;
  scopeRevision: number;
  defectIds: string[];
  requestHash: string;
  eventSequence: number;
  at: string;
}

const id = z.string().min(1).max(150);
const text = z.string().trim().min(1).max(65536);
const version = z.number().int().positive();
const finding = {
  severity: z.enum(defectSeverities),
  criterionIds: z.array(id).max(100).refine(values => new Set(values).size === values.length, 'Criterion IDs must be distinct').default([]),
  reproduce: text,
  expected: text,
  actual: text
};
export const defectFindingSchema = z.object(finding).strict();
export const defectRejectionSchema = z.discriminatedUnion('classification', [
  z.object({ classification: z.literal('DEFECT'), findings: z.array(defectFindingSchema).min(1).max(20) }).strict(),
  z.object({ classification: z.literal('SCOPE_CHANGE') }).strict(),
  z.object({ classification: z.literal('CLARIFICATION') }).strict()
]);
export const defectObservationSchema = z.object({
  kind: z.enum(['ISSUE_SCOPE', 'SNAPSHOT', 'DELIVERY']),
  issueVersion: version.nullable(),
  scopeRevision: version.nullable(),
  designId: id.nullable(),
  candidateId: id.nullable(),
  snapshotId: id.nullable(),
  snapshotHash: id.nullable(),
  digest: id.nullable()
}).strict();
export const defectCoreSchemas = {
  propose: z.object({ workspaceId: id, issueId: id, expectedVersion: version, ...finding }).strict(),
  report: z.object({ workspaceId: id, issueId: id, expectedVersion: version, observation: defectObservationSchema, ...finding }).strict(),
  list: z.object({ workspaceId: id, issueId: id.optional(), state: z.enum(defectStates).optional(), severity: z.enum(defectSeverities).optional(), origin: z.enum(defectOrigins).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  get: z.object({ workspaceId: id, defectId: id }).strict(),
  triage: z.object({
    workspaceId: id, defectId: id, expectedVersion: version, expectedIssueVersion: version,
    action: z.enum(['REJECT', 'CONFIRM', 'NEW_REQUIREMENT', 'REOPEN', 'DEFER']), reason: text,
    severity: z.enum(defectSeverities).optional(), observation: defectObservationSchema.optional(),
    disposition: z.enum(['REOPEN', 'DEFER']).optional(),
    requirement: z.object({ title: z.string().trim().min(1).max(300), description: text, criteria: z.array(id).max(100).default([]) }).strict().optional()
  }).strict(),
  withdraw: z.object({ workspaceId: id, defectId: id, expectedVersion: version, reason: text }).strict()
};

export type DefectProposalInput = z.input<typeof defectCoreSchemas.propose>;
export type DefectReportInput = z.input<typeof defectCoreSchemas.report>;
export type DefectTriageInput = z.input<typeof defectCoreSchemas.triage>;
export type DefectWithdrawInput = z.input<typeof defectCoreSchemas.withdraw>;
export type DefectListInput = z.input<typeof defectCoreSchemas.list>;
export type DefectRejectionInput = z.input<typeof defectRejectionSchema>;
