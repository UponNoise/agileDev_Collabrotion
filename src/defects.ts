import { randomUUID } from 'node:crypto';
import { type Actor, type Design, type Issue, type QaReport, type Snapshot, type Workspace, DomainError } from './contracts.js';
import { canonical, hash, Store } from './store.js';
import { defectCoreSchemas, defectFindingSchema, defectOrigins, defectRejectionSchema, defectSeverities, defectStates, type DefectFinding, type DefectListInput, type DefectObservation, type DefectProposalInput, type DefectRecord, type DefectRejectionInput, type DefectRejectionRecord, type DefectReportInput, type DefectSet, type DefectSource, type DefectTriageInput, type DefectWithdrawInput } from './defect-contracts.js';

interface HistoricalDefect {
  id: string; workspaceId: string; issueId: string; state: string; severity: string;
  criterionId: string; reproduce: string; expected: string; actual: string;
  reportId: string; candidateId: string; snapshotId: string; ownerId?: string | null;
  resolutionReportId?: string;
}
interface SourceRecord {
  id: string; workspaceId: string; issueId: string; actorId: string; kind: string; at: string; data: unknown;
}
interface Sequence { id: string; workspaceId: string; sequence: number }
interface SetRevision { id: string; workspaceId: string; required: DefectSet; decision: DefectSet }
interface DeliveryApproval { id: string; issueId: string; actorId: string; candidateId: string; digest: string; decision: string; at: string }
export interface DefectEffects {
  deliveryDigest(issue: Issue): string;
  reopen?(actor: Actor, issue: Issue, reason: string): void;
  createRequirement?(actor: Actor, issue: Issue, input: { title: string; description: string; criteria: string[] }, reason: string): Issue;
}

function requireHuman(actor: Actor) {
  if (actor.role !== 'human') throw new DomainError('ROLE_DENIED', 'Defect decisions require human authority', 403);
}
function expectedVersion(actual: number, expected: number) {
  if (actual !== expected) throw new DomainError('VERSION_CONFLICT', 'The defect or issue changed; reload before retrying', 409, { currentVersion: actual });
}
function parsed<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError('INVALID_INPUT', 'Defect command failed schema validation', 400, result.error.flatten());
  return result.data;
}
function maybe<T>(store: Store, kind: string, id: string): T | null {
  try { return store.get<T>(kind, id); }
  catch (error) { if (error instanceof DomainError && error.code === 'NOT_FOUND') return null; throw error; }
}

export class DefectRegistry {
  constructor(readonly store: Store, readonly effects: DefectEffects, readonly now = () => Date.now()) {}

  private all(workspaceId: string, visible?: Set<string>): DefectRecord[] {
    const workspace = this.store.get<Workspace>('workspace', workspaceId);
    const raw = this.store.list<DefectRecord | HistoricalDefect>('defect', workspaceId);
    const used = new Set(raw.flatMap(record => 'key' in record ? [record.key] : []));
    let sequence = 0;
    return raw.flatMap(record => {
      if ('registryVersion' in record) {
        if (visible && !visible.has(record.issueId)) return [];
        const proposal = ['PROPOSED', 'REJECTED', 'CONVERTED'].includes(record.state);
        if (record.workspaceId !== workspaceId || record.registryVersion !== 1 || !defectStates.includes(record.state) || !defectSeverities.includes(record.severity) || !Number.isInteger(record.version) || record.version < 1 || (record.origin !== null && !defectOrigins.includes(record.origin)) || (record.origin === null) !== proposal || (record.origin === 'QA' && record.state === 'WITHDRAWN')) throw new DomainError('DEFECT_RECORD_INVALID', 'Unsupported defect record');
        return [record];
      }
      let key: string;
      do { sequence++; key = `${workspace.prefix}-D${String(sequence).padStart(4, '0')}`; } while (used.has(key));
      used.add(key);
      if (visible && !visible.has(record.issueId)) return [];
      if (['origin', 'version', 'key', 'observation', 'source'].some(field => Object.hasOwn(record, field)) || record.workspaceId !== workspaceId || !['OPEN', 'RESOLVED'].includes(record.state) || !defectSeverities.includes(record.severity as DefectRecord['severity']) || !record.reportId || !record.candidateId || !record.snapshotId || !record.criterionId) throw new DomainError('DEFECT_RECORD_INVALID', 'Historical defect identity is incomplete');
      const report = maybe<QaReport>(this.store, 'qa_report', record.reportId);
      const reviews = this.store.list<{ reportId?: string; issueId: string; stage?: string; at?: string }>('review', workspaceId);
      const review = reviews.find(value => value.reportId === record.reportId && value.issueId === record.issueId && value.stage === 'QA');
      const resolution = reviews.find(value => value.reportId === record.resolutionReportId && value.issueId === record.issueId && value.stage === 'QA');
      const snapshot = maybe<Snapshot>(this.store, 'snapshot', record.snapshotId);
      const observation: DefectObservation = { kind: 'SNAPSHOT', issueVersion: null, scopeRevision: null, designId: null, candidateId: record.candidateId, snapshotId: record.snapshotId, snapshotHash: snapshot?.hash ?? null, digest: null };
      const reporter = report?.workspaceId === workspaceId && report.issueId === record.issueId && report.candidateId === record.candidateId && report.snapshotId === record.snapshotId ? report.actorId : null;
      return [{ ...record, key, version: 1, registryVersion: 1, origin: 'QA', state: record.state as 'OPEN' | 'RESOLVED', severity: record.severity as DefectRecord['severity'], criterionIds: [record.criterionId], observation, initialObservation: observation, reporterId: reporter, ownerId: record.ownerId ?? null, source: { kind: 'QA_REPORT', id: record.reportId }, createdAt: review?.at ?? null, updatedAt: record.state === 'RESOLVED' ? resolution?.at ?? null : review?.at ?? null, legacy: true }];
    });
  }

  migrate(workspaceId: string) {
    return this.store.db.transaction(() => {
      const rows = this.all(workspaceId);
      const raw = this.store.list<DefectRecord | HistoricalDefect>('defect', workspaceId);
      rows.forEach((record, index) => { if (!('registryVersion' in raw[index]!)) this.store.put('defect', record, workspaceId); });
      const max = rows.reduce((value, record) => Math.max(value, Number(record.key.match(/-D(\d+)$/)?.[1] ?? 0)), 0);
      const counter = maybe<Sequence>(this.store, 'defect_sequence', workspaceId);
      if (!counter || counter.sequence < max) this.store.put('defect_sequence', { id: workspaceId, workspaceId, sequence: Math.max(max, counter?.sequence ?? 0) }, workspaceId);
      return rows;
    }).immediate();
  }

  list(actor: Actor, input: DefectListInput) {
    const a = parsed(defectCoreSchemas.list, input);
    this.store.workspace(actor, a.workspaceId);
    if (a.issueId) this.store.issue(actor, a.workspaceId, a.issueId);
    const visible = new Set(this.store.list<Issue>('issue', a.workspaceId).filter(issue => {
      try { this.store.issue(actor, a.workspaceId, issue.id); return true; }
      catch (error) { if (error instanceof DomainError && error.code === 'SCOPE_DENIED') return false; throw error; }
    }).map(issue => issue.id));
    const rows = this.all(a.workspaceId, visible).filter(record => (!a.issueId || record.issueId === a.issueId) && (!a.state || record.state === a.state) && (!a.severity || record.severity === a.severity) && (!a.origin || record.origin === a.origin));
    return { defects: rows.slice(a.offset, a.offset + a.limit), total: rows.length, nextOffset: a.offset + a.limit < rows.length ? a.offset + a.limit : null };
  }

  gaps(actor: Actor, workspaceId: string) {
    this.store.workspace(actor,workspaceId);
    const visible = new Map(this.store.list<Issue>('issue',workspaceId).flatMap(issue => {
      try { this.store.issue(actor,workspaceId,issue.id); return [[issue.id,issue] as const]; }
      catch (error) { if (error instanceof DomainError && error.code === 'SCOPE_DENIED') return []; throw error; }
    }));
    return this.all(workspaceId,new Set(visible.keys())).flatMap(defect => {
      const code = defect.state === 'PROPOSED' ? 'DEFECT_TRIAGE_PENDING' : defect.state === 'OPEN' && defect.origin === 'ESCAPED' ? 'ESCAPED_DEFECT_OPEN' : null;
      return code ? [{ issueId: defect.issueId,key: visible.get(defect.issueId)!.key,defectId: defect.id,code,severity: 'advisory' }] : [];
    });
  }

  get(actor: Actor, workspaceId: string, defectId: string) {
    this.store.workspace(actor, workspaceId);
    const raw = this.store.get<DefectRecord | HistoricalDefect>('defect', defectId);
    if (raw.workspaceId !== workspaceId) throw new DomainError('SCOPE_DENIED', 'Defect belongs to another workspace', 403);
    this.store.issue(actor, workspaceId, raw.issueId);
    return this.all(workspaceId, new Set([raw.issueId])).find(record => record.id === defectId)!;
  }

  private scopeObservation(issue: Issue): DefectObservation {
    const root = issue.parentId ? this.store.get<Issue>('issue', issue.parentId) : issue;
    return { kind: 'ISSUE_SCOPE', issueVersion: issue.version, scopeRevision: issue.scopeRevision, designId: root.designId, candidateId: null, snapshotId: null, snapshotHash: null, digest: null };
  }

  observe(issue: Issue): DefectObservation {
    const scope = this.scopeObservation(issue);
    if (issue.state === 'DONE' && issue.acceptedDigest) {
      const approval = this.store.list<DeliveryApproval>('delivery_approval', issue.workspaceId).find(record => record.issueId === issue.id && record.decision === 'ACCEPT' && record.digest === issue.acceptedDigest && (!issue.candidate || record.candidateId === issue.candidate.id) && this.store.get<Actor>('actor', record.actorId).role === 'human');
      if (approval) return { ...scope, kind: 'DELIVERY', candidateId: approval.candidateId, snapshotId: issue.candidate?.snapshotId ?? null, snapshotHash: issue.candidate?.hash ?? null, digest: approval.digest };
    }
    const snapshot = issue.candidate?.snapshotId ? maybe<Snapshot>(this.store, 'snapshot', issue.candidate.snapshotId) : null;
    if (!snapshot || snapshot.workspaceId !== issue.workspaceId || snapshot.issueId !== issue.id || snapshot.candidateId !== issue.candidate?.id || snapshot.hash !== issue.candidate.hash) return scope;
    const observed = { ...scope, kind: 'SNAPSHOT' as const, candidateId: snapshot.candidateId, snapshotId: snapshot.id, snapshotHash: snapshot.hash };
    if (issue.state !== 'USER_ACCEPTANCE') return observed;
    try { return { ...observed, kind: 'DELIVERY', digest: this.effects.deliveryDigest(issue) }; }
    catch (error) { if (error instanceof DomainError) return observed; throw error; }
  }

  private find(actor: Actor, workspaceId: string, defectId: string, expected: number) {
    const defect = this.get(actor, workspaceId, defectId);
    expectedVersion(defect.version, expected);
    return defect;
  }
  private criteria(issue: Issue, finding: DefectFinding) {
    if (finding.criterionIds.some(id => !issue.criteria.includes(id))) throw new DomainError('CRITERIA_UNMAPPED', 'Defect criteria must belong to the affected issue');
  }
  private source(actor: Actor, issue: Issue, kind: string, data: unknown): SourceRecord {
    const record = { id: randomUUID(), workspaceId: issue.workspaceId, issueId: issue.id, actorId: actor.id, kind, at: new Date(this.now()).toISOString(), data };
    this.store.put('defect_source', record, issue.workspaceId);
    return record;
  }
  private create(actor: Actor, issue: Issue, finding: DefectFinding, origin: DefectRecord['origin'], observation: DefectObservation, source: DefectSource, state: 'PROPOSED' | 'OPEN') {
    finding = parsed(defectFindingSchema, { severity: finding.severity, criterionIds: finding.criterionIds, reproduce: finding.reproduce, expected: finding.expected, actual: finding.actual });
    this.criteria(issue, finding);
    this.migrate(issue.workspaceId);
    const before = this.currentSets(issue.workspaceId, issue.id);
    const counter = this.store.get<Sequence>('defect_sequence', issue.workspaceId);
    counter.sequence++;
    this.store.put('defect_sequence', counter, issue.workspaceId);
    const workspace = this.store.get<Workspace>('workspace', issue.workspaceId);
    const at = new Date(this.now()).toISOString();
    const record: DefectRecord = { id: randomUUID(), workspaceId: issue.workspaceId, issueId: issue.id, key: `${workspace.prefix}-D${String(counter.sequence).padStart(4, '0')}`, version: 1, registryVersion: 1, origin, state, severity: finding.severity, criterionIds: finding.criterionIds, reproduce: finding.reproduce, expected: finding.expected, actual: finding.actual, observation, initialObservation: observation, reporterId: actor.id, ownerId: issue.assignee, source, createdAt: at, updatedAt: at };
    this.store.put('defect', record, issue.workspaceId);
    this.updateSets(issue.workspaceId, issue.id, before);
    this.store.event(issue.workspaceId, actor, 'defect_created', record.id, { issueId: issue.id, key: record.key, version: record.version, origin, state, source });
    return record;
  }
  private save(actor: Actor, record: DefectRecord, operation: string, data: unknown) {
    const before = this.currentSets(record.workspaceId, record.issueId);
    record.version++;
    record.updatedAt = new Date(this.now()).toISOString();
    this.store.put('defect', record, record.workspaceId);
    this.updateSets(record.workspaceId, record.issueId, before);
    this.store.event(record.workspaceId, actor, operation, record.id, { issueId: record.issueId, version: record.version, state: record.state, ...data as object });
    return record;
  }

  propose(actor: Actor, input: DefectProposalInput) {
    if (actor.role === 'human') throw new DomainError('ROLE_DENIED', 'Agent proposals require an agent identity', 403);
    const a = parsed(defectCoreSchemas.propose, input);
    return this.store.db.transaction(() => {
      const issue = this.store.issue(actor, a.workspaceId, a.issueId);
      expectedVersion(issue.version, a.expectedVersion);
      const observation = this.observe(issue);
      const source = this.source(actor, issue, 'AGENT_PROPOSAL', { finding: a, observation });
      return this.create(actor, issue, a, null, observation, { kind: 'AGENT_PROPOSAL', id: source.id }, 'PROPOSED');
    }).immediate();
  }

  report(actor: Actor, input: DefectReportInput) {
    requireHuman(actor);
    const a = parsed(defectCoreSchemas.report, input);
    return this.store.db.transaction(() => {
      const issue = this.store.issue(actor, a.workspaceId, a.issueId);
      expectedVersion(issue.version, a.expectedVersion);
      const observation = this.observe(issue);
      if (issue.state !== 'DONE' || observation.kind !== 'DELIVERY' || canonical(observation) !== canonical(a.observation)) throw new DomainError('DEFECT_OBSERVATION_REQUIRED', 'Escaped reports require the exact closed delivery observation');
      const source = this.source(actor, issue, 'HUMAN_REPORT', { finding: a, observation });
      return this.create(actor, issue, a, 'ESCAPED', observation, { kind: 'HUMAN_REPORT', id: source.id }, 'OPEN');
    }).immediate();
  }

  triage(actor: Actor, input: DefectTriageInput) {
    requireHuman(actor);
    const a = parsed(defectCoreSchemas.triage, input);
    return this.store.db.transaction(() => {
      const record = this.find(actor, a.workspaceId, a.defectId, a.expectedVersion);
      if (record.state !== 'PROPOSED' || record.origin !== null) return this.triageConfirmed(actor,record,a);
      if (['REOPEN','DEFER'].includes(a.action)) throw new DomainError('INVALID_INPUT','Pending problems must be confirmed before an escaped-defect disposition');
      if (a.action === 'REJECT' && (a.severity || a.observation || a.disposition || a.requirement)) throw new DomainError('INVALID_INPUT','Proposal rejection takes only a reason');
      if (a.action === 'CONFIRM' && a.requirement || a.action === 'NEW_REQUIREMENT' && (a.severity || a.observation || a.disposition)) throw new DomainError('INVALID_INPUT','Triage fields do not match the selected action');
      const issue = this.store.issue(actor, a.workspaceId, record.issueId);
      expectedVersion(issue.version, a.expectedIssueVersion);
      const issueVersion = issue.version;
      const initialSource = record.source;
      let nextObservation: DefectObservation | undefined;
      let confirmedOrigin: DefectRecord['origin'] = null;
      let requirement: Issue | undefined;
      if (a.action === 'CONFIRM') {
        const current = this.observe(issue);
        if (!['USER_ACCEPTANCE', 'DONE'].includes(issue.state) || current.kind !== 'DELIVERY' || !a.observation || canonical(current) !== canonical(a.observation)) throw new DomainError('DEFECT_OBSERVATION_REQUIRED', 'Confirmation requires current immutable evidence in an actual acceptance or closed context');
        if (!a.severity) throw new DomainError('INVALID_INPUT', 'Confirmation requires an explicit severity');
        if (issue.state === 'DONE' && !a.disposition) throw new DomainError('INVALID_INPUT', 'A confirmed escaped defect requires REOPEN or DEFER');
        if (issue.state === 'USER_ACCEPTANCE' && a.disposition) throw new DomainError('INVALID_INPUT', 'Current acceptance confirmation cannot reopen or defer a closed delivery');
        nextObservation = current;
        confirmedOrigin = issue.state === 'DONE' ? 'ESCAPED' : 'USER_ACCEPTANCE';
        if (a.disposition === 'REOPEN') {
          if (!this.effects.reopen) throw new DomainError('CAPABILITY_UNSUPPORTED', 'The workflow reopen integration is required', 501);
          this.effects.reopen(actor, issue, a.reason);
          const reopened = this.store.get<Issue>('issue', issue.id);
          if (reopened.state !== 'NOT_STARTED' || reopened.version <= issue.version || reopened.candidate || reopened.acceptedDigest) throw new DomainError('DEFECT_EFFECT_INVALID', 'The reopen integration must apply the existing authorized reset');
        }
      } else if (a.action === 'NEW_REQUIREMENT') {
        if (!a.requirement || !this.effects.createRequirement) throw new DomainError('CAPABILITY_UNSUPPORTED', 'Explicit requirement details and workflow creation integration are required', 501);
        requirement = this.effects.createRequirement(actor, issue, a.requirement, a.reason);
        const saved = this.store.get<Issue>('issue', requirement.id);
        if (saved.workspaceId !== issue.workspaceId || saved.parentId !== null || saved.state !== 'NOT_STARTED' || saved.designId || saved.assignee) throw new DomainError('DEFECT_EFFECT_INVALID', 'Converted proposals must create an unapproved unstarted requirement in the same workspace');
      }
      const decision = this.source(actor, issue, 'HUMAN_TRIAGE', { defectId: record.id, expectedDefectVersion: record.version, expectedIssueVersion: issueVersion, action: a.action, severity: a.severity ?? null, disposition: a.disposition ?? null, reason: a.reason, initialObservation: record.initialObservation, confirmationObservation: nextObservation ?? null, requirementId: requirement?.id ?? null });
      record.proposalSource = initialSource;
      record.source = { kind: 'HUMAN_TRIAGE', id: decision.id };
      record.triageId = decision.id;
      if (a.action === 'REJECT') record.state = 'REJECTED';
      else if (a.action === 'NEW_REQUIREMENT') {
        record.state = 'CONVERTED';
        this.store.put('defect_requirement', { id: record.id, workspaceId: issue.workspaceId, issueId: issue.id, defectId: record.id, requirementId: requirement!.id, decisionId: decision.id }, issue.workspaceId);
      } else {
        record.state = 'OPEN'; record.origin = confirmedOrigin;
        record.severity = a.severity!; record.observation = nextObservation!; record.confirmedBy = actor.id;
      }
      return { defect: this.save(actor, record, 'defect_triaged', { decisionId: decision.id, action: a.action }), ...(requirement ? { requirement } : {}) };
    }).immediate();
  }

  private triageConfirmed(actor: Actor,record: DefectRecord,a: ReturnType<typeof defectCoreSchemas.triage.parse>) {
    if (record.origin !== 'ESCAPED' || record.state !== 'OPEN' || !['REOPEN','DEFER','NEW_REQUIREMENT'].includes(a.action)) throw new DomainError('INVALID_TRANSITION','Only open escaped defects support a closed-delivery disposition');
    if (a.severity || a.disposition || (a.action !== 'NEW_REQUIREMENT' && a.requirement)) throw new DomainError('INVALID_INPUT','Confirmed triage cannot change severity or take unrelated fields');
    const issue = this.store.issue(actor,a.workspaceId,record.issueId);
    expectedVersion(issue.version,a.expectedIssueVersion);
    const observation = this.observe(issue);
    if (issue.state !== 'DONE' || observation.kind !== 'DELIVERY' || !a.observation || canonical(observation) !== canonical(a.observation) || observation.digest !== record.observation.digest || observation.candidateId !== record.observation.candidateId || observation.snapshotId !== record.observation.snapshotId || observation.snapshotHash !== record.observation.snapshotHash) throw new DomainError('DEFECT_OBSERVATION_REQUIRED','Disposition requires the current closed delivery that contains the reported defect');
    const issueVersion = issue.version;
    let requirement: Issue | undefined;
    if (a.action === 'REOPEN') {
      if (!this.effects.reopen) throw new DomainError('CAPABILITY_UNSUPPORTED','The workflow reopen integration is required',501);
      this.effects.reopen(actor,issue,a.reason);
      const reopened = this.store.get<Issue>('issue',issue.id);
      if (reopened.state !== 'NOT_STARTED' || reopened.version <= issue.version || reopened.candidate || reopened.acceptedDigest) throw new DomainError('DEFECT_EFFECT_INVALID','The reopen integration must apply the existing authorized reset');
    } else if (a.action === 'NEW_REQUIREMENT') {
      if (!a.requirement || !this.effects.createRequirement) throw new DomainError('INVALID_INPUT','A new requirement needs explicit requirement details');
      if (maybe(this.store,'defect_requirement',record.id)) throw new DomainError('INVALID_TRANSITION','This defect already has a linked requirement');
      requirement = this.effects.createRequirement(actor,issue,a.requirement,a.reason);
      const saved = this.store.get<Issue>('issue',requirement.id);
      if (saved.workspaceId !== issue.workspaceId || saved.parentId !== null || saved.state !== 'NOT_STARTED' || saved.designId || saved.assignee) throw new DomainError('DEFECT_EFFECT_INVALID','A linked requirement must start unapproved and unassigned in this workspace');
    }
    const decision = this.source(actor,issue,'HUMAN_TRIAGE',{ defectId: record.id,expectedDefectVersion: record.version,expectedIssueVersion: issueVersion,action: a.action,reason: a.reason,observation,requirementId: requirement?.id ?? null });
    record.triageId = decision.id;
    if (requirement) this.store.put('defect_requirement',{ id: record.id,workspaceId: issue.workspaceId,issueId: issue.id,defectId: record.id,requirementId: requirement.id,decisionId: decision.id },issue.workspaceId);
    return { defect: this.save(actor,record,'defect_triaged',{ decisionId: decision.id,action: a.action }),...(requirement ? { requirement } : {}) };
  }

  withdraw(actor: Actor, input: DefectWithdrawInput) {
    requireHuman(actor);
    const a = parsed(defectCoreSchemas.withdraw, input);
    return this.store.db.transaction(() => {
      const record = this.find(actor, a.workspaceId, a.defectId, a.expectedVersion);
      if (!['USER_ACCEPTANCE', 'ESCAPED'].includes(record.origin ?? '') || !['OPEN', 'RESOLVED', 'WAIVED'].includes(record.state)) throw new DomainError('DEFECT_WITHDRAWAL_DENIED', 'Only confirmed human-origin defects can be withdrawn');
      const issue = this.store.issue(actor, a.workspaceId, record.issueId);
      const decision = this.source(actor, issue, 'HUMAN_WITHDRAWAL', { defectId: record.id, expectedVersion: record.version, reason: a.reason });
      record.state = 'WITHDRAWN'; record.withdrawalId = decision.id;
      return this.save(actor, record, 'defect_withdrawn', { decisionId: decision.id, reason: a.reason });
    }).immediate();
  }

  recordRejection(actor: Actor, workspaceId: string, issueId: string, approvalId: string, findings: DefectFinding[]) {
    requireHuman(actor);
    return this.store.db.transaction(() => {
      const issue = this.store.issue(actor, workspaceId, issueId);
      const approval = this.store.get<DeliveryApproval>('delivery_approval', approvalId);
      if (!['USER_ACCEPTANCE', 'USER_REJECTED'].includes(issue.state) || approval.issueId !== issue.id || approval.actorId !== actor.id || approval.decision !== 'REJECT' || approval.candidateId !== issue.candidate?.id || approval.digest !== this.effects.deliveryDigest(issue)) throw new DomainError('APPROVAL_STALE', 'Defect rejection must reference the current actual human rejection');
      if (findings.length < 1 || findings.length > 20) throw new DomainError('INVALID_INPUT', 'Defect rejection requires one to twenty findings');
      const observation = this.observe({ ...issue, state: 'USER_ACCEPTANCE' });
      if (observation.kind !== 'DELIVERY') throw new DomainError('DEFECT_OBSERVATION_REQUIRED', 'Rejection requires a sealed delivery observation');
      return findings.map((finding, index) => {
        const existing = this.all(workspaceId).find(record => record.source.kind === 'DELIVERY_REJECTION' && record.source.id === approval.id && record.source.index === index);
        if (existing) {
          if (canonical({ severity: existing.severity, criterionIds: existing.criterionIds, reproduce: existing.reproduce, expected: existing.expected, actual: existing.actual }) !== canonical(finding)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'The recorded rejection finding differs');
          return existing;
        }
        return this.create(actor, issue, finding, 'USER_ACCEPTANCE', observation, { kind: 'DELIVERY_REJECTION', id: approval.id, index }, 'OPEN');
      });
    }).immediate();
  }

  classifyRejection(actor: Actor, workspaceId: string, issueId: string, approvalId: string, input: DefectRejectionInput) {
    requireHuman(actor);
    const a = parsed(defectRejectionSchema, input);
    return this.store.db.transaction(() => {
      const issue = this.store.issue(actor, workspaceId, issueId);
      const approval = this.store.get<DeliveryApproval>('delivery_approval', approvalId);
      if (!['USER_ACCEPTANCE', 'USER_REJECTED'].includes(issue.state) || approval.issueId !== issue.id || approval.actorId !== actor.id || approval.decision !== 'REJECT' || approval.candidateId !== issue.candidate?.id || approval.digest !== this.effects.deliveryDigest(issue)) throw new DomainError('APPROVAL_STALE', 'Classification must reference the current actual human rejection');
      const requestHash = hash(canonical(a));
      const existing = maybe<DefectRejectionRecord>(this.store, 'delivery_rejection', approvalId);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'The rejection classification was already recorded differently');
        return existing;
      }
      const requirement = issue.parentId ? this.store.get<Issue>('issue', issue.parentId) : issue;
      const defects = a.classification === 'DEFECT' ? this.recordRejection(actor, workspaceId, issueId, approvalId, a.findings) : [];
      this.store.event(workspaceId, actor, 'delivery_rejection_classified', issue.id, { approvalId, classification: a.classification, requirementId: requirement.id, designId: requirement.designId, defectIds: defects.map(value => value.id) });
      const event = this.store.db.prepare('SELECT last_insert_rowid() AS sequence').get() as { sequence: number };
      const record: DefectRejectionRecord = { id: approvalId, workspaceId, issueId, requirementId: requirement.id, actorId: actor.id, classification: a.classification, candidateId: approval.candidateId, digest: approval.digest, designId: requirement.designId, scopeRevision: requirement.scopeRevision, defectIds: defects.map(value => value.id), requestHash, eventSequence: event.sequence, at: approval.at };
      this.store.put('delivery_rejection', record, workspaceId);
      if (a.classification === 'SCOPE_CHANGE') this.store.put('scope_revision_current', { id: issue.id, workspaceId, issueId, requestId: record.id }, workspaceId);
      return record;
    }).immediate();
  }

  needsScopeRevision(issue: Issue) {
    const requirement = issue.parentId ? this.store.get<Issue>('issue', issue.parentId) : issue;
    return [...new Set([issue.id, requirement.id])].some(id => {
      const pointer = maybe<{ workspaceId: string; issueId: string; requestId: string }>(this.store, 'scope_revision_current', id);
      if (!pointer) return false;
      const request = maybe<DefectRejectionRecord>(this.store, 'delivery_rejection', pointer.requestId);
      if (!request || pointer.workspaceId !== issue.workspaceId || pointer.issueId !== id || request.workspaceId !== issue.workspaceId || request.issueId !== id || request.requirementId !== requirement.id || request.classification !== 'SCOPE_CHANGE') return true;
      if (!requirement.designId || requirement.designId === request.designId) return true;
      const design = maybe<Design>(this.store, 'design', requirement.designId);
      if (!design || design.issueId !== requirement.id || design.status !== 'APPROVED' || design.requirementDescription !== requirement.description) return true;
      const approved = this.store.list<{ actorId: string; designId: string; hash: string; decision: string }>('approval', issue.workspaceId).some(value => value.designId === design.id && value.hash === design.hash && value.decision === 'APPROVED' && maybe<Actor>(this.store, 'actor', value.actorId)?.role === 'human');
      if (!approved) return true;
      const events = this.store.db.prepare("SELECT data,actor_id FROM events WHERE workspace_id=? AND target_id=? AND operation='design_decide' AND sequence>?").all(issue.workspaceId, requirement.id, request.eventSequence) as { data: string; actor_id: string }[];
      return !events.some(value => {
        const data = JSON.parse(value.data) as { designId?: string; decision?: string };
        return data.designId === design.id && data.decision === 'APPROVED' && maybe<Actor>(this.store, 'actor', value.actor_id)?.role === 'human';
      });
    });
  }

  recordQaFindings(actor: Actor, reportId: string) {
    if (actor.role !== 'qa') throw new DomainError('ROLE_DENIED', 'QA findings require the actual QA producer', 403);
    return this.store.db.transaction(() => {
      const report = this.store.get<QaReport>('qa_report', reportId);
      const issue = this.store.issue(actor, report.workspaceId, report.issueId);
      if (report.actorId !== actor.id || report.sessionId !== actor.sessionId || report.candidateId !== issue.candidate?.id || report.snapshotId !== issue.candidate.snapshotId) throw new DomainError('REVIEW_INDEPENDENCE_REQUIRED', 'QA findings must match the actual producer and snapshot');
      const snapshot = this.store.get<Snapshot>('snapshot', report.snapshotId);
      if (snapshot.issueId !== issue.id || snapshot.workspaceId !== issue.workspaceId || snapshot.candidateId !== report.candidateId) throw new DomainError('EVIDENCE_STALE', 'QA finding snapshot belongs elsewhere');
      const observation: DefectObservation = { ...this.scopeObservation(issue), kind: 'SNAPSHOT', candidateId: report.candidateId, snapshotId: report.snapshotId, snapshotHash: snapshot.hash };
      return report.findings.map((finding, index) => {
        const existing = this.all(issue.workspaceId).find(record => record.source.kind === 'QA_REPORT' && record.source.id === report.id && record.source.index === index);
        if (existing) {
          if (canonical({ severity: existing.severity, criterionIds: existing.criterionIds, reproduce: existing.reproduce, expected: existing.expected, actual: existing.actual }) !== canonical({ severity: finding.severity, criterionIds: [finding.criterionId], reproduce: finding.reproduce, expected: finding.expected, actual: finding.actual })) throw new DomainError('EVIDENCE_STALE', 'A recorded QA finding changed');
          return existing;
        }
        const record = this.create(actor, issue, { ...finding, criterionIds: [finding.criterionId] }, 'QA', observation, { kind: 'QA_REPORT', id: report.id, index }, 'OPEN');
        record.reportId = report.id; record.candidateId = report.candidateId; record.snapshotId = report.snapshotId; record.criterionId = finding.criterionId;
        this.store.put('defect', record, issue.workspaceId);
        return record;
      });
    }).immediate();
  }

  resolveLegacyQaPass(actor: Actor, reportId: string) {
    if (actor.role !== 'qa') throw new DomainError('ROLE_DENIED', 'QA resolution requires the actual QA producer', 403);
    return this.store.db.transaction(() => {
      const report = this.store.get<QaReport>('qa_report', reportId);
      this.store.issue(actor, report.workspaceId, report.issueId);
      if (report.actorId !== actor.id || report.sessionId !== actor.sessionId || report.verdict !== 'PASS') throw new DomainError('REVIEW_INDEPENDENCE_REQUIRED', 'Only the current actual passing producer may apply legacy QA resolution');
      this.migrate(report.workspaceId);
      return this.all(report.workspaceId).filter(record => record.issueId === report.issueId && record.origin === 'QA' && record.state === 'OPEN' && record.reportId !== report.id).map(record => {
        record.state = 'RESOLVED'; record.resolutionReportId = report.id;
        return this.save(actor, record, 'legacy_qa_defect_resolved', { reportId: report.id, policy: 'PRE_EXPLICIT_DEFECT_VERIFICATION' });
      });
    }).immediate();
  }

  private currentSets(workspaceId: string, issueId: string) {
    const members = this.all(workspaceId, new Set([issueId])).filter(record => record.origin !== null && (record.state === 'OPEN' || record.state === 'WAIVED')).map(record => ({ id: record.id, version: record.version })).sort((a, b) => a.id.localeCompare(b.id));
    const digest = hash(canonical(members));
    return { required: { members, hash: digest }, decision: { members, hash: digest } };
  }
  private updateSets(workspaceId: string, issueId: string, before: ReturnType<DefectRegistry['currentSets']>) {
    const after = this.currentSets(workspaceId, issueId);
    const value = maybe<SetRevision>(this.store, 'defect_set', issueId);
    if (before.required.hash === after.required.hash && before.decision.hash === after.decision.hash) return;
    this.store.put('defect_set', { id: issueId, workspaceId, required: { ...after.required, revision: (value?.required.revision ?? 0) + Number(before.required.hash !== after.required.hash) }, decision: { ...after.decision, revision: (value?.decision.revision ?? 0) + Number(before.decision.hash !== after.decision.hash) } }, workspaceId);
  }
  confirmedSet(actor: Actor, workspaceId: string, issueId: string, kind: 'required' | 'decision' = 'decision'): DefectSet {
    this.store.issue(actor, workspaceId, issueId);
    const current = this.currentSets(workspaceId, issueId)[kind];
    const value = maybe<SetRevision>(this.store, 'defect_set', issueId);
    return { revision: value?.[kind].revision ?? 0, ...current };
  }
}
