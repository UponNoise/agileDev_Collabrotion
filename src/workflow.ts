import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Actor, Design, DomainError, Issue, Operation, Workspace, schemas } from './contracts.js';
import { canonical, hash, Store } from './store.js';

const readOps = new Set(['workspace_list', 'connection_list', 'issue_get', 'issue_list', 'run_get', 'run_list', 'gap_list', 'event_list']);
function requireRole(actor: Actor, ...allowed: Actor['role'][]) {
  if (!allowed.includes(actor.role)) throw new DomainError('ROLE_DENIED', `Operation requires ${allowed.join(' or ')} authority`, 403);
}
function version(issue: Issue, expected: number) {
  if (issue.version !== expected) throw new DomainError('VERSION_CONFLICT', 'Issue changed; reload before retrying', 409, { currentVersion: issue.version });
}
export function inside(root: string, path: string): string {
  const resolved = realpathSync(resolve(root, path));
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new DomainError('PATH_DENIED', 'Path escapes the workspace', 403);
  return resolved;
}
export class Workflow {
  constructor(readonly store: Store, readonly now = () => Date.now()) {}
  execute(actor: Actor, operation: string, input: unknown): unknown {
    if (!(operation in schemas)) throw new DomainError('UNKNOWN_OPERATION', 'Unknown operation', 404);
    const op = operation as Operation;
    const parsed = schemas[op].safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Command failed schema validation', 400, parsed.error.flatten());
    const args = parsed.data as Record<string, any>;
    if (readOps.has(op)) return this.read(actor, op, args);
    const digest = hash(canonical({ op, args }));
    return this.store.db.transaction(() => {
      const existing = this.store.db.prepare('SELECT digest,result FROM receipts WHERE actor_id=? AND key=?').get(actor.id, args.idempotencyKey) as { digest: string; result: string } | undefined;
      if (existing) {
        if (existing.digest !== digest) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Key was already used with different input');
        return { ...JSON.parse(existing.result), replayed: true };
      }
      const result = this.mutate(actor, op, args);
      const receipt = { ...result };
      delete receipt.token;
      this.store.db.prepare('INSERT INTO receipts(actor_id,key,digest,result) VALUES(?,?,?,?)').run(actor.id, args.idempotencyKey, digest, JSON.stringify(receipt));
      return result;
    }).immediate();
  }
  private read(actor: Actor, op: Operation, a: Record<string, any>): unknown {
    const s = this.store;
    if (op === 'workspace_list') return { workspaces: s.list<Workspace>('workspace').filter(w => actor.role === 'human' || actor.workspaceIds.includes(w.id)) };
    s.workspace(actor, a.workspaceId);
    if (op === 'connection_list') {
      requireRole(actor, 'human', 'lead', 'pm');
      return { connections: s.list('connection', a.workspaceId) };
    }
    const issues = s.list<Issue>('issue', a.workspaceId).filter(i => actor.role !== 'worker' || i.assignee === actor.id);
    if (op === 'issue_get') {
      const issue = s.issue(actor, a.workspaceId, a.issueId);
      return { issue: this.display(issue), readiness: this.readiness(issue), nextActions: this.nextActions(actor, issue) };
    }
    if (op === 'issue_list') {
      const filtered = issues.filter(i => !a.state || i.state === a.state);
      return { issues: filtered.slice(a.offset, a.offset + a.limit).map(i => this.display(i)), total: filtered.length, nextOffset: a.offset + a.limit < filtered.length ? a.offset + a.limit : null };
    }
    if (op === 'gap_list') return { gaps: issues.flatMap(i => this.readiness(i).blocking.map(code => ({ issueId: i.id, key: i.key, code, severity: 'blocking' })).concat(i.plannedStart ? [] : [{ issueId: i.id, key: i.key, code: 'SCHEDULE_UNSET', severity: 'advisory' }] )) };
    if (op === 'event_list') {
      requireRole(actor, 'human', 'lead', 'pm');
      return { events: s.db.prepare('SELECT sequence,actor_id AS actorId,operation,target_id AS targetId,data,at FROM events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(a.workspaceId, a.after, a.limit).map((r: any) => ({ ...r, data: JSON.parse(r.data) })) };
    }
    const runs = s.list<any>('run', a.workspaceId).filter(r => actor.role !== 'worker' || r.actorId === actor.id);
    if (op === 'run_list') return { runs: runs.slice(-a.limit).reverse() };
    const run = runs.find(r => r.id === a.runId);
    if (!run) throw new DomainError('NOT_FOUND', 'Run not found', 404);
    return { run };
  }
  private display(issue: Issue) {
    const title = issue.parentId ? `${this.store.get<Issue>('issue', issue.parentId).title}——${issue.title}` : issue.title;
    return { ...issue, title, url: `/w/${issue.workspaceId}/issues/${issue.id}` };
  }
  private nextActions(actor: Actor, i: Issue): string[] {
    if (i.state === 'NOT_STARTED' && actor.role === 'worker' && !this.readiness(i).blocking.length) return ['work_claim'];
    if (i.state === 'IN_PROGRESS' && i.lease?.actorId === actor.id) return ['work_heartbeat', 'work_submit'];
    if (i.state === 'LEAD_REVIEW' && actor.role === 'lead') return ['review_submit'];
    if (i.state === 'QA_TEST' && actor.role === 'qa') return ['review_submit'];
    return [];
  }
  design(issue: Issue): Design | null {
    const root = issue.parentId ? this.store.get<Issue>('issue', issue.parentId) : issue;
    return root.designId ? this.store.get<Design>('design', root.designId) : null;
  }
  readiness(i: Issue) {
    const blocking: string[] = [];
    if (this.design(i)?.status !== 'APPROVED') blocking.push('DESIGN_APPROVAL_REQUIRED');
    if (!i.assignee) blocking.push('ASSIGNEE_REQUIRED');
    if (!i.criteria.length) blocking.push('CRITERIA_REQUIRED');
    if (!i.description.trim()) blocking.push('SCOPE_REQUIRED');
    if (i.state === 'ON_HOLD' || (i.parentId && this.store.get<Issue>('issue', i.parentId).state === 'ON_HOLD')) blocking.push('ON_HOLD');
    if (i.dependencies.some(id => this.store.get<Issue>('issue', id).state !== 'DONE')) blocking.push('DEPENDENCY_BLOCKED');
    if (this.store.list<Issue>('issue', i.workspaceId).some(child => child.parentId === i.id && child.state !== 'DONE')) blocking.push('CHILDREN_INCOMPLETE');
    const d = this.design(i);
    if (d && i.criteria.some(c => !d.criteria.includes(c))) blocking.push('CRITERIA_UNMAPPED');
    return { ready: blocking.length === 0, blocking };
  }
  private save(actor: Actor, op: string, i: Issue, data: unknown = {}) {
    const before = this.store.get<Issue>('issue', i.id);
    i.version++;
    this.store.put('issue', i, i.workspaceId);
    const changes = Object.fromEntries(Object.entries(i).filter(([key, value]) => canonical(value) !== canonical((before as any)[key])).map(([key, value]) => [key, { before: (before as any)[key], after: value }]));
    this.store.event(i.workspaceId, actor, op, i.id, { version: i.version, state: i.state, stage: i.stage, changes, ...data as object });
    return { issue: this.display(i) };
  }
  private invalidate(i: Issue) {
    i.candidate = null; i.initialReview = null; i.qaReview = null; i.finalReview = null; i.lease = null; i.stage = null;
    if (!['NOT_STARTED', 'ABANDONED'].includes(i.state)) i.state = 'NOT_STARTED';
  }
  private mutate(actor: Actor, op: Operation, a: Record<string, any>): Record<string, unknown> {
    const s = this.store;
    if (op === 'workspace_register') {
      requireRole(actor, 'human');
      if (!isAbsolute(a.root) || !existsSync(a.root) || !statSync(a.root).isDirectory()) throw new DomainError('WORKSPACE_UNRESOLVED', 'Select an existing absolute directory');
      const root = realpathSync(a.root);
      const existing = s.list<Workspace>('workspace').find(w => w.root === root);
      if (existing) return { workspace: existing };
      let commonDir = null;
      try { commonDir = realpathSync(resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim())); } catch {}
      const w: Workspace = { id: randomUUID(), name: a.name, prefix: a.prefix, root, commonDir, sequence: 0 };
      s.put('workspace', w, w.id); s.event(w.id, actor, op, w.id, { name: w.name });
      return { workspace: w };
    }
    const w = s.workspace(actor, a.workspaceId);
    if (op === 'actor_enroll') {
      requireRole(actor, 'human');
      const enrolled: Actor = { id: randomUUID(), role: a.role, name: a.name, workspaceIds: [w.id], sessionId: randomUUID() };
      const token = s.token(enrolled);
      s.event(w.id, actor, op, enrolled.id, { role: a.role, name: a.name });
      return { actor: enrolled, token };
    }
    if (op === 'issue_create') {
      requireRole(actor, 'human', 'lead', 'pm');
      if (a.parentId) {
        const parent = s.issue(actor, w.id, a.parentId);
        version(parent, a.expectedParentVersion);
        if (parent.parentId) throw new DomainError('HIERARCHY_LIMIT', 'Tasks cannot contain child tasks');
        if (['DONE', 'ABANDONED'].includes(parent.state)) throw new DomainError('PARENT_CLOSED', 'Reopen the parent before adding scope');
        if (!/^\[(Feature|Fix|Refactor|Test|Docs|Research)\] [^:]+: .+ -> .+$/.test(a.title)) throw new DomainError('TITLE_FORMAT', 'Use [Type] Area: action -> outcome for the child suffix');
        const wasActive = parent.state !== 'NOT_STARTED';
        this.invalidate(parent); if (wasActive) parent.state = 'IN_PROGRESS';
        this.save(actor, 'scope_child_added', parent);
      }
      w.sequence++; s.put('workspace', w, w.id);
      const i: Issue = { id: randomUUID(), workspaceId: w.id, key: `${w.prefix}-${String(w.sequence).padStart(4, '0')}`, parentId: a.parentId ?? null, title: a.title, description: a.description, criteria: [...new Set<string>(a.criteria)], version: 1, scopeRevision: 1, state: 'NOT_STARTED', stage: null, assignee: null, harness: null, dependencies: [], priority: 2, plannedStart: null, dueDate: null, designId: null, fence: 0, lease: null, candidate: null, initialReview: null, qaReview: null, finalReview: null, savedState: null };
      s.put('issue', i, w.id); s.event(w.id, actor, op, i.id, { key: i.key, version: 1 });
      return { issue: this.display(i) };
    }
    const i = s.issue(actor, w.id, a.issueId);
    version(i, a.expectedVersion);
    if (op === 'issue_update') {
      requireRole(actor, 'human', 'lead', 'pm');
      if (['DONE', 'ABANDONED'].includes(i.state)) throw new DomainError('ISSUE_CLOSED', 'Reopen before editing');
      if (a.title !== undefined && i.parentId && !/^\[(Feature|Fix|Refactor|Test|Docs|Research)\] [^:]+: .+ -> .+$/.test(a.title)) throw new DomainError('TITLE_FORMAT', 'Invalid task suffix');
      if (a.description !== undefined && a.description !== i.description) { i.scopeRevision++; this.invalidate(i); }
      for (const key of ['title', 'description', 'priority', 'plannedStart', 'dueDate'] as const) if (a[key] !== undefined) (i as any)[key] = a[key];
      return this.save(actor, op, i);
    }
    if (op === 'design_set') {
      requireRole(actor, 'human', 'lead');
      if (i.parentId) throw new DomainError('PARENT_DESIGN_REQUIRED', 'Design revisions belong to the parent requirement');
      if (['DONE', 'ABANDONED'].includes(i.state)) throw new DomainError('ISSUE_CLOSED', 'Reopen before changing scope');
      const design: Design = { id: randomUUID(), issueId: i.id, content: a.content, criteria: [...new Set<string>(a.criteria)], status: 'DRAFT', hash: hash(canonical({ content: a.content, criteria: a.criteria })) };
      s.put('design', design, w.id); i.designId = design.id; i.criteria = design.criteria;
      this.invalidate(i);
      for (const child of s.list<Issue>('issue', w.id).filter(c => c.parentId === i.id && c.state !== 'ABANDONED')) { this.invalidate(child); this.save(actor, 'design_invalidated', child, { designId: design.id }); }
      return this.save(actor, op, i, { designId: design.id });
    }
    if (op === 'design_submit' || op === 'design_decide') {
      requireRole(actor, ...(op === 'design_decide' ? ['human'] as const : ['human', 'lead'] as const));
      if (!i.designId || i.parentId) throw new DomainError('DESIGN_REQUIRED', 'Create a parent design first');
      const d = s.get<Design>('design', i.designId);
      if (op === 'design_submit') { if (d.status !== 'DRAFT' && d.status !== 'CHANGES_REQUESTED') throw new DomainError('INVALID_TRANSITION', 'Design is not editable'); d.status = 'IN_REVIEW'; }
      else {
        if (a.designId !== d.id) throw new DomainError('APPROVAL_STALE', 'Design revision changed');
        if (d.status !== 'IN_REVIEW') throw new DomainError('INVALID_TRANSITION', 'Design is not awaiting a decision');
        d.status = a.decision;
        s.put('approval', { id: randomUUID(), actorId: actor.id, designId: d.id, hash: d.hash, decision: a.decision, reason: a.reason, at: new Date(this.now()).toISOString() }, w.id);
      }
      s.put('design', d, w.id);
      return this.save(actor, op, i, { designId: d.id, decision: d.status });
    }
    if (op === 'issue_assign') {
      requireRole(actor, 'human', 'lead', 'pm');
      if (i.state !== 'NOT_STARTED' && !i.state.endsWith('REJECTED')) throw new DomainError('ASSIGNMENT_ACTIVE', 'Reconcile active work before reassigning');
      const assigned = s.get<Actor>('actor', a.actorId);
      if (assigned.role !== 'worker' || !assigned.workspaceIds.includes(w.id)) throw new DomainError('SCOPE_DENIED', 'Assignment requires a worker in this workspace');
      i.assignee = assigned.id; i.harness = a.harness; i.lease = null;
      return this.save(actor, op, i);
    }
    if (op === 'dependency_add') {
      requireRole(actor, 'human', 'lead', 'pm');
      if (i.state !== 'NOT_STARTED') throw new DomainError('PLAN_ACTIVE', 'Dependency edits require unstarted work');
      s.issue(actor, w.id, a.dependsOn);
      const reaches = (id: string, seen = new Set<string>()): boolean => {
        if (id === i.id) return true;
        if (seen.has(id)) return false;
        seen.add(id); return s.get<Issue>('issue', id).dependencies.some(d => reaches(d, seen));
      };
      if (reaches(a.dependsOn)) throw new DomainError('DEPENDENCY_CYCLE', 'Dependency would create a cycle');
      if (i.parentId === a.dependsOn) throw new DomainError('DEPENDENCY_CYCLE', 'A child cannot wait for its own aggregate parent');
      i.dependencies = [...new Set([...i.dependencies, a.dependsOn])];
      return this.save(actor, op, i);
    }
    if (op === 'work_dispatch' || op === 'work_claim') {
      requireRole(actor, ...(op === 'work_claim' ? ['worker'] as const : ['human', 'lead', 'pm'] as const));
      if (!['NOT_STARTED', 'LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED'].includes(i.state)) throw new DomainError('INVALID_TRANSITION', 'Issue cannot be started from its current state');
      const blockers = this.readiness(i).blocking;
      if (blockers.length) throw new DomainError('NOT_READY', 'Resolve readiness blockers first', 409, { blockers });
      if (this.design(i)?.id !== a.designId || i.scopeRevision !== a.scopeRevision) throw new DomainError('APPROVAL_STALE', 'Acknowledge the current design and task scope');
      if (op === 'work_dispatch') {
        if (s.list<any>('run', w.id).some(r => r.issueId === i.id && ['QUEUED', 'STARTING', 'RUNNING', 'STOPPING', 'UNCERTAIN'].includes(r.state))) throw new DomainError('RUN_EXISTS', 'A live or uncertain dispatch already owns this task');
        const run = { id: randomUUID(), issueId: i.id, workspaceId: w.id, actorId: i.assignee, harness: i.harness, state: 'QUEUED', createdAt: new Date(this.now()).toISOString(), designId: a.designId, scopeRevision: a.scopeRevision };
        s.put('run', run, w.id); this.save(actor, op, i, { runId: run.id });
        return { run, issue: this.display(i) };
      }
      if (i.assignee !== actor.id) throw new DomainError('ROLE_DENIED', 'Only the assigned worker can claim this task', 403);
      i.fence++; i.lease = { actorId: actor.id, expiresAt: this.now() + 300000, fence: i.fence }; i.state = 'IN_PROGRESS'; i.stage = null;
      if (i.parentId) { const parent = s.get<Issue>('issue', i.parentId); if (parent.state === 'NOT_STARTED') { parent.state = 'IN_PROGRESS'; this.save(actor, 'child_started', parent); } }
      return this.save(actor, op, i);
    }
    if (op === 'work_heartbeat' || op === 'work_submit') {
      requireRole(actor, 'worker');
      if (i.state !== 'IN_PROGRESS' || i.lease?.actorId !== actor.id || i.lease.fence !== a.fence) throw new DomainError('STALE_FENCE', 'Run does not own the current implementation lease');
      if (i.lease.expiresAt <= this.now()) throw new DomainError('LEASE_EXPIRED', 'Reconcile execution before renewing or submitting');
      if (this.readiness(i).blocking.length) throw new DomainError('NOT_READY', 'Work is blocked by a changed requirement or hold');
      if (op === 'work_heartbeat') { i.lease.expiresAt = this.now() + 300000; return this.save(actor, op, i); }
      const files = (a.files as string[]).map(path => {
        if (isAbsolute(path)) throw new DomainError('PATH_DENIED', 'Use workspace-relative artifact paths', 403);
        const file = inside(w.root, path);
        if (!statSync(file).isFile() || statSync(file).size > 2 * 1024 * 1024) throw new DomainError('ARTIFACT_LIMIT', 'Artifacts must be files of at most 2 MiB');
        return { path: relative(w.root, file), hash: hash(readFileSync(file)) };
      });
      i.candidate = { id: randomUUID(), workerId: actor.id, sessionId: actor.sessionId, designId: this.design(i)!.id, files, hash: hash(canonical(files)), summary: a.summary };
      i.initialReview = null; i.qaReview = null; i.finalReview = null; i.lease = null; i.state = 'LEAD_REVIEW'; i.stage = 'PRE_QA';
      return this.save(actor, op, i, { candidateId: i.candidate.id, artifactHash: i.candidate.hash });
    }
    if (op === 'review_submit') {
      if (!i.candidate || i.candidate.id !== a.candidateId) throw new DomainError('EVIDENCE_STALE', 'Review must reference the current candidate');
      for (const file of i.candidate.files) if (hash(readFileSync(inside(w.root, file.path))) !== file.hash) throw new DomainError('EVIDENCE_STALE', 'Submitted artifact changed; resubmit before review');
      if (i.candidate.sessionId === actor.sessionId) throw new DomainError('REVIEW_INDEPENDENCE_REQUIRED', 'Implementer cannot review its own delivery');
      if (i.state === 'LEAD_REVIEW') requireRole(actor, 'lead');
      else if (i.state === 'QA_TEST') requireRole(actor, 'qa');
      else throw new DomainError('INVALID_TRANSITION', 'Issue is not awaiting a review');
      if (i.state === 'QA_TEST' && a.verdict === 'PASS') throw new DomainError('EVIDENCE_MISSING', 'A trusted independent test run is required; narrative approval cannot pass QA');
      if (i.state === 'LEAD_REVIEW' && i.stage === 'FINAL' && (!i.initialReview || !i.qaReview)) throw new DomainError('EVIDENCE_MISSING', 'Final review requires current initial and independent QA evidence');
      const review = { id: randomUUID(), actorId: actor.id, sessionId: actor.sessionId, candidateId: i.candidate.id, stage: i.stage ?? 'QA', verdict: a.verdict, reason: a.reason, at: new Date(this.now()).toISOString() };
      s.put('review', review, w.id);
      if (a.verdict === 'FAIL') { i.state = i.state === 'QA_TEST' ? 'QA_REJECTED' : 'LEAD_REJECTED'; i.stage = null; }
      else if (i.stage === 'PRE_QA') { i.initialReview = review.id; i.state = 'QA_TEST'; i.stage = null; }
      else { i.finalReview = review.id; i.state = 'USER_ACCEPTANCE'; i.stage = null; }
      return this.save(actor, op, i, { reviewId: review.id, verdict: review.verdict, reason: review.reason });
    }
    if (op === 'issue_transition') {
      requireRole(actor, 'human');
      if (a.action === 'hold') {
        if (['DONE', 'ABANDONED', 'ON_HOLD'].includes(i.state)) throw new DomainError('INVALID_TRANSITION', 'Only active issues can be held');
        i.savedState = { state: i.state, stage: i.stage }; i.state = 'ON_HOLD';
      } else if (a.action === 'resume') {
        if (i.state !== 'ON_HOLD' || !i.savedState) throw new DomainError('INVALID_TRANSITION', 'Issue is not on hold');
        i.state = i.savedState.state; i.stage = i.savedState.stage; i.savedState = null;
        if (i.state === 'IN_PROGRESS') { i.state = 'NOT_STARTED'; i.lease = null; }
      } else if (a.action === 'abandon') {
        if (['DONE', 'ABANDONED'].includes(i.state)) throw new DomainError('INVALID_TRANSITION', 'Issue is already terminal');
        if (s.list<Issue>('issue', w.id).some(child => child.parentId === i.id && !['DONE', 'ABANDONED'].includes(child.state))) throw new DomainError('CHILD_DISPOSITION_REQUIRED', 'Resolve active children explicitly before abandoning the parent');
        i.state = 'ABANDONED'; i.lease = null;
      } else {
        if (!['DONE', 'ABANDONED'].includes(i.state)) throw new DomainError('INVALID_TRANSITION', 'Only terminal issues can reopen');
        this.invalidate(i); i.state = 'NOT_STARTED';
      }
      return this.save(actor, op, i, { reason: a.reason });
    }
    throw new DomainError('CAPABILITY_UNSUPPORTED', 'Operation is not implemented', 501);
  }
}
