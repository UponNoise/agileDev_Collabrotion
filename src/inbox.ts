import { Actor, Design, DomainError, InboxKind, Issue, Run, Workspace, inboxKinds } from './contracts.js';
import { scopeState, taskScopeHash } from './scope.js';
import { canonical, hash, Store } from './store.js';

export { inboxKinds } from './contracts.js';
export type { InboxKind } from './contracts.js';
export interface InboxSettings {
  workspaceId: string; version: number; agingThresholdHours: number; updatedAt: string | null; updatedBy: string | null;
}
interface StoredSettings extends InboxSettings { id: string }
interface AuditEvent {
  sequence: number; targetId: string | null; operation: string; at: string; data: Record<string, any> | null;
}
interface Epoch { sequence: number; at: string | null }
export interface InboxPolicy {
  delivery(issue: Issue): { digest: string | null; accepted: boolean; blockers: string[] };
  unmanaged(issue: Issue): boolean;
}
export interface InboxEntry {
  id: string; kind: InboxKind; workspaceId: string; workspaceName: string; issueId: string; key: string; title: string; url: string;
  target: { issueVersion: number; revisionHash: string | null; designId?: string; designHash?: string; candidateId?: string | null; digest?: string | null; runId?: string; runVersion?: number; fence?: number; parentId?: string; parentVersion?: number; decisionId?: string | null };
  blocking: boolean; status: 'WAITING' | 'BLOCKED' | 'READY_TO_COMPLETE'; blockers: string[]; nextAction: string;
  pendingSince: string | null; pendingSequence: number | null; ageMs: number | null; ageProvenance: 'AUDIT_EVENT' | 'UNAVAILABLE'; clockSkew: boolean;
}
export interface InboxQuery { workspaceId?: string; kind?: InboxKind; offset?: number; limit?: number }
export interface InboxGap { issueId: string; key: string; code: 'HUMAN_DECISION_AGING'; severity: 'advisory'; kind: InboxKind; targetId: string; pendingSince: string; ageMs: number; agingThresholdHours: number }

function human(actor: Actor) {
  if (actor.role !== 'human') throw new DomainError('ROLE_DENIED', 'The decision inbox requires human authority', 403);
}
function maybe<T>(store: Store, kind: string, id: string): T | null {
  try { return store.get<T>(kind, id); }
  catch (error) { if (error instanceof DomainError && error.code === 'NOT_FOUND') return null; throw error; }
}
function iso(at: string) { const value = Date.parse(at); return Number.isFinite(value) ? new Date(value).toISOString() : null; }
function issueFingerprint(issue: Issue) {
  return hash(canonical({ candidateId: issue.candidate?.id ?? null, snapshotId: issue.candidate?.snapshotId ?? null, designId: issue.candidate?.designId ?? null, scopeRevision: issue.scopeRevision, initialReview: issue.initialReview, qaReview: issue.qaReview, finalReview: issue.finalReview, gitSubmissionId: issue.gitSubmissionId ?? null }));
}
function acceptanceState(issue: Issue) { return issue.state === 'ON_HOLD' ? issue.savedState?.state : issue.state; }
function undo(issue: Issue, event: AuditEvent, relevant?: ReadonlySet<string>) {
  const changes = Object.entries(event.data?.changes ?? {}).filter(([, change]) => change && typeof change === 'object' && ('before' in change || 'after' in change));
  for (const [key, change] of changes) if ((!relevant || relevant.has(key)) && canonical((issue as any)[key]) !== canonical((change as { after?: unknown }).after)) return false;
  for (const [key, change] of changes) {
    const before = (change as { before?: unknown }).before;
    if (before === undefined) delete (issue as any)[key]; else (issue as any)[key] = structuredClone(before);
  }
  return true;
}

class History {
  private readonly targets = new Map<string, AuditEvent[]>();
  private readonly bindings: AuditEvent[] = [];
  private readonly bindingStarts: { id: string; sequence: number }[];
  constructor(readonly store: Store, readonly workspace: Workspace) {
    const starts = new Map<string, number>();
    for (const row of store.db.prepare('SELECT sequence,target_id AS targetId,operation,data,at FROM events WHERE workspace_id=? ORDER BY sequence').all(workspace.id) as (Omit<AuditEvent, 'data'> & { data: string })[]) {
      let data: AuditEvent['data'] = null;
      try { const parsed: unknown = JSON.parse(row.data); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, any>; } catch {}
      const event: AuditEvent = { ...row, data };
      if (event.targetId) { const events = this.targets.get(event.targetId) ?? []; events.push(event); this.targets.set(event.targetId, events); }
      if (event.operation === 'workspace_git_bind' || event.operation === 'scope_git_binding_set') {
        this.bindings.push(event);
        const id = event.operation === 'workspace_git_bind' ? event.targetId : event.data?.bindingId;
        if (typeof id === 'string' && !starts.has(id)) starts.set(id, event.sequence);
      }
    }
    this.bindingStarts = [...starts].map(([id, sequence]) => ({ id, sequence })).sort((a, b) => a.sequence - b.sequence);
  }
  for(id: string) { return this.targets.get(id) ?? []; }
  related(ids: ReadonlySet<string>) {
    const events = new Map(this.bindings.map(event => [event.sequence, event]));
    for (const id of ids) for (const event of this.for(id)) events.set(event.sequence, event);
    return [...events.values()].sort((a, b) => a.sequence - b.sequence);
  }
  bindingAt(sequence: number) {
    let low = 0; let high = this.bindingStarts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.bindingStarts[middle]!.sequence <= sequence) low = middle + 1; else high = middle;
    }
    return this.bindingStarts[low - 1]?.id;
  }
  epoch(event?: AuditEvent | null): Epoch | null { return event ? { sequence: event.sequence, at: iso(event.at) } : null; }
  design(issue: Issue, design: Design) {
    for (const event of this.for(issue.id).toReversed()) {
      if (!event.data) return null;
      if (event.data.designId !== design.id) continue;
      if (event.operation === 'design_submit' && event.data.decision === 'IN_REVIEW') return this.epoch(event);
      if (event.operation === 'design_decide') return null;
    }
    return null;
  }
  own(issue: Issue, matches: (value: Issue) => boolean) {
    const shadow = structuredClone(issue);
    if (!matches(shadow)) return null;
    for (const event of this.for(issue.id).toReversed()) {
      if (!event.data) return null;
      if (!undo(shadow, event)) return null;
      if (!matches(shadow)) return this.epoch(event);
    }
    return null;
  }
  run(run: Run) {
    let state: string | null = null; let pending: AuditEvent | null = null;
    for (const event of this.for(run.id)) {
      if (!event.data) { state = null; pending = null; continue; }
      const next = event.operation === 'run_uncertain' ? 'UNCERTAIN' : event.operation === 'run_starting' ? 'STARTING' : event.data.state;
      if (typeof next !== 'string') continue;
      if (next === 'UNCERTAIN' && state !== 'UNCERTAIN') pending = event;
      if (next !== 'UNCERTAIN') pending = null;
      state = next;
    }
    return state === 'UNCERTAIN' ? this.epoch(pending) : null;
  }
  scopePending(view: Store, issue: Issue, sequence = Infinity): boolean {
    const scope = scopeState(view, issue);
    if (scope.status === 'STALE') return true;
    if (issue.state !== 'ABANDONED' || scope.status !== 'INCLUDED') return false;
    if (!scope.decision) return true;
    const abandoned = this.for(issue.id).findLast(event => event.sequence <= sequence && event.data?.changes?.state?.after === 'ABANDONED' && event.data.changes.state.before !== 'ABANDONED');
    const decided = this.for(issue.id).findLast(event => event.sequence <= sequence && event.operation === 'scope_decide' && event.data?.decisionId === scope.decision!.id);
    return !!abandoned && (!decided || abandoned.sequence > decided.sequence);
  }
  scopeFingerprint(view: Store, issue: Issue, scope = scopeState(view, issue)) {
    const root = view.get<Issue>('issue', issue.parentId!);
    return hash(canonical({ issueId: issue.id, scope: taskScopeHash(view, issue), decisionId: scope.decision?.id ?? null, decisionHash: scope.decision?.hash ?? null, bindingId: root.artifactMode === 'artifact' ? null : view.get<Workspace>('workspace', issue.workspaceId).gitBindingId ?? null, rootDesignId: root.designId, replacements: (scope.decision?.replacements ?? []).map(binding => { const replacement = view.get<Issue>('issue', binding.issueId); return { id: replacement.id, hash: taskScopeHash(view, replacement), abandoned: replacement.state === 'ABANDONED' }; }).sort((a, b) => a.id.localeCompare(b.id)) }));
  }
  scope(issue: Issue, fingerprint: string): Epoch | null {
    const current = scopeState(this.store, issue);
    const related = new Set([issue.id, issue.parentId!, ...(current.decision?.replacements ?? []).map(binding => binding.issueId)]);
    const shadows = new Map([...related].map(id => [id, structuredClone(this.store.get<Issue>('issue', id))]));
    const statuses = new Map<string, Design['status']>();
    let sequence = Infinity;
    const view = Object.create(this.store) as Store;
    view.get = <T>(kind: string, id: string): T => {
      if (kind === 'issue' && shadows.has(id)) return shadows.get(id) as T;
      if (kind === 'design' && statuses.has(id)) return { ...this.store.get<Design>(kind, id), status: statuses.get(id)! } as T;
      if (kind === 'workspace' && id === this.workspace.id && this.bindingStarts.length) {
        return { ...this.workspace, gitBindingId: this.bindingAt(sequence) } as T;
      }
      return this.store.get<T>(kind, id);
    };
    const events = this.related(related);
    for (const event of events.toReversed()) {
      if (!event.data) return null;
      if (event.targetId && shadows.has(event.targetId) && !undo(shadows.get(event.targetId)!, event, new Set(['state','scopeRevision','parentId','description','criteria','dependencies','artifactMode','artifactReason','designId','designBindingId','scopeDecisionId']))) return null;
      if (typeof event.data.designId === 'string') {
        if (event.operation === 'design_decide') statuses.set(event.data.designId, 'IN_REVIEW');
        if (event.operation === 'design_submit') statuses.set(event.data.designId, 'DRAFT');
      }
      sequence = event.sequence - 1;
      try {
        const before = shadows.get(issue.id)!;
        if (this.scopeFingerprint(view, before) !== fingerprint || !this.scopePending(view, before, sequence)) {
          if (event.operation === 'issue_create' || event.operation === 'scope_decide' && event.data.decisionId === current.decision?.id) return null;
          return this.epoch(event);
        }
      } catch { return null; }
    }
    return null;
  }
}

function workspaceSettings(store: Store, workspaceId: string): InboxSettings {
  const settings = maybe<StoredSettings>(store, 'inbox_settings', workspaceId);
  if (!settings) return { workspaceId, version: 0, agingThresholdHours: 24, updatedAt: null, updatedBy: null };
  if (settings.id !== workspaceId || settings.workspaceId !== workspaceId || !Number.isInteger(settings.version) || settings.version < 1 || !Number.isInteger(settings.agingThresholdHours) || settings.agingThresholdHours < 1 || settings.agingThresholdHours > 168) throw new DomainError('INBOX_SETTINGS_INVALID', 'Stored inbox settings need repair');
  const { id, ...result } = settings;
  return result;
}
export function inboxSettings(store: Store, actor: Actor, workspaceId: string): InboxSettings {
  human(actor); store.workspace(actor, workspaceId);
  return workspaceSettings(store, workspaceId);
}
export function updateInboxSettings(store: Store, actor: Actor, input: { workspaceId: string; expectedVersion: number; agingThresholdHours: number }, now: number) {
  human(actor);
  if (!store.db.inTransaction) throw new DomainError('TRANSACTION_REQUIRED', 'Inbox settings require a service transaction', 500);
  const previous = inboxSettings(store, actor, input.workspaceId);
  if (previous.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Inbox settings changed; reload before retrying', 409, { currentVersion: previous.version });
  if (!Number.isInteger(input.agingThresholdHours) || input.agingThresholdHours < 1 || input.agingThresholdHours > 168) throw new DomainError('INVALID_INPUT', 'Aging threshold must be 1 through 168 hours', 400);
  const settings: StoredSettings = { id: input.workspaceId, workspaceId: input.workspaceId, version: previous.version + 1, agingThresholdHours: input.agingThresholdHours, updatedAt: new Date(now).toISOString(), updatedBy: actor.id };
  store.put('inbox_settings', settings, input.workspaceId);
  store.event(input.workspaceId, actor, 'inbox_settings_update', input.workspaceId, { version: settings.version, agingThresholdHours: settings.agingThresholdHours, previousThresholdHours: previous.agingThresholdHours });
  const { id, ...result } = settings;
  return { settings: result };
}

function collect(store: Store, workspace: Workspace, policy: InboxPolicy, now: number, allowedIssueIds?: ReadonlySet<string>): InboxEntry[] {
  const issues = store.list<Issue>('issue', workspace.id).filter(issue => !allowedIssueIds || allowedIssueIds.has(issue.id));
  let loadedHistory: History | undefined;
  const history = () => loadedHistory ??= new History(store, workspace);
  const entries: InboxEntry[] = [];
  const append = (issue: Issue, kind: InboxKind, target: InboxEntry['target'], epoch: Epoch | null, blocking: boolean, nextAction: string, blockers: string[] = [], status: InboxEntry['status'] = 'WAITING') => {
    const since = epoch?.at ?? null; const clockSkew = since !== null && Date.parse(since) > now;
    const title = issue.parentId ? `${store.get<Issue>('issue', issue.parentId).title}——${issue.title}` : issue.title;
    entries.push({ id: hash(canonical({ workspaceId: workspace.id, issueId: issue.id, kind, identity: target.runId ?? target.revisionHash ?? null, pendingSequence: epoch?.sequence ?? null })), kind, workspaceId: workspace.id, workspaceName: workspace.name, issueId: issue.id, key: issue.key, title, url: `/w/${workspace.id}/issues/${issue.id}`, target, blocking, status, blockers: [...new Set(blockers)], nextAction, pendingSince: since, pendingSequence: epoch?.sequence ?? null, ageMs: since === null ? null : Math.max(0, now - Date.parse(since)), ageProvenance: since === null ? 'UNAVAILABLE' : 'AUDIT_EVENT', clockSkew });
  };
  for (const issue of issues) {
    if (!issue.parentId && issue.designId) {
      const design = maybe<Design>(store, 'design', issue.designId);
      if (design?.issueId === issue.id && design.status === 'IN_REVIEW') append(issue, 'DESIGN_REVIEW', { issueVersion: issue.version, revisionHash: design.hash, designId: design.id, designHash: design.hash }, history().design(issue, design), true, 'design_decide');
    }
    if (issue.state === 'USER_ACCEPTANCE') {
      const delivery = policy.delivery(issue); const fingerprint = issueFingerprint(issue);
      const accepted = !!delivery.digest && delivery.accepted;
      const kind = accepted ? 'CLOSURE_BLOCKED' : 'DELIVERY_ACCEPTANCE';
      const epoch = history().own(issue, value => acceptanceState(value) === 'USER_ACCEPTANCE' && issueFingerprint(value) === fingerprint && (accepted ? value.acceptedDigest === delivery.digest : value.acceptedDigest !== delivery.digest || delivery.digest === null));
      const blockers = delivery.blockers.filter(code => accepted || code !== 'HUMAN_ACCEPTANCE_REQUIRED');
      if (!delivery.digest && !blockers.length) blockers.push('EVIDENCE_DIGEST_UNAVAILABLE');
      append(issue, kind, { issueVersion: issue.version, revisionHash: delivery.digest, candidateId: issue.candidate?.id ?? null, digest: delivery.digest }, epoch, !accepted, accepted ? blockers.length ? 'inspect_closure' : 'delivery_complete' : delivery.digest ? 'delivery_decide' : 'inspect_delivery', blockers, accepted ? blockers.length ? 'BLOCKED' : 'READY_TO_COMPLETE' : blockers.length ? 'BLOCKED' : 'WAITING');
    }
    const scope = issue.parentId && (issue.state === 'ABANDONED' || issue.scopeDecisionId) ? scopeState(store, issue) : null;
    if (issue.parentId && scope && (scope.status === 'STALE' || issue.state === 'ABANDONED' && scope.status === 'INCLUDED') && history().scopePending(store, issue)) {
      const parent = store.get<Issue>('issue', issue.parentId);
      let revisionHash: string | null = null; let epoch: Epoch | null = null;
      try { revisionHash = history().scopeFingerprint(store, issue, scope); epoch = history().scope(issue, revisionHash); } catch {}
      append(issue, 'SCOPE_DECISION', { issueVersion: issue.version, revisionHash, parentId: parent.id, parentVersion: parent.version, decisionId: scope.decision?.id ?? null }, epoch, true, 'scope_decide', scope.blocking);
    }
    if (issue.state !== 'DONE' && policy.unmanaged(issue)) append(issue, 'RUN_RECONCILE', { issueVersion: issue.version, revisionHash: null, candidateId: issue.candidate?.id ?? null, fence: issue.fence }, history().own(issue, value => value.state !== 'DONE' && policy.unmanaged(value)), true, 'work_reconcile', ['UNMANAGED_EXECUTION']);
  }
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  for (const run of store.list<Run>('run', workspace.id)) {
    const issue = byId.get(run.issueId);
    if (run.state === 'UNCERTAIN' && issue) append(issue, 'RUN_RECONCILE', { issueVersion: issue.version, revisionHash: null, runId: run.id, runVersion: run.version }, history().run(run), true, 'run_reconcile', ['RUN_UNCERTAIN']);
  }
  return entries;
}

export function inboxList(store: Store, actor: Actor, query: InboxQuery, policy: InboxPolicy, now: number) {
  human(actor);
  const offset = query.offset ?? 0; const limit = query.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 || query.kind !== undefined && !inboxKinds.includes(query.kind)) throw new DomainError('INVALID_INPUT', 'Invalid inbox filters or page bounds', 400);
  const workspaces = query.workspaceId ? [store.workspace(actor, query.workspaceId)] : store.list<Workspace>('workspace');
  const all = workspaces.flatMap(workspace => collect(store, workspace, policy, now));
  const counts = (entries: InboxEntry[]) => ({ total: entries.length, blocking: entries.filter(entry => entry.blocking).length, byKind: Object.fromEntries(inboxKinds.map(kind => [kind, entries.filter(entry => entry.kind === kind).length])) });
  const filtered = all.filter(entry => query.kind === undefined || entry.kind === query.kind).sort((a, b) => Number(b.blocking) - Number(a.blocking) || Number(a.pendingSince !== null) - Number(b.pendingSince !== null) || (a.pendingSince !== null && b.pendingSince !== null ? Date.parse(a.pendingSince) - Date.parse(b.pendingSince) : 0) || a.workspaceId.localeCompare(b.workspaceId) || a.id.localeCompare(b.id));
  return { entries: filtered.slice(offset, offset + limit), total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null, summary: counts(all), workspaces: workspaces.map(workspace => ({ workspaceId: workspace.id, name: workspace.name, ...counts(all.filter(entry => entry.workspaceId === workspace.id)), settings: inboxSettings(store, actor, workspace.id) })), generatedAt: new Date(now).toISOString() };
}

export function inboxAgingGaps(store: Store, actor: Actor, workspaceId: string, policy: InboxPolicy, now: number, allowedIssueIds: ReadonlySet<string>): InboxGap[] {
  const workspace = store.workspace(actor, workspaceId);
  const threshold = workspaceSettings(store, workspace.id).agingThresholdHours;
  return collect(store, workspace, policy, now, allowedIssueIds).filter(entry => entry.pendingSince !== null && entry.ageMs !== null && entry.ageMs > threshold * 3600000).map(entry => ({ issueId: entry.issueId, key: entry.key, code: 'HUMAN_DECISION_AGING', severity: 'advisory', kind: entry.kind, targetId: entry.id, pendingSince: entry.pendingSince!, ageMs: entry.ageMs!, agingThresholdHours: threshold }));
}
