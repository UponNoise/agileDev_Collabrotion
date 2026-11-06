import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Actor, DomainError, Issue, Run, Workspace, liveRunStates } from './contracts.js';
import { AdapterContext, AdapterResult, ExecutionAdapter, NativeAdapter, RunningSession } from './adapters.js';
import { prepareExecution } from './execution.js';
import { Store, hash } from './store.js';
import { inside, Workflow } from './workflow.js';
import { join } from 'node:path';

interface OwnedExecution { actor: Actor; token: string; session?: RunningSession; promise?: Promise<void>; stopping: boolean; started: number; heartbeat: number; errorCode?: string }
export interface RunnerOptions { endpoint: string; directory: string; bridgeScript: string; concurrency?: number; maxRunMs?: number; adapter?: ExecutionAdapter; now?: () => number }
export class Coordinator {
  readonly id = randomUUID();
  private live = new Map<string, OwnedExecution>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private closing = false;
  private readonly flow: Workflow;
  private readonly adapter: ExecutionAdapter;
  private readonly now: () => number;
  private readonly concurrency: number;
  constructor(private store: Store, private options: RunnerOptions) {
    this.now = options.now ?? Date.now; this.flow = new Workflow(store, this.now); this.adapter = options.adapter ?? new NativeAdapter();
    this.concurrency = options.concurrency ?? 2;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4) throw new DomainError('INVALID_CAPACITY', 'Concurrent run capacity must be 1 through 4');
    if (!Number.isFinite(options.maxRunMs ?? 1800000) || (options.maxRunMs ?? 1800000) <= 0) throw new DomainError('INVALID_BUDGET', 'Run time budget must be a positive finite number');
  }
  async start() {
    this.recover(); await this.tick();
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 250);
  }
  recover() {
    this.store.db.transaction(() => {
      for (const run of this.store.list<Run>('run').filter(r => ['STARTING', 'RUNNING', 'STOPPING'].includes(r.state) && r.coordinatorId !== this.id)) {
        run.state = 'UNCERTAIN'; run.errorCode = 'COORDINATOR_LOST'; run.version = (run.version ?? 1) + 1;
        this.store.put('run', run, run.workspaceId);
        if (run.executionActorId) this.store.revokeActor(run.executionActorId);
        const actor = this.store.get<Actor>('actor', run.actorId);
        this.store.event(run.workspaceId, actor, 'run_uncertain', run.id, { reason: 'Previous coordinator is not attached; no automatic redispatch' });
      }
    }).immediate();
  }
  private update(id: string, patch: Partial<Run>) {
    const run = this.store.get<Run>('run', id);
    if (run.coordinatorId !== this.id || !['STARTING', 'RUNNING', 'STOPPING'].includes(run.state)) return run;
    Object.assign(run, patch); run.version = (run.version ?? 1) + 1;
    this.store.put('run', run, run.workspaceId);
    return run;
  }
  async tick() {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      for (const [id, owned] of this.live) {
        const run = this.store.get<Run>('run', id); const issue = this.store.get<Issue>('issue', run.issueId);
        const parent = issue.parentId ? this.store.get<Issue>('issue', issue.parentId) : null;
        const budget = run.budgetMs ?? this.options.maxRunMs ?? 1800000;
        if (run.state === 'RUNNING' && issue.lease?.actorId !== owned.actor.id && issue.candidate?.runId !== id) { owned.errorCode = 'OWNERSHIP_LOST'; await this.interrupt(id, owned); continue; }
        if (run.state === 'STOPPING' || issue.state === 'ON_HOLD' || issue.state === 'ABANDONED' || parent?.state === 'ON_HOLD' || parent?.state === 'ABANDONED' || this.now() - owned.started >= budget) {
          if (this.now() - owned.started >= budget) owned.errorCode = 'RUN_TIME_BUDGET';
          await this.interrupt(id, owned); continue;
        }
        if (issue.lease?.actorId === owned.actor.id && this.now() - owned.heartbeat >= 60000) {
          try {
            this.flow.execute(owned.actor, 'work_heartbeat', { workspaceId: run.workspaceId, issueId: issue.id, expectedVersion: issue.version, fence: issue.fence, idempotencyKey: `heartbeat-${this.now()}` });
            owned.heartbeat = this.now(); this.update(id, { lastHeartbeatAt: new Date(this.now()).toISOString() });
          } catch { owned.errorCode = 'OWNERSHIP_LOST'; await this.interrupt(id, owned); }
        }
      }
      const active = this.store.list<Run>('run').filter(r => ['STARTING', 'RUNNING', 'STOPPING', 'UNCERTAIN'].includes(r.state)).length;
      let slots = this.concurrency - active;
      for (const queued of this.store.list<Run>('run').filter(r => r.state === 'QUEUED')) {
        if (slots-- <= 0) break;
        const owned = this.reserve(queued.id);
        if (owned) { owned.promise = this.execute(queued.id, owned); this.live.set(queued.id, owned); }
      }
    } finally { this.ticking = false; }
  }
  private reserve(id: string): OwnedExecution | null {
    return this.store.db.transaction(() => {
      const run = this.store.get<Run>('run', id);
      if (run.state !== 'QUEUED') return null;
      const actor: Actor = { id: randomUUID(), role: 'worker', name: `Worker run ${id}`, principalId: run.actorId, runId: run.id, workspaceIds: [run.workspaceId], sessionId: randomUUID() };
      const token = this.store.token(actor);
      run.state = 'STARTING'; run.coordinatorId = this.id; run.executionActorId = actor.id; run.startedAt = new Date(this.now()).toISOString(); run.version = (run.version ?? 1) + 1;
      run.budgetMs = this.options.maxRunMs ?? 1800000; run.coordinatorConcurrency = this.concurrency;
      this.store.put('run', run, run.workspaceId); this.store.event(run.workspaceId, actor, 'run_starting', run.id, { harness: run.harness });
      return { actor, token, stopping: false, started: this.now(), heartbeat: this.now() };
    }).immediate();
  }
  private async interrupt(id: string, owned: OwnedExecution) {
    if (owned.stopping) return;
    this.update(id, { state: 'STOPPING' });
    if (!owned.session) return;
    owned.stopping = true;
    const confirmed = await owned.session.interrupt();
    if (!confirmed) this.finish(id, owned, { outcome: 'uncertain', errorCode: 'STOP_UNCONFIRMED' });
  }
  private async execute(id: string, owned: OwnedExecution) {
    try {
      let run = this.store.get<Run>('run', id); const workspace = this.store.get<Workspace>('workspace', run.workspaceId);
      const directory = await prepareExecution(workspace, id, this.options.directory);
      run = this.update(id, { executionRoot: directory.root, baseSha: directory.baseSha });
      if (this.closing || run.state === 'STOPPING') { this.finish(id, owned, { outcome: 'cancelled', errorCode: 'INTERRUPTED_BEFORE_LAUNCH' }); return; }
      let issue = this.store.get<Issue>('issue', run.issueId);
      if (issue.assignee !== run.actorId || issue.harness !== run.harness || issue.scopeRevision !== run.scopeRevision || this.flow.design(issue)?.id !== run.designId) throw new DomainError('DISPATCH_STALE', 'Assignment or scope changed after dispatch');
      this.flow.execute(owned.actor, 'work_claim', { workspaceId: run.workspaceId, issueId: run.issueId, expectedVersion: issue.version, designId: run.designId, scopeRevision: run.scopeRevision, idempotencyKey: `run-claim-${id}` });
      run = this.update(id, { state: 'RUNNING' }); issue = this.store.get<Issue>('issue', run.issueId);
      const prompt = [
        'You are the implementation worker for a scoped AgileDev assignment. Work only in the supplied execution directory. Do not send messages or publish externally. Do not spawn additional agents. Do not alter workflow configuration or impersonate a reviewer or human.',
        `Execution root: ${directory.root}`,
        `Workspace: ${run.workspaceId}; issue: ${issue.id} (${issue.key}); run: ${run.id}.`,
        `Approved design revision: ${run.designId}; task scope revision: ${run.scopeRevision}.`,
        `Task: ${issue.title}\n${issue.description}`,
        `Acceptance criteria: ${issue.criteria.join(', ')}`,
        `Approved design:\n${this.flow.design(issue)!.content}`,
        'The coordinator has claimed your lease. Use agiledev issue_get to read the latest issue version and fence, and work_heartbeat for long work. Implement and self-check the assigned behavior.',
        'When ready, call agiledev work_submit with the current expectedVersion, fence, a unique idempotencyKey, a concise summary, and the relative paths of actual delivered files. Do not submit secrets or dependency directories. A final text response alone is not submission. Never approve your own implementation.',
      ].join('\n\n');
      const context: AdapterContext = { harness: run.harness, cwd: directory.root, directory: join(this.options.directory, id), prompt, token: owned.token, endpoint: this.options.endpoint, bridgeScript: this.options.bridgeScript,
        onPid: pid => { if (this.store.db.open) this.update(id, { pid }); }, onProvider: providerSessionId => { if (this.store.db.open) this.update(id, { providerSessionId }); },
        onOutput: summary => { if (this.store.db.open) this.update(id, { summary: summary.replaceAll(owned.token, '[redacted]').slice(-16000) }); } };
      owned.session = await this.adapter.start(context);
      if (this.store.get<Run>('run', id).state === 'STOPPING' || this.closing) await this.interrupt(id, owned);
      const result = await owned.session.result;
      this.finish(id, owned, result);
    } catch (error) {
      this.finish(id, owned, { outcome: owned.session ? 'uncertain' : 'failed', errorCode: error instanceof DomainError ? error.code : 'EXECUTION_FAILED', summary: error instanceof DomainError ? error.message : 'Execution could not be completed; inspect the retained run directory' });
    } finally { this.live.delete(id); }
  }
  private finish(id: string, owned: OwnedExecution, result: AdapterResult) {
    if (!this.store.db.open) return;
    this.store.db.transaction(() => {
      const run = this.store.get<Run>('run', id);
      if (run.coordinatorId !== this.id || !['STARTING', 'RUNNING', 'STOPPING'].includes(run.state)) return;
      const issue = this.store.get<Issue>('issue', run.issueId);
      if (run.state === 'STOPPING' && result.outcome === 'succeeded') result = { ...result, outcome: 'cancelled', errorCode: 'INTERRUPTED' };
      if (result.outcome === 'succeeded') {
        if (!run.providerSessionId || issue.candidate?.runId !== run.id || issue.candidate.workerId !== owned.actor.id) result = { ...result, outcome: 'failed', errorCode: 'SUBMISSION_REQUIRED' };
        else {
          try { for (const file of issue.candidate.files) if (hash(readFileSync(inside(run.executionRoot!, file.path))) !== file.hash) throw new Error('Changed artifact'); }
          catch { result = { ...result, outcome: 'failed', errorCode: 'ARTIFACT_CHANGED_AFTER_SUBMISSION' }; }
        }
      }
      run.state = result.outcome === 'succeeded' ? 'SUCCEEDED' : result.outcome === 'cancelled' ? 'CANCELLED' : result.outcome === 'uncertain' ? 'UNCERTAIN' : 'FAILED';
      run.errorCode = owned.errorCode ?? result.errorCode; run.summary = (result.summary || run.summary)?.replaceAll(owned.token, '[redacted]').slice(-16000); run.finishedAt = new Date(this.now()).toISOString(); run.version = (run.version ?? 1) + 1;
      this.store.put('run', run, run.workspaceId);
      this.store.revokeActor(owned.actor.id);
      if (run.state !== 'UNCERTAIN' && issue.lease?.actorId === owned.actor.id) {
        issue.lease = null; if (issue.state === 'IN_PROGRESS') issue.state = 'NOT_STARTED'; issue.version++;
        this.store.put('issue', issue, issue.workspaceId);
      }
      this.store.event(run.workspaceId, owned.actor, 'run_finished', run.id, { state: run.state, issueState: issue.state, errorCode: run.errorCode, providerSessionId: run.providerSessionId });
    }).immediate();
  }
  async close() {
    this.closing = true; if (this.timer) clearInterval(this.timer);
    for (const [id, owned] of this.live) await this.interrupt(id, owned);
    const pending = [...this.live.values()].map(o => o.promise);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(pending), new Promise(done => { timer = setTimeout(done, 12000); })]);
    if (timer) clearTimeout(timer);
    for (const [id, owned] of this.live) this.finish(id, owned, { outcome: 'uncertain', errorCode: 'SHUTDOWN_UNCONFIRMED' });
  }
  get activeCount() { return this.store.list<Run>('run').filter(r => (liveRunStates as readonly string[]).includes(r.state) && r.state !== 'QUEUED').length; }
}
