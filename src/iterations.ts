import { randomUUID } from 'node:crypto';
import { Actor, Design, DomainError, Issue, Run, State, states } from './contracts.js';
import { Store, canonical, hash } from './store.js';
import { scopeState } from './scope.js';
import { Iteration, IterationIssue, IterationMembershipEvent, IterationOperation, IterationSummary, IterationSummaryMember, LegacyAdoption, MembershipChange, MembershipPrecondition, iterationSchemas } from './iteration-contracts.js';
import type { z } from 'zod';

const terminal = new Set<State>(['DONE', 'ABANDONED']);
const planners = new Set<Actor['role']>(['human', 'lead', 'pm']);
const outcomeStates = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN']);
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
type Event = { sequence: number; actorId: string; operation: string; targetId: string | null; at: string; data: Record<string, unknown> };
type PersistMembershipIssue = (issue: IterationIssue, fromIterationId: string | null, toIterationId: string | null, reason: string) => void;

export const iterationMembershipHash = (ids: string[]) => hash(canonical([...ids].sort()));
export function legacyIterationLabel(issue: IterationIssue) {
  return issue.legacyIterationLabel ?? issue.iteration ?? null;
}
export function iterationIssueView(issue: IterationIssue) {
  const { iteration: _old, ...current } = issue;
  return { ...current, iterationId: issue.iterationId ?? null, legacyIterationLabel: legacyIterationLabel(issue) };
}
export function rejectLegacyIterationWrite(input: Record<string, unknown>) {
  if (Object.hasOwn(input, 'iteration') || Object.hasOwn(input, 'legacyIterationLabel'))
    throw new DomainError('ITERATION_FIELD_RETIRED', 'Use iterationId; legacyIterationLabel is read-only', 400);
}
function unique<T>(values: T[], key: (value: T) => string, message: string) {
  if (new Set(values.map(key)).size !== values.length) throw new DomainError('INVALID_INPUT', message, 400);
}
function version(actual: number, expected: number, target: string) {
  if (actual !== expected) throw new DomainError('VERSION_CONFLICT', `${target} changed; reload before retrying`, 409, { currentVersion: actual });
}
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError('INVALID_INPUT', 'Iteration command failed schema validation', 400, result.error.flatten());
  return result.data;
}
function day(at: string | number, timeZone: string) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new DomainError('ITERATION_HISTORY_INVALID', 'Iteration history contains an invalid timestamp');
  if (!dateFormatters.has(timeZone)) dateFormatters.set(timeZone, new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' }));
  const parts = dateFormatters.get(timeZone)!.formatToParts(date);
  const year = Number(parts.find(part => part.type === 'year')!.value);
  const signedYear = parts.find(part => part.type === 'era')?.value === 'BC' ? 1 - year : year;
  return [String(signedYear).padStart(4, '0'), ...['month', 'day'].map(kind => parts.find(part => part.type === kind)!.value)].join('-');
}
function nextDay(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export class IterationService {
  constructor(readonly store: Store, readonly now = () => Date.now()) {}

  read(actor: Actor, operation: IterationOperation, input: unknown): unknown {
    return this.store.db.transaction(() => this.readCurrent(actor, operation, input)).deferred();
  }

  private readCurrent(actor: Actor, operation: IterationOperation, input: unknown): unknown {
    if (operation === 'iteration_list') {
      const a = parse(iterationSchemas.iteration_list, input);
      this.store.workspace(actor, a.workspaceId);
      const visible = planners.has(actor.role) ? null : new Set(this.readableIssues(actor, a.workspaceId).map(issue => issue.id));
      const visibleIterations = visible ? new Set([...this.store.list<IterationIssue>('issue', a.workspaceId).filter(issue => visible.has(issue.id)).map(issue => issue.iterationId), ...this.store.list<IterationMembershipEvent>('iteration_membership', a.workspaceId).filter(event => visible.has(event.issueId)).map(event => event.iterationId)]) : null;
      const iterations = this.store.list<Iteration>('iteration', a.workspaceId)
        .filter(iteration => (!a.state || iteration.state === a.state) && (!visibleIterations || visibleIterations.has(iteration.id)));
      const result = { iterations: iterations.slice(a.offset, a.offset + a.limit).map(iteration => this.view(actor, iteration, true)), total: iterations.length, nextOffset: a.offset + a.limit < iterations.length ? a.offset + a.limit : null };
      return { ...result, ...(a.legacyLabel === undefined ? {} : { adoption: this.adoptionPreview(actor, a.workspaceId, a.legacyLabel) }) };
    }
    if (operation !== 'iteration_get') throw new DomainError('UNKNOWN_OPERATION', 'This iteration operation is not a read', 404);
    const a = parse(iterationSchemas.iteration_get, input);
    const iteration = this.get(actor, a.workspaceId, a.iterationId);
    if (!this.canRead(actor, iteration)) throw new DomainError('SCOPE_DENIED', 'Iteration has no issue in this execution read scope', 403);
    if (a.view === 'markdown') {
      this.requirePlanner(actor);
      if (!iteration.summaryId) throw new DomainError('ITERATION_OPEN', 'Close the iteration before exporting its immutable summary');
      return { iteration: this.view(actor, iteration), mediaType: 'text/markdown', content: this.markdown(iteration, this.summary(iteration)) };
    }
    if (a.view === 'flow') return { iteration: this.view(actor, iteration), ...this.flow(actor, iteration, a.flowFrom, a.flowLimit) };
    const members = this.visibleMembers(actor, iteration);
    const closedStates = iteration.state === 'CLOSED' ? new Map(this.summary(iteration).members.map(member => [member.issueId, member.state])) : null;
    return {
      iteration: this.view(actor, iteration, a.view !== 'full'), members: members.slice(a.offset, a.offset + a.limit).map(issue => this.memberView(issue, a.view === 'full', closedStates?.get(issue.id))),
      total: members.length, nextOffset: a.offset + a.limit < members.length ? a.offset + a.limit : null,
      progress: this.progress(actor, iteration, members),
      ...(a.view === 'full' && planners.has(actor.role) ? { summary: iteration.summaryId ? this.summary(iteration) : null, representedRequirements: this.represented(actor, members) } : {}),
      ...(a.legacyLabel === undefined ? {} : { adoption: this.adoptionPreview(actor, a.workspaceId, a.legacyLabel) })
    };
  }

  mutate(actor: Actor, operation: IterationOperation, input: unknown): Record<string, unknown> {
    this.requirePlanner(actor);
    return this.store.db.transaction(() => {
      if (operation === 'iteration_create') return this.create(actor, parse(iterationSchemas.iteration_create, input));
      if (operation === 'iteration_update') return this.update(actor, parse(iterationSchemas.iteration_update, input));
      if (operation === 'iteration_start') return this.start(actor, parse(iterationSchemas.iteration_start, input));
      if (operation === 'iteration_close') return this.close(actor, parse(iterationSchemas.iteration_close, input));
      if (operation === 'iteration_membership_set') {
        const a = parse(iterationSchemas.iteration_membership_set, input);
        if (a.adoption) {
          this.validateAdoption(actor, a.workspaceId, a.adoption);
        if (new Set(a.changes.map(change => change.iterationId)).size !== 1 || a.changes.some(change => change.iterationId === null)) throw new DomainError('INVALID_INPUT', 'Legacy adoption targets one iteration', 400);
        const changedIds = a.changes.map(change => change.issueId).sort();
          if (canonical(changedIds) !== canonical(a.adoption.matches.map(match => match.issueId).sort())) throw new DomainError('ITERATION_ADOPTION_STALE', 'Adoption must enumerate the complete eligible label match set');
        }
        const changed = this.changeMembership(actor, a.workspaceId, a.changes, a.memberships, a.reason);
        return { issues: changed.map(iterationIssueView), memberships: a.memberships.map(snapshot => this.precondition(this.get(actor, a.workspaceId, snapshot.iterationId))) };
      }
      throw new DomainError('UNKNOWN_OPERATION', 'This iteration operation is not a mutation', 404);
    }).immediate();
  }

  precondition(iteration: Iteration): MembershipPrecondition {
    return { iterationId: iteration.id, expectedVersion: iteration.version, membershipRevision: iteration.membershipRevision, membershipHash: iteration.membershipHash };
  }

  changeMembership(actor: Actor, workspaceId: string, changes: MembershipChange[], snapshots: MembershipPrecondition[], reason: string, persist?: PersistMembershipIssue): IterationIssue[] {
    this.requirePlanner(actor);
    this.store.workspace(actor, workspaceId);
    return this.store.db.transaction(() => {
      unique(changes, change => change.issueId, 'List each membership issue once');
      unique(snapshots, snapshot => snapshot.iterationId, 'List each iteration precondition once');
      const expected = new Map(snapshots.map(snapshot => [snapshot.iterationId, snapshot]));
      for (const snapshot of snapshots) this.checkMembership(this.get(actor, workspaceId, snapshot.iterationId), snapshot);
      const rows = changes.map(change => {
        const issue: IterationIssue = this.store.issue(actor, workspaceId, change.issueId);
        version(issue.version, change.expectedVersion, 'Issue');
        const from = issue.iterationId ?? null;
        if (from) {
          const source = this.get(actor, workspaceId, from);
          if (source.state === 'CLOSED') throw new DomainError('ITERATION_CLOSED', 'Historical membership cannot be edited');
        }
        if (change.iterationId) {
          const target = this.get(actor, workspaceId, change.iterationId);
          if (target.state === 'CLOSED') throw new DomainError('ITERATION_CLOSED', 'A closed iteration accepts no members');
          if (terminal.has(issue.state) && from !== target.id) throw new DomainError('ISSUE_CLOSED', 'Terminal issues cannot join an iteration');
        }
        return { issue, from, to: change.iterationId };
      });
      const touched = new Set(rows.filter(row => row.from !== row.to).flatMap(row => [row.from, row.to].filter((id): id is string => !!id)));
      for (const id of touched) {
        const snapshot = expected.get(id);
        if (!snapshot) throw new DomainError('ITERATION_MEMBERSHIP_REQUIRED', 'Supply every source and destination membership precondition', 409, { iterationId: id });
        this.checkMembership(this.get(actor, workspaceId, id), snapshot);
      }
      const transactionId = randomUUID();
      const changed: IterationIssue[] = [];
      for (const row of rows) {
        if (row.from === row.to) continue;
        const issue = { ...row.issue, iterationId: row.to };
        if (persist) persist(issue, row.from, row.to, reason);
        else {
          issue.version++;
          this.store.put('issue', issue, workspaceId);
          this.store.event(workspaceId, actor, 'iteration_membership_changed', issue.id, { version: issue.version, state: issue.state, stage: issue.stage, metadataOnly: true, fromIterationId: row.from, toIterationId: row.to, reason });
        }
        const saved = this.store.get<IterationIssue>('issue', issue.id);
        if (saved.version !== row.issue.version + 1 || (saved.iterationId ?? null) !== row.to) throw new DomainError('ITERATION_WRITE_INVALID', 'Membership persistence must save one guarded issue version');
        if (row.from) this.membershipEvent(actor, saved, row.from, 'REMOVE', row.from, row.to, transactionId);
        if (row.to) this.membershipEvent(actor, saved, row.to, 'ADD', row.from, row.to, transactionId);
        changed.push(saved);
      }
      for (const id of touched) {
        const iteration = this.get(actor, workspaceId, id);
        iteration.version++;
        iteration.membershipRevision++;
        iteration.membershipHash = iterationMembershipHash(this.members(iteration).map(issue => issue.id));
        iteration.updatedAt = this.timestamp();
        this.store.put('iteration', iteration, workspaceId);
        this.store.event(workspaceId, actor, 'iteration_membership_updated', iteration.id, { version: iteration.version, membershipRevision: iteration.membershipRevision, membershipHash: iteration.membershipHash, reason });
      }
      return changed;
    }).immediate();
  }

  adoptionPreview(actor: Actor, workspaceId: string, label: string) {
    this.requirePlanner(actor);
    this.store.workspace(actor, workspaceId);
    const matches = this.store.list<IterationIssue>('issue', workspaceId).filter(issue => !terminal.has(issue.state) && legacyIterationLabel(issue) === label)
      .map(issue => ({ issueId: issue.id, expectedVersion: issue.version })).sort((a, b) => a.issueId.localeCompare(b.issueId));
    return { label, matches, matchHash: hash(canonical({ workspaceId, label, matches })) };
  }

  packet(actor: Actor, issue: IterationIssue) {
    const current: IterationIssue = this.store.issue(actor, issue.workspaceId, issue.id);
    if (!current.iterationId) return null;
    const iteration = this.get(actor, current.workspaceId, current.iterationId);
    if (iteration.state === 'CLOSED') return null;
    const characters = Array.from(iteration.goal);
    return { id: iteration.id, name: iteration.name, endDate: iteration.endDate, goal: characters.slice(0, 200).join('') + (characters.length > 200 ? '…' : ''), advisory: true };
  }

  gaps(actor: Actor, workspaceId: string) {
    this.store.workspace(actor, workspaceId);
    if (!planners.has(actor.role)) return [];
    return this.store.list<Iteration>('iteration', workspaceId).filter(iteration => iteration.state === 'ACTIVE' && day(this.now(), iteration.timeZone) > iteration.endDate)
      .map(iteration => ({ iterationId: iteration.id, code: 'ITERATION_OVERDUE', severity: 'advisory', dueDate: iteration.endDate, timeZone: iteration.timeZone, url: this.url(iteration), nextAction: 'Review unfinished membership and explicitly close or update the iteration' }));
  }

  private requirePlanner(actor: Actor) {
    if (!planners.has(actor.role)) throw new DomainError('ROLE_DENIED', 'Iteration planning requires human, lead or PM authority', 403);
  }
  private timestamp() { return new Date(this.now()).toISOString(); }
  private url(iteration: Iteration) { return `/w/${iteration.workspaceId}/iterations/${iteration.id}`; }
  private get(actor: Actor, workspaceId: string, id: string) {
    this.store.workspace(actor, workspaceId);
    const iteration = this.store.get<Iteration>('iteration', id);
    if (iteration.workspaceId !== workspaceId) throw new DomainError('SCOPE_DENIED', 'Iteration belongs to another workspace', 403);
    return iteration;
  }
  private members(iteration: Iteration) {
    const members = this.store.list<IterationIssue>('issue', iteration.workspaceId).filter(issue => issue.iterationId === iteration.id).sort((a, b) => a.id.localeCompare(b.id));
    if (members.some(issue => issue.workspaceId !== iteration.workspaceId)) throw new DomainError('SCOPE_DENIED', 'Iteration member belongs to another workspace', 403);
    return members;
  }
  private visible(actor: Actor, issue: Issue) {
    try { this.store.issue(actor, issue.workspaceId, issue.id); return true; }
    catch (error) { if (error instanceof DomainError && error.code === 'SCOPE_DENIED') return false; throw error; }
  }
  private visibleMembers(actor: Actor, iteration: Iteration) {
    const members = iteration.state === 'CLOSED' ? this.summary(iteration).members.map(member => this.store.get<IterationIssue>('issue', member.issueId)) : this.members(iteration);
    for (const issue of members) if (issue.workspaceId !== iteration.workspaceId) throw new DomainError('SCOPE_DENIED', 'Iteration member belongs to another workspace', 403);
    const allowed = new Set(this.readableIssues(actor, iteration.workspaceId).map(issue => issue.id));
    return members.filter(issue => allowed.has(issue.id));
  }
  private readableIssues(actor: Actor, workspaceId: string): IterationIssue[] {
    const all = this.store.list<IterationIssue>('issue', workspaceId);
    if (planners.has(actor.role)) return all;
    const principal = actor.principalId ?? actor.id;
    const direct = all.filter(issue => (actor.role === 'worker' ? issue.assignee : issue.qaAssignee) === principal);
    const candidates = new Set([...direct.map(issue => issue.id), ...direct.map(issue => issue.parentId)]);
    return all.filter(issue => candidates.has(issue.id) && this.visible(actor, issue));
  }
  private canRead(actor: Actor, iteration: Iteration) {
    if (planners.has(actor.role)) return true;
    const allowed = new Set(this.readableIssues(actor, iteration.workspaceId).map(issue => issue.id));
    return this.members(iteration).some(issue => allowed.has(issue.id)) || this.history(iteration).some(event => allowed.has(event.issueId));
  }
  private view(actor: Actor, iteration: Iteration, compact = false) {
    const goal = compact ? Array.from(iteration.goal).slice(0, 200).join('') : iteration.goal;
    if (planners.has(actor.role)) return { ...iteration, goal, goalTruncated: goal !== iteration.goal, url: this.url(iteration) };
    return { id: iteration.id, workspaceId: iteration.workspaceId, name: iteration.name, goal, goalTruncated: goal !== iteration.goal, startDate: iteration.startDate, endDate: iteration.endDate, timeZone: iteration.timeZone, state: iteration.state, url: this.url(iteration), partial: true };
  }
  private memberView(issue: IterationIssue, full: boolean, stateAtClose?: State) {
    const parent = issue.parentId ? this.store.get<Issue>('issue', issue.parentId) : null;
    const title = parent ? `${parent.title}——${issue.title}` : issue.title;
    const excerpt = full ? title : Array.from(title).slice(0, 120).join('');
    return { id: issue.id, key: issue.key, title: excerpt, titleTruncated: excerpt !== title, parentId: issue.parentId, state: issue.state, version: issue.version, iterationId: issue.iterationId ?? null, legacyIterationLabel: legacyIterationLabel(issue), ...(stateAtClose ? { stateAtClose, historicalMembership: true } : {}), ...(full ? { priority: issue.priority, plannedStart: issue.plannedStart, dueDate: issue.dueDate, estimate: issue.estimate ?? null, assignee: issue.assignee, harness: issue.harness } : {}), url: `/w/${issue.workspaceId}/issues/${issue.id}` };
  }
  private checkMembership(iteration: Iteration, expected: MembershipPrecondition) {
    version(iteration.version, expected.expectedVersion, 'Iteration');
    const actualHash = iterationMembershipHash(this.members(iteration).map(issue => issue.id));
    if (iteration.membershipHash !== actualHash) throw new DomainError('ITERATION_MEMBERSHIP_INCONSISTENT', 'Recorded iteration membership does not match its current issue set');
    if (iteration.membershipRevision !== expected.membershipRevision || actualHash !== expected.membershipHash) throw new DomainError('ITERATION_MEMBERSHIP_STALE', 'Iteration membership changed; reload the complete set');
  }
  private validateDates(start: string, end: string) {
    if (start > end) throw new DomainError('ITERATION_DATES_INVALID', 'Iteration end date cannot precede its start date', 400);
  }
  private create(actor: Actor, a: z.infer<typeof iterationSchemas.iteration_create>) {
    this.store.workspace(actor, a.workspaceId);
    this.validateDates(a.startDate, a.endDate);
    if (a.adoption) this.validateAdoption(actor, a.workspaceId, a.adoption);
    const iteration: Iteration = { id: randomUUID(), workspaceId: a.workspaceId, name: a.name, goal: a.goal, startDate: a.startDate, endDate: a.endDate, timeZone: a.timeZone, state: 'PLANNED', version: 1, membershipRevision: 0, membershipHash: iterationMembershipHash([]), createdAt: this.timestamp(), createdBy: actor.id, updatedAt: this.timestamp() };
    this.store.put('iteration', iteration, a.workspaceId);
    this.store.event(a.workspaceId, actor, 'iteration_created', iteration.id, { version: iteration.version, reason: a.reason });
    if (a.adoption) {
      const changes = a.adoption.matches.map(match => ({ ...match, iterationId: iteration.id }));
      this.changeMembership(actor, a.workspaceId, changes, [...a.adoption.memberships, this.precondition(iteration)], a.reason);
    }
    return { iteration: this.view(actor, this.get(actor, a.workspaceId, iteration.id)) };
  }
  private update(actor: Actor, a: z.infer<typeof iterationSchemas.iteration_update>) {
    const iteration = this.get(actor, a.workspaceId, a.iterationId);
    version(iteration.version, a.expectedVersion, 'Iteration');
    if (iteration.state === 'CLOSED') throw new DomainError('ITERATION_CLOSED', 'Closed iterations and their summaries are immutable');
    this.validateDates(a.startDate ?? iteration.startDate, a.endDate ?? iteration.endDate);
    for (const key of ['name', 'goal', 'startDate', 'endDate'] as const) if (a[key] !== undefined) iteration[key] = a[key];
    iteration.version++;
    iteration.updatedAt = this.timestamp();
    this.store.put('iteration', iteration, iteration.workspaceId);
    this.store.event(iteration.workspaceId, actor, 'iteration_updated', iteration.id, { version: iteration.version, reason: a.reason });
    return { iteration: this.view(actor, iteration) };
  }
  private start(actor: Actor, a: z.infer<typeof iterationSchemas.iteration_start>) {
    const iteration = this.get(actor, a.workspaceId, a.iterationId);
    version(iteration.version, a.expectedVersion, 'Iteration');
    if (iteration.state !== 'PLANNED') throw new DomainError('INVALID_TRANSITION', 'Only a planned iteration can start');
    if (this.store.list<Iteration>('iteration', a.workspaceId).some(other => other.state === 'ACTIVE')) throw new DomainError('ITERATION_ACTIVE_EXISTS', 'This workspace already has an active iteration');
    iteration.state = 'ACTIVE';
    iteration.startedAt = this.timestamp();
    iteration.updatedAt = iteration.startedAt;
    iteration.version++;
    this.store.put('iteration', iteration, iteration.workspaceId);
    this.store.event(iteration.workspaceId, actor, 'iteration_started', iteration.id, { version: iteration.version, reason: a.reason });
    return { iteration: this.view(actor, iteration) };
  }
  private validateAdoption(actor: Actor, workspaceId: string, adoption: Omit<LegacyAdoption, 'memberships'>) {
    unique(adoption.matches, match => match.issueId, 'List each legacy match once');
    const preview = this.adoptionPreview(actor, workspaceId, adoption.label);
    const supplied = [...adoption.matches].sort((a, b) => a.issueId.localeCompare(b.issueId));
    if (preview.matchHash !== adoption.matchHash || canonical(preview.matches) !== canonical(supplied)) throw new DomainError('ITERATION_ADOPTION_STALE', 'Legacy matches changed; review the complete eligible set');
  }
  private membershipEvent(actor: Actor, issue: IterationIssue, iterationId: string, kind: 'ADD' | 'REMOVE', fromIterationId: string | null, toIterationId: string | null, transactionId: string) {
    const root = issue.parentId ? this.store.get<Issue>('issue', issue.parentId) : issue;
    const designStatus = root.designId ? this.store.get<Design>('design', root.designId).status : null;
    const record: IterationMembershipEvent = { id: randomUUID(), workspaceId: issue.workspaceId, iterationId, issueId: issue.id, kind, at: this.timestamp(), sequence: 0, actorId: actor.id, transactionId, issueVersion: issue.version, fromIterationId, toIterationId, state: issue.state, parentId: issue.parentId, designStatus };
    this.store.put('iteration_membership', record, issue.workspaceId);
    this.store.event(issue.workspaceId, actor, kind === 'ADD' ? 'iteration_member_added' : 'iteration_member_removed', record.id, { issueId: issue.id, iterationId, version: issue.version, transactionId, fromIterationId, toIterationId, metadataOnly: true });
    const event = this.store.db.prepare('SELECT sequence,at FROM events WHERE sequence=last_insert_rowid()').get() as { sequence: number; at: string };
    record.sequence = event.sequence;
    record.at = event.at;
    this.store.put('iteration_membership', record, issue.workspaceId);
  }
  private close(actor: Actor, a: z.infer<typeof iterationSchemas.iteration_close>) {
    const iteration = this.get(actor, a.workspaceId, a.iterationId);
    version(iteration.version, a.expectedVersion, 'Iteration');
    if (iteration.state === 'CLOSED') throw new DomainError('ITERATION_CLOSED', 'Iteration is already closed');
    this.checkMembership(iteration, { iterationId: iteration.id, expectedVersion: a.expectedVersion, membershipRevision: a.membershipRevision, membershipHash: a.membershipHash });
    unique(a.members, member => member.issueId, 'List every current member once');
    unique(a.dispositions, disposition => disposition.issueId, 'List every unfinished disposition once');
    const members = this.members(iteration);
    if (canonical(members.map(issue => issue.id).sort()) !== canonical(a.members.map(member => member.issueId).sort())) throw new DomainError('ITERATION_MEMBERSHIP_STALE', 'Close must bind the complete member set');
    for (const issue of members) version(issue.version, a.members.find(member => member.issueId === issue.id)!.expectedVersion, 'Iteration member');
    const unfinished = members.filter(issue => !terminal.has(issue.state));
    if (canonical(unfinished.map(issue => issue.id).sort()) !== canonical(a.dispositions.map(disposition => disposition.issueId).sort())) throw new DomainError('ITERATION_DISPOSITION_REQUIRED', 'Every unfinished member needs exactly one explicit carry-over or backlog disposition');
    const destinations = new Map(a.dispositions.map(disposition => [disposition.issueId, disposition.iterationId]));
    for (const targetId of new Set([...destinations.values()].filter((id): id is string => !!id))) {
      if (targetId === iteration.id) throw new DomainError('ITERATION_CARRY_OVER_INVALID', 'Carry-over must target another planned iteration');
      if (this.get(actor, a.workspaceId, targetId).state !== 'PLANNED') throw new DomainError('ITERATION_CARRY_OVER_INVALID', 'Carry-over destinations must be planned iterations');
    }
    const summary = this.buildSummary(actor, iteration, members, destinations);
    const moves = members.map(issue => ({ issueId: issue.id, expectedVersion: issue.version, iterationId: destinations.get(issue.id) ?? null }));
    this.changeMembership(actor, a.workspaceId, moves, [this.precondition(iteration), ...a.destinations], a.reason);
    const closed = this.get(actor, a.workspaceId, iteration.id);
    closed.state = 'CLOSED';
    closed.closedAt = summary.closedAt;
    closed.updatedAt = summary.closedAt;
    closed.version++;
    closed.summaryId = summary.id;
    summary.iterationVersion = closed.version;
    this.store.put('iteration_summary', summary, a.workspaceId);
    this.store.put('iteration', closed, a.workspaceId);
    this.store.event(a.workspaceId, actor, 'iteration_closed', closed.id, { version: closed.version, summaryId: summary.id, reason: a.reason });
    return { iteration: this.view(actor, closed), summary };
  }

  private summary(iteration: Iteration) {
    if (!iteration.summaryId) throw new DomainError('ITERATION_SUMMARY_REQUIRED', 'Closed iteration summary is unavailable');
    const summary = this.store.get<IterationSummary>('iteration_summary', iteration.summaryId);
    if (summary.iterationId !== iteration.id || summary.workspaceId !== iteration.workspaceId) throw new DomainError('SCOPE_DENIED', 'Iteration summary belongs to another target', 403);
    return summary;
  }
  private events(workspaceId: string): Event[] {
    return (this.store.db.prepare('SELECT sequence,actor_id AS actorId,operation,target_id AS targetId,data,at FROM events WHERE workspace_id=? ORDER BY sequence').all(workspaceId) as { sequence: number; actorId: string; operation: string; targetId: string | null; data: string; at: string }[]).map(event => ({ ...event, data: JSON.parse(event.data) as Record<string, unknown> }));
  }
  private history(iteration: Iteration) { return this.store.list<IterationMembershipEvent>('iteration_membership', iteration.workspaceId).filter(event => event.iterationId === iteration.id).sort((a, b) => a.sequence - b.sequence); }
  private memberAt(history: IterationMembershipEvent[], issueId: string, sequence: number) { return history.filter(event => event.issueId === issueId && event.sequence <= sequence).at(-1)?.kind === 'ADD'; }
  private buildSummary(actor: Actor, iteration: Iteration, issues: IterationIssue[], destinations: Map<string, string | null>): IterationSummary {
    const history = this.history(iteration);
    const events = this.events(iteration.workspaceId);
    const members: IterationSummaryMember[] = issues.map(issue => ({ issueId: issue.id, key: issue.key, state: issue.state, disposition: issue.state === 'DONE' ? 'DONE' : issue.state === 'ABANDONED' ? 'ABANDONED' : destinations.get(issue.id) ? 'CARRIED' : 'BACKLOG', targetIterationId: destinations.get(issue.id) ?? null, excluded: !!issue.parentId && scopeState(this.store, issue).status === 'EXCLUDED' }));
    const memberIds = new Set(members.map(member => member.issueId));
    const byState = Object.fromEntries(states.map(state => [state, members.filter(member => member.state === state).length])) as Record<State, number>;
    const humanDecisions = events.filter(event => !!event.targetId && memberIds.has(event.targetId) && ['design_decide', 'delivery_decide', 'scope_decide', 'grant_create', 'grant_revoke', 'defect_triage', 'defect_waive', 'decision_batch_accept'].includes(event.operation) && this.memberAt(history, event.targetId, event.sequence) && this.store.get<Actor>('actor', event.actorId).role === 'human')
      .map(event => ({ sequence: event.sequence, issueId: event.targetId!, operation: event.operation, actorId: event.actorId, at: event.at }));
    const runs = this.store.list<Run>('run', iteration.workspaceId).filter(run => memberIds.has(run.issueId)).flatMap(run => {
      const eventState = (event: Event) => event.operation === 'run_uncertain' ? 'UNCERTAIN' : event.operation === 'run_starting' ? 'STARTING' : typeof event.data.state === 'string' ? event.data.state : null;
      const event = events.filter(event => event.targetId === run.id && this.memberAt(history, run.issueId, event.sequence) && eventState(event) !== null).at(-1);
      if (!event) return [];
      const state = eventState(event)!;
      return [{ runId: run.id, issueId: run.issueId, state, sequence: event.sequence }];
    });
    return { id: randomUUID(), workspaceId: iteration.workspaceId, iterationId: iteration.id, iterationVersion: 0, closedAt: this.timestamp(), actorId: actor.id, membershipRevision: iteration.membershipRevision, membershipHash: iteration.membershipHash, members,
      counts: { done: members.filter(member => member.disposition === 'DONE').length, abandoned: members.filter(member => member.disposition === 'ABANDONED').length, excluded: members.filter(member => member.excluded).length, carried: members.filter(member => member.disposition === 'CARRIED').length, returned: members.filter(member => member.disposition === 'BACKLOG').length, byState },
      openDefects: this.store.list<{ id: string; issueId: string; state: string; severity: string }>('defect', iteration.workspaceId).filter(defect => memberIds.has(defect.issueId) && defect.state === 'OPEN').map(defect => ({ defectId: defect.id, issueId: defect.issueId, severity: defect.severity })), humanDecisions, runs };
  }
  private represented(actor: Actor, members: IterationIssue[]) {
    return [...new Set(members.map(issue => issue.parentId).filter((id): id is string => !!id))].filter(id => !members.some(issue => issue.id === id)).map(id => this.store.issue(actor, members[0]!.workspaceId, id)).map(issue => ({ issueId: issue.id, key: issue.key, title: issue.title, derived: true }));
  }
  private progress(actor: Actor, iteration: Iteration, members: IterationIssue[]) {
    const roots = [...new Set(members.map(issue => issue.parentId ?? issue.id))].map(id => this.store.issue(actor, iteration.workspaceId, id));
    const unapproved = roots.filter(root => !root.designId || this.store.get<Design>('design', root.designId).status !== 'APPROVED');
    const estimates = { hours: 0, points: 0 };
    for (const issue of members) if (issue.estimate) estimates[issue.estimate.unit] += issue.estimate.value;
    const runVisible = (run: Run) => planners.has(actor.role) || run.actorId === (actor.principalId ?? actor.id) && (!actor.runId || run.id === actor.runId);
    const isActive = (run: Run) => ['STARTING', 'RUNNING', 'STOPPING', 'UNCERTAIN'].includes(run.state);
    const workspaceRuns = this.store.list<Run>('run', iteration.workspaceId);
    const activeRuns = workspaceRuns.filter(run => runVisible(run) && members.some(issue => issue.id === run.issueId) && isActive(run)).length;
    const configuredLimit = Number(process.env.AGILEDEV_CONCURRENCY ?? 2);
    const sharedRunLimit = Number.isInteger(configuredLimit) && configuredLimit >= 1 && configuredLimit <= 4 ? configuredLimit : null;
    const historical = iteration.state === 'CLOSED';
    const historicalMembers = historical ? new Map(this.summary(iteration).members.map(member => [member.issueId, member.state])) : null;
    return { partial: !planners.has(actor.role), counts: Object.fromEntries(states.map(state => [state, members.filter(issue => (historicalMembers?.get(issue.id) ?? issue.state) === state).length])), estimates: historical ? null : estimates, activeRuns: historical ? 0 : activeRuns, runCapacity: { scope: 'installation', limit: sharedRunLimit, source: 'AGILEDEV_CONCURRENCY/default', workspaceActiveRuns: planners.has(actor.role) ? workspaceRuns.filter(isActive).length : null, memberActiveRuns: historical ? 0 : activeRuns, ...(actor.role === 'human' ? { installationActiveRuns: this.store.list<Run>('run').filter(isActive).length } : {}), advisory: true }, unstartedTasks: historical ? 0 : members.filter(issue => !!issue.parentId && issue.state === 'NOT_STARTED').length, humanDecisionsLowerBound: historical ? 0 : members.filter(issue => !terminal.has(issue.state)).length + unapproved.length, overdue: iteration.state === 'ACTIVE' && day(this.now(), iteration.timeZone) > iteration.endDate, historical, advisory: true };
  }
  private flow(actor: Actor, iteration: Iteration, from: string | undefined, limit: number) {
    const start = from ?? iteration.startDate;
    if (start < iteration.startDate) throw new DomainError('INVALID_INPUT', 'Flow cannot start before the iteration start date', 400);
    const last = [iteration.endDate, day(this.now(), iteration.timeZone)].sort()[0]!;
    const history = this.history(iteration).filter(event => this.visible(actor, this.store.get<Issue>('issue', event.issueId)));
    const issueIds = new Set(history.map(event => event.issueId));
    const rootIds = new Set(history.map(event => event.parentId ?? event.issueId));
    const runs = new Map(this.store.list<Run>('run', iteration.workspaceId).filter(run => run.workspaceId === iteration.workspaceId && issueIds.has(run.issueId)).map(run => [run.id, run]));
    const events = this.events(iteration.workspaceId).flatMap(event => {
      if (!event.targetId) return [];
      if (event.operation === 'run_finished') {
        const run = runs.get(event.targetId);
        const state = event.data.issueState;
        if (!run || event.actorId !== run.executionActorId || typeof state !== 'string' || !(states as readonly string[]).includes(state)) return [];
        return [{ ...event, targetId: run.issueId, data: { ...event.data, state } }];
      }
      return issueIds.has(event.targetId) || rootIds.has(event.targetId) ? [event] : [];
    });
    const timeline = [...history.map(membership => ({ at: membership.at, sequence: membership.sequence, membership })), ...events.map(event => ({ at: event.at, sequence: event.sequence, event }))].sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence);
    const live = new Map<string, { state: State; rootId: string }>();
    const designs = new Map<string, string | null>();
    const points: { date: string; counts: Record<State, number>; waitingOnHuman: number }[] = [];
    let cursor = 0;
    for (let current = start; current <= last && points.length < limit; current = nextDay(current)) {
      while (cursor < timeline.length && day(timeline[cursor]!.at, iteration.timeZone) <= current) {
        const event = timeline[cursor++]!;
        if ('membership' in event) {
          const membership = event.membership;
          if (membership.kind === 'ADD') {
            const rootId = membership.parentId ?? membership.issueId;
            live.set(membership.issueId, { state: membership.state, rootId });
            designs.set(rootId, membership.designStatus);
          } else live.delete(membership.issueId);
        } else {
          const change = event.event;
          if (typeof change.data.state === 'string' && (states as readonly string[]).includes(change.data.state) && live.has(change.targetId!)) live.get(change.targetId!)!.state = change.data.state as State;
          if (change.operation === 'design_set') designs.set(change.targetId!, 'DRAFT');
          if (['design_submit', 'design_decide'].includes(change.operation) && typeof change.data.decision === 'string') designs.set(change.targetId!, change.data.decision);
        }
      }
      points.push({ date: current, counts: Object.fromEntries(states.map(state => [state, [...live.values()].filter(issue => issue.state === state).length])) as Record<State, number>, waitingOnHuman: [...live.values()].filter(issue => issue.state === 'USER_ACCEPTANCE' || designs.get(issue.rootId) === 'IN_REVIEW').length });
    }
    const after = points.at(-1)?.date;
    return { points, nextDate: after && after < last ? nextDay(after) : null, timeZone: iteration.timeZone, partial: !planners.has(actor.role), advisory: true };
  }
  private markdown(iteration: Iteration, summary: IterationSummary) {
    const safe = (value: string) => value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
    const lines = [`# ${safe(iteration.name)}`, '', `Iteration: ${iteration.id}`, `Dates: ${iteration.startDate} to ${iteration.endDate} (${iteration.timeZone})`, `Closed: ${summary.closedAt}`, '', '## Goal', '', iteration.goal, '', '## Membership', '', '| Issue | State at close | Disposition | Target iteration |', '| --- | --- | --- | --- |', ...summary.members.map(member => `| ${safe(member.key)} | ${member.state} | ${member.disposition} | ${member.targetIterationId ?? 'Backlog'} |`), '', '## Recorded counts', '', `Done: ${summary.counts.done}; abandoned: ${summary.counts.abandoned}; excluded: ${summary.counts.excluded}; carried: ${summary.counts.carried}; returned: ${summary.counts.returned}.`, '', `Open defects: ${summary.openDefects.length}. Human decisions: ${summary.humanDecisions.length}.`, '', ...[...outcomeStates].map(state => `${state}: ${summary.runs.filter(run => run.state === state).length}`), ''];
    return lines.join('\n');
  }
}
