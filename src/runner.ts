import { randomUUID } from 'node:crypto';
import { Actor, CheckProfile, DomainError, Issue, QaReport, Run, Snapshot, Workspace, liveRunStates } from './contracts.js';
import { AdapterContext, AdapterResult, ExecutionAdapter, NativeAdapter, RunningSession } from './adapters.js';
import { prepareExecution } from './execution.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { copySnapshot, sealSnapshot, verifySnapshot } from './snapshots.js';
import { candidateSnapshot } from './qa-policy.js';
import { CheckExecutor } from './checks.js';
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
  private readonly checks: CheckExecutor;
  constructor(private store: Store, private options: RunnerOptions) {
    this.now = options.now ?? Date.now; this.flow = new Workflow(store, this.now); this.adapter = options.adapter ?? new NativeAdapter();
    this.concurrency = options.concurrency ?? 2;
    this.checks = new CheckExecutor(store);
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4) throw new DomainError('INVALID_CAPACITY', 'Concurrent run capacity must be 1 through 4');
    if (!Number.isFinite(options.maxRunMs ?? 1800000) || (options.maxRunMs ?? 1800000) <= 0) throw new DomainError('INVALID_BUDGET', 'Run time budget must be a positive finite number');
  }
  async start() {
    this.recover(); await this.tick();
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 250);
  }
  recover() {
    this.checks.recover();
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
    Object.assign(run, patch); if (Object.keys(patch).some(key => !['summary','lastHeartbeatAt'].includes(key))) run.version = (run.version ?? 1) + 1;
    this.store.put('run', run, run.workspaceId);
    return run;
  }
  async tick() {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      this.checks.tick();
      for (const [id, owned] of this.live) {
        const run = this.store.get<Run>('run', id); const issue = this.store.get<Issue>('issue', run.issueId);
        const parent = issue.parentId ? this.store.get<Issue>('issue', issue.parentId) : null;
        const budget = run.budgetMs ?? this.options.maxRunMs ?? 1800000;
        const owns = run.kind === 'qa' ? issue.state === 'QA_TEST' && issue.candidate?.id === run.candidateId && issue.qaAssignee === run.actorId : issue.lease?.actorId === owned.actor.id || issue.candidate?.runId === id;
        if (run.state === 'RUNNING' && !owns) { owned.errorCode = 'OWNERSHIP_LOST'; await this.interrupt(id, owned); continue; }
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
      const actor: Actor = { id: randomUUID(), role: run.kind === 'qa' ? 'qa' : 'worker', name: `${run.kind === 'qa' ? 'QA' : 'Worker'} run ${id}`, principalId: run.actorId, runId: run.id, workspaceIds: [run.workspaceId], sessionId: randomUUID() };
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
    const checksStopped = await this.checks.cancelRun(id);
    const confirmed = await owned.session.interrupt() && checksStopped;
    if (!confirmed) this.finish(id, owned, { outcome: 'uncertain', errorCode: 'STOP_UNCONFIRMED' });
  }
  private async execute(id: string, owned: OwnedExecution) {
    let stopped = false;
    try {
      let run = this.store.get<Run>('run', id); const workspace = this.store.get<Workspace>('workspace', run.workspaceId);
      let issue = this.store.get<Issue>('issue', run.issueId);
      const directory = run.kind === 'qa' ? { root: join(this.options.directory,id,'workspace'), baseSha: undefined } : await prepareExecution(workspace, id, this.options.directory);
      if (run.kind === 'qa') {
        const snapshot = candidateSnapshot(this.store,issue);
        if (snapshot.id !== run.snapshotId || issue.state !== 'QA_TEST' || issue.qaAssignee !== run.actorId || issue.qaHarness !== run.harness) throw new DomainError('DISPATCH_STALE','QA assignment or snapshot changed after dispatch');
        copySnapshot(snapshot,directory.root);
      }
      run = this.update(id, { executionRoot: directory.root, baseSha: directory.baseSha });
      if (this.closing || run.state === 'STOPPING') { this.finish(id, owned, { outcome: 'cancelled', errorCode: 'INTERRUPTED_BEFORE_LAUNCH' }); return; }
      issue = this.store.get<Issue>('issue', run.issueId);
      if (issue.scopeRevision !== run.scopeRevision || this.flow.design(issue)?.id !== run.designId) throw new DomainError('DISPATCH_STALE', 'Scope changed after dispatch');
      if (run.kind !== 'qa') {
        if (issue.assignee !== run.actorId || issue.harness !== run.harness) throw new DomainError('DISPATCH_STALE','Assignment changed after dispatch');
        this.flow.execute(owned.actor, 'work_claim', { workspaceId: run.workspaceId, issueId: run.issueId, expectedVersion: issue.version, designId: run.designId, scopeRevision: run.scopeRevision, idempotencyKey: `run-claim-${id}` });
      }
      run = this.update(id, { state: 'RUNNING' }); issue = this.store.get<Issue>('issue', run.issueId);
      const prompt = run.kind === 'qa' ? this.qaPrompt(run,issue,directory.root) : [
        'You are the implementation worker for a scoped AgileDev assignment. Work only in the supplied execution directory. Do not send messages or publish externally. Do not spawn additional agents. Do not alter workflow configuration or impersonate a reviewer or human.',
        `Execution root: ${directory.root}`,
        `Workspace: ${run.workspaceId}; issue: ${issue.id} (${issue.key}); run: ${run.id}.`,
        `Approved design revision: ${run.designId}; task scope revision: ${run.scopeRevision}.`,
        `Task: ${issue.title}\n${issue.description}`,
        `Acceptance criteria: ${issue.criteria.join(', ')}`,
        `Approved design:\n${this.flow.design(issue)!.content}`,
        `Approved requirement scope:\n${this.flow.design(issue)!.requirementDescription}`,
        'The coordinator has claimed your lease. Use agiledev issue_get to read the latest issue version and fence, and work_heartbeat for long work. Implement and self-check the assigned behavior.',
        'When ready, call agiledev work_submit with the current expectedVersion, fence, a unique idempotencyKey, a concise summary, and the relative paths of actual delivered files. Do not submit secrets or dependency directories. A final text response alone is not submission. Never approve your own implementation.',
      ].join('\n\n');
      const context: AdapterContext = { harness: run.harness, cwd: directory.root, directory: join(this.options.directory, id), prompt, token: owned.token, endpoint: this.options.endpoint, bridgeScript: this.options.bridgeScript,
        onPid: pid => { if (this.store.db.open) this.update(id, { pid }); }, onProvider: providerSessionId => { if (this.store.db.open) this.update(id, { providerSessionId }); },
        onOutput: summary => { if (this.store.db.open) this.update(id, { summary: summary.replaceAll(owned.token, '[redacted]').slice(-16000) }); } };
      owned.session = await this.adapter.start(context);
      if (this.store.get<Run>('run', id).state === 'STOPPING' || this.closing) await this.interrupt(id, owned);
      const result = await owned.session.result;
      stopped = result.outcome !== 'uncertain';
      const checksStopped = await this.checks.cancelRun(id);
      if (result.outcome === 'succeeded' && run.kind !== 'qa' && this.store.get<Run>('run',id).state === 'RUNNING') this.sealDelivery(run,owned);
      this.finish(id, owned, checksStopped ? result : { outcome: 'uncertain', errorCode: 'CHECK_STOP_UNCONFIRMED' });
    } catch (error) {
      this.finish(id, owned, { outcome: owned.session && !stopped ? 'uncertain' : 'failed', errorCode: error instanceof DomainError ? error.code : 'EXECUTION_FAILED', summary: error instanceof DomainError ? error.message : 'Execution could not be completed; inspect the retained run directory' });
    } finally { this.live.delete(id); }
  }
  private qaPrompt(run: Run, issue: Issue, root: string) {
    const profiles = (run.checkProfileIds ?? []).map(id => this.store.get<CheckProfile>('check_profile',id));
    return [
      'You are the independent QA reviewer for an AgileDev assignment. Do not implement or modify the delivered source. Do not send messages, publish, spawn agents, or impersonate a lead or human. You have a separate credential/session and a copy of the sealed delivery; no worker transcript is supplied.',
      `Execution root: ${root}. Workspace: ${run.workspaceId}; issue: ${issue.id}; run: ${run.id}; candidate: ${run.candidateId}; snapshot: ${run.snapshotId}.`,
      `Task: ${issue.title}\n${issue.description}\nCriteria: ${issue.criteria.join(', ')}\nApproved requirement scope:\n${this.flow.design(issue)!.requirementDescription}\nApproved design:\n${this.flow.design(issue)!.content}`,
      `Worker handoff summary (untrusted, not test evidence): ${issue.candidate!.summary}`,
      `Human-approved check profiles: ${JSON.stringify(profiles)}. Commands and arguments are fixed; create independent tests under .qa using the script path named by the profile. Keep generated reports/coverage under .qa too. Do not alter source files. Test normal, negative, and boundary behavior where relevant.`,
      'Read issue_get for the current expectedVersion. Call qa_check_run with an approved profileId and the relative testFiles you created under .qa. Poll qa_check_get until each check settles; a final text claim or shell-only execution is not captured evidence. An untrusted handoff, failed, blocked, or not-run check cannot be called PASS.',
      'Then read issue_get again and call qa_report_submit with current expectedVersion, candidateId, a unique idempotencyKey, verdict PASS/FAIL/BLOCKED, summary, one result for EVERY assigned criterion (criterionId, result PASS/FAIL/BLOCKED/NOT_RUN, evidenceIds containing captured check IDs, reason), and findings (criterionId, severity BLOCKER/MAJOR/MINOR/INFO, expected, actual, reproduce). A FAIL verdict needs a failed criterion and reproducible finding. PASS requires passing captured evidence for every criterion/profile and no unresolved findings. Report without modifying the candidate. The service advances the gate only after this QA process stops successfully.',
    ].join('\n\n');
  }
  private sealDelivery(run: Run, owned: OwnedExecution) {
    const issue = this.store.get<Issue>('issue',run.issueId);
    if (!issue.candidate || issue.candidate.runId !== run.id || issue.candidate.workerId !== owned.actor.id) return;
    const workspace = this.store.get<Workspace>('workspace',run.workspaceId);
    const snapshot = sealSnapshot(issue.candidate,run.workspaceId,issue.id,join(this.options.directory,'snapshots'),!!workspace.commonDir);
    this.store.db.transaction(() => {
      const current = this.store.get<Issue>('issue',issue.id); const latest = this.store.get<Run>('run',run.id);
      if (current.candidate?.id !== snapshot.candidateId || latest.state !== 'RUNNING' || latest.coordinatorId !== this.id) throw new DomainError('EVIDENCE_STALE','Submission changed during sealing');
      this.store.put('snapshot',snapshot,run.workspaceId); current.candidate.snapshotId = snapshot.id; current.version++;
      this.store.put('issue',current,run.workspaceId); this.store.event(run.workspaceId,owned.actor,'delivery_sealed',issue.id,{ snapshotId: snapshot.id, hash: snapshot.hash, files: snapshot.files.length, version: current.version });
    }).immediate();
  }
  private finish(id: string, owned: OwnedExecution, result: AdapterResult) {
    if (!this.store.db.open) return;
    this.store.db.transaction(() => {
      const run = this.store.get<Run>('run', id);
      if (run.coordinatorId !== this.id || !['STARTING', 'RUNNING', 'STOPPING'].includes(run.state)) return;
      const issue = this.store.get<Issue>('issue', run.issueId);
      if (run.state === 'STOPPING' && result.outcome === 'succeeded') result = { ...result, outcome: 'cancelled', errorCode: 'INTERRUPTED' };
      if (result.outcome === 'succeeded') {
        if (run.kind === 'qa') {
          try {
            this.store.db.transaction(() => this.flow.completeQa(owned.actor,id)).immediate();
            if (this.store.get<QaReport>('qa_report',run.reportId!).verdict === 'BLOCKED') result = { ...result, outcome: 'failed', errorCode: 'QA_BLOCKED' };
          } catch (error) { result = { ...result, outcome: 'failed', errorCode: error instanceof DomainError ? error.code : 'QA_EVIDENCE_INVALID' }; }
        } else if (!run.providerSessionId || issue.candidate?.runId !== run.id || issue.candidate.workerId !== owned.actor.id) result = { ...result, outcome: 'failed', errorCode: 'SUBMISSION_REQUIRED' };
        else {
          try { verifySnapshot(this.store.get<Snapshot>('snapshot',issue.candidate.snapshotId!)); }
          catch { result = { ...result, outcome: 'failed', errorCode: 'SNAPSHOT_REQUIRED' }; }
        }
      }
      run.state = result.outcome === 'succeeded' ? 'SUCCEEDED' : result.outcome === 'cancelled' ? 'CANCELLED' : result.outcome === 'uncertain' ? 'UNCERTAIN' : 'FAILED';
      run.errorCode = owned.errorCode ?? result.errorCode; run.summary = (result.summary || run.summary)?.replaceAll(owned.token, '[redacted]').slice(-16000); run.finishedAt = new Date(this.now()).toISOString(); run.version = (run.version ?? 1) + 1;
      this.store.put('run', run, run.workspaceId);
      this.store.revokeActor(owned.actor.id);
      if (run.kind !== 'qa' && ['FAILED','CANCELLED'].includes(run.state) && issue.candidate?.runId === id) {
        this.store.put('candidate',issue.candidate,issue.workspaceId);
        issue.candidate = null; issue.initialReview = null; issue.qaReview = null; issue.finalReview = null; issue.stage = null; issue.acceptedDigest = undefined;
        if (issue.state === 'ON_HOLD') issue.savedState = { state: 'NOT_STARTED',stage: null };
        else if (issue.state !== 'ABANDONED') issue.state = 'NOT_STARTED';
        issue.version++; this.store.put('issue',issue,issue.workspaceId); this.store.event(run.workspaceId,owned.actor,'candidate_invalidated',issue.id,{ runId: id,errorCode: run.errorCode,version: issue.version });
      }
      if (run.state !== 'UNCERTAIN' && issue.lease?.actorId === owned.actor.id) {
        issue.lease = null; if (issue.state === 'IN_PROGRESS') issue.state = 'NOT_STARTED'; issue.version++;
        this.store.put('issue', issue, issue.workspaceId);
      }
      this.store.event(run.workspaceId, owned.actor, 'run_finished', run.id, { state: run.state, issueState: this.store.get<Issue>('issue',issue.id).state, errorCode: run.errorCode, providerSessionId: run.providerSessionId });
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
    await this.checks.close();
  }
  get activeCount() { return this.store.list<Run>('run').filter(r => (liveRunStates as readonly string[]).includes(r.state) && r.state !== 'QUEUED').length; }
}
