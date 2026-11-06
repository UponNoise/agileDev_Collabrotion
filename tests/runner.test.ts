import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Actor, DomainError, Issue, Run } from '../src/contracts.js';
import { Coordinator } from '../src/runner.js';
import { AdapterContext, AdapterResult, ExecutionAdapter, NativeAdapter } from '../src/adapters.js';
import { createServer } from '../src/http.js';
import { LocalClient } from '../src/client.js';
import { prepareExecution } from '../src/execution.js';

async function waitFor(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Condition did not become true'); await new Promise(done => setTimeout(done, 20)); }
}
class ControlledAdapter implements ExecutionAdapter {
  contexts: AdapterContext[] = [];
  finish = new Map<string, (value: AdapterResult) => void>();
  async start(context: AdapterContext) {
    this.contexts.push(context); context.onProvider(`test-provider-${randomUUID()}`);
    return { result: new Promise<AdapterResult>(done => this.finish.set(context.cwd, done)), interrupt: async () => { this.finish.get(context.cwd)?.({ outcome: 'cancelled' }); return true; } };
  }
}
async function setup(count = 2, adapter: ExecutionAdapter = new ControlledAdapter(), concurrency = 2) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-runner-'));
  const source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'source.txt'), 'original');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  git('init'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
  const store = new Store(join(root, 'service.sqlite')); const flow = new Workflow(store); const owner = store.bootstrap();
  const call = (actor: Actor, operation: string, input: object) => flow.execute(actor, operation, { idempotencyKey: randomUUID(), ...input }) as any;
  const workspace = call(owner.actor, 'workspace_register', { root: source, name: 'Runner fixture', prefix: 'RUN' }).workspace;
  const run = (op: string, input: object) => call(owner.actor, op, { workspaceId: workspace.id, ...input });
  const parent = run('issue_create', { title: 'Isolated delivery', description: 'Deliver reviewed changes', criteria: ['AC-1'] }).issue;
  const change = (op: string, id: string, input: object = {}) => run(op, { issueId: id, expectedVersion: store.get<Issue>('issue', id).version, ...input });
  change('design_set', parent.id, { content: 'Write delivered output without changing the main checkout', criteria: ['AC-1'] }); change('design_submit', parent.id);
  change('design_decide', parent.id, { designId: store.get<Issue>('issue', parent.id).designId, decision: 'APPROVED', reason: 'Test fixture approval' });
  const worker = run('actor_enroll', { role: 'worker', name: 'Logical worker' });
  const tasks: Issue[] = [];
  for (let n = 0; n < count; n++) {
    const issue = run('issue_create', { parentId: parent.id, expectedParentVersion: store.get<Issue>('issue', parent.id).version, title: `[Feature] Output: write result ${n} -> isolated delivery`, description: 'Create a result in the isolated workspace', criteria: ['AC-1'] }).issue;
    change('issue_assign', issue.id, { actorId: worker.actor.id, harness: n % 2 ? 'claude-code' : 'codex' }); tasks.push(issue);
  }
  const jobs = tasks.map(i => change('work_dispatch', i.id, { designId: store.get<Issue>('issue', parent.id).designId, scopeRevision: 1 }).run as Run);
  const server = createServer(store); const endpoint = await server.listen({ host: '127.0.0.1', port: 0 });
  const coordinator = new Coordinator(store, { endpoint, directory: join(root, 'runs'), bridgeScript: resolve('dist/cli.js'), adapter, concurrency });
  const close = async () => { await coordinator.close(); await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, source, store, flow, owner, change, workspace, tasks, jobs, adapter, coordinator, close };
}

test('cross-harness dispatch isolates real Git worktrees and requires authenticated submission', { timeout: 20000 }, async () => {
  const adapter = new ControlledAdapter(); const f = await setup(2, adapter);
  try {
    await f.coordinator.start(); await waitFor(() => adapter.contexts.length === 2);
    assert.deepEqual(adapter.contexts.map(c => c.harness).sort(), ['claude-code', 'codex']);
    assert.notEqual(adapter.contexts[0]!.cwd, adapter.contexts[1]!.cwd);
    assert.equal(readFileSync(join(f.source, 'source.txt'), 'utf8'), 'original');
    for (let n = 0; n < adapter.contexts.length; n++) {
      const context = adapter.contexts[n]!; const client = new LocalClient(context.endpoint, context.token);
      const actor = f.store.authenticate(context.token); const job = f.store.get<Run>('run', actor.runId!);
      const other = f.jobs.find(j => j.id !== job.id)!;
      await assert.rejects(client.command('issue_get', { workspaceId: f.workspace.id, issueId: other.issueId }), (e: any) => e.code === 'SCOPE_DENIED');
      const current = (await client.command('issue_get', { workspaceId: f.workspace.id, issueId: job.issueId })).issue;
      writeFileSync(join(context.cwd, 'source.txt'), `delivered ${n}`);
      context.onOutput(`accidental secret ${context.token}`);
      await client.command('work_submit', { workspaceId: f.workspace.id, issueId: job.issueId, expectedVersion: current.version, fence: current.fence, summary: 'Delivered isolated output', files: ['source.txt'], idempotencyKey: 'submit' });
      adapter.finish.get(context.cwd)!({ outcome: 'succeeded', summary: 'Provider completed' });
    }
    await waitFor(() => f.jobs.every(j => f.store.get<Run>('run', j.id).state === 'SUCCEEDED'));
    assert.equal(readFileSync(join(f.source, 'source.txt'), 'utf8'), 'original');
    for (const job of f.jobs) {
      const issue = f.store.get<Issue>('issue', job.issueId); const run = f.store.get<Run>('run', job.id);
      assert.equal(issue.state, 'LEAD_REVIEW'); assert.equal(issue.stage, 'PRE_QA'); assert.equal(issue.candidate!.runId, run.id);
      assert.match(run.baseSha!, /^[a-f0-9]{40,64}$/); assert.ok(issue.candidate!.executionRoot);
      assert.throws(() => f.store.authenticate(adapter.contexts.find(c => c.cwd === run.executionRoot)!.token), /valid scoped credential/);
    }
  } finally { await f.close(); }
});

test('provider success without a submission fails the run and preserves the business gate', { timeout: 20000 }, async () => {
  const adapter = new ControlledAdapter(); const f = await setup(1, adapter);
  try {
    await f.coordinator.start(); await waitFor(() => adapter.contexts.length === 1);
    adapter.finish.get(adapter.contexts[0]!.cwd)!({ outcome: 'succeeded', summary: 'Finished without using submission' });
    await waitFor(() => f.store.get<Run>('run', f.jobs[0]!.id).state === 'FAILED');
    assert.equal(f.store.get<Run>('run', f.jobs[0]!.id).errorCode, 'SUBMISSION_REQUIRED');
    assert.equal(f.store.get<Issue>('issue', f.tasks[0]!.id).state, 'NOT_STARTED');
  } finally { await f.close(); }
});

test('capacity bounds active jobs and confirmed interruption cancels before a replacement starts', { timeout: 20000 }, async () => {
  const adapter = new ControlledAdapter(); const f = await setup(3, adapter, 2);
  try {
    await f.coordinator.start(); await waitFor(() => adapter.contexts.length === 2);
    assert.equal(f.coordinator.activeCount, 2); assert.equal(f.store.get<Run>('run', f.jobs[2]!.id).state, 'QUEUED');
    const active = f.store.get<Run>('run', f.jobs[0]!.id);
    f.flow.execute(f.owner.actor, 'run_interrupt', { workspaceId: f.workspace.id, runId: active.id, expectedVersion: active.version, reason: 'Cancel this test assignment', idempotencyKey: 'cancel' });
    await waitFor(() => f.store.get<Run>('run', active.id).state === 'CANCELLED');
    await waitFor(() => adapter.contexts.length === 3);
    assert.ok(f.coordinator.activeCount <= 2);
  } finally { await f.close(); }
});

test('restart leaves lost execution uncertain; it cannot be blindly claimed or redispatched', { timeout: 20000 }, async () => {
  const f = await setup(1);
  try {
    const run = f.store.get<Run>('run', f.jobs[0]!.id); run.state = 'RUNNING'; run.coordinatorId = 'previous-instance'; run.pid = process.pid; f.store.put('run', run, run.workspaceId);
    f.coordinator.recover();
    const uncertain = f.store.get<Run>('run', run.id); assert.equal(uncertain.state, 'UNCERTAIN');
    assert.throws(() => f.change('work_dispatch', run.issueId, { designId: run.designId, scopeRevision: 1 }), (e: any) => e.code === 'RUN_EXISTS');
    assert.throws(() => f.flow.execute(f.owner.actor, 'run_reconcile', { workspaceId: f.workspace.id, runId: run.id, expectedVersion: uncertain.version, confirmStopped: true, reason: 'Cannot claim this still-live process stopped', idempotencyKey: 'reconcile' }), (e: any) => e.code === 'RUN_STILL_LIVE');
  } finally { await f.close(); }
});

test('real native subprocess interruption stops its process tree; exit zero alone is insufficient', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-process-'));
  const script = join(root, 'provider.mjs');
  writeFileSync(script, `process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'test-process'})+'\\n'); setInterval(()=>{},1000);`);
  let pid = 0; let provider = '';
  const adapter = new NativeAdapter(() => [{ id: 'codex', command: process.execPath, args: [script] }]);
  const context: AdapterContext = { harness: 'codex', cwd: root, directory: root, prompt: 'test fixture', endpoint: 'http://127.0.0.1:1', token: 'fixture-token', bridgeScript: resolve('dist/cli.js'), onPid: value => { pid = value; }, onProvider: value => { provider = value; }, onOutput: () => {} };
  try {
    const running = await adapter.start(context); await waitFor(() => pid > 0 && provider.length > 0);
    assert.equal(await running.interrupt(), true); assert.equal((await running.result).outcome, 'cancelled');
    assert.throws(() => process.kill(pid, 0));
    writeFileSync(script, `process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'test-process'})+'\\n');`);
    const noTerminal = await adapter.start(context); assert.equal((await noTerminal.result).outcome, 'failed');
    writeFileSync(script, `if(process.env.AGILEDEV_GITHUB_TOKEN)process.exit(9); process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'credential-boundary'})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n');`);
    const credentialBoundary = new NativeAdapter(() => [{ id: 'codex',command: process.execPath,args: [script],env: { AGILEDEV_GITHUB_TOKEN: 'synthetic-service-credential' } }]);
    const isolated = await credentialBoundary.start(context); assert.equal((await isolated.result).outcome,'succeeded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Git source changes are never silently discarded and nested workspace roots are preserved', { timeout: 20000 }, async () => {
  const f = await setup(1);
  try {
    writeFileSync(join(f.source, 'source.txt'), 'uncommitted source');
    await assert.rejects(prepareExecution(f.workspace, randomUUID(), join(f.root, 'isolated')), (e: any) => e.code === 'WORKSPACE_DIRTY');
    execFileSync('git', ['restore', 'source.txt'], { cwd: f.source, windowsHide: true });
    mkdirSync(join(f.source, 'nested')); writeFileSync(join(f.source, 'nested', 'nested.txt'), 'scoped');
    execFileSync('git', ['add', '.'], { cwd: f.source, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'nested fixture'], { cwd: f.source, windowsHide: true, stdio: 'ignore' });
    const isolated = await prepareExecution({ ...f.workspace, root: join(f.source, 'nested') }, randomUUID(), join(f.root, 'isolated'));
    assert.equal(readFileSync(join(isolated.root, 'nested.txt'), 'utf8'), 'scoped');
    assert.match(isolated.root, /nested$/);
  } finally { await f.close(); }
});
