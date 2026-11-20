import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AdapterContext, AdapterResult, ExecutionAdapter } from '../src/adapters.js';
import { LocalClient } from '../src/client.js';
import { DomainError, type Actor, type Harness, type Issue, type Run } from '../src/contracts.js';
import { createServer } from '../src/http.js';
import { Coordinator } from '../src/runner.js';
import { canonical, Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { verifyConsult, verifyConsultExchange } from '../src/verify-consult.js';

class ConsultAdapter implements ExecutionAdapter {
  supported = new Set<Harness>(['codex', 'dsh', 'claude-code']);
  calls: { context: AdapterContext; finish(result: AdapterResult): void }[] = [];
  supportsConsult(harness: Harness) { return this.supported.has(harness); }
  async start(context: AdapterContext) {
    assert.equal(context.kind, 'consult');
    context.onProvider(`controlled-session-${this.calls.length}`);
    let finish!: (result: AdapterResult) => void;
    const result = new Promise<AdapterResult>(resolve => { finish = resolve; });
    this.calls.push({ context, finish });
    return { result, interrupt: async () => { finish({ outcome: 'cancelled', errorCode: 'INTERRUPTED' }); return true; } };
  }
}

const role = (role: string) => ({ kind: 'role', role });
const actorTarget = (actor: Actor) => ({ kind: 'actor', actorId: actor.principalId ?? actor.id });
const fails = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-consult-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const store = new Store(':memory:');
  const adapter = new ConsultAdapter();
  let now = Date.parse('2026-11-19T00:00:00.000Z');
  const flow = new Workflow(store, () => now, harness => adapter.supportsConsult(harness));
  const owner = store.bootstrap();
  const write = (actor: Actor, op: string, input: object) =>
    flow.execute(actor, op, { idempotencyKey: randomUUID(), ...input }) as any;
  const { workspace } = write(owner.actor, 'workspace_register', { root: source, name: 'Controlled consult workspace', prefix: 'CST' });
  const enroll = (role: string) => write(owner.actor, 'actor_enroll', { workspaceId: workspace.id, role, name: `Test ${role}` }) as { actor: Actor; token: string };
  const lead = enroll('lead'), worker = enroll('worker'), qa = enroll('qa'), pm = enroll('pm');
  const { issue } = write(owner.actor, 'issue_create', { workspaceId: workspace.id, title: 'Consult fixture', criteria: ['C1'] });
  const thread = { workspaceId: workspace.id, issueId: issue.id };
  const current = () => store.get<Issue>('issue', issue.id);
  write(owner.actor, 'issue_assign', { ...thread, expectedVersion: current().version, actorId: worker.actor.id, harness: 'dsh' });
  const { profile } = write(owner.actor, 'check_profile_create', {
    workspaceId: workspace.id, name: 'Test profile', command: process.execPath, args: ['--version'], criteria: ['C1'], timeoutMs: 5000
  });
  write(owner.actor, 'qa_configure', { ...thread, expectedVersion: current().version, actorId: qa.actor.id, harness: 'claude-code', checkProfileIds: [profile.id] });
  let coordinator: Coordinator | undefined;
  const app = createServer(store, undefined, harness => coordinator?.canConsult(harness) === true);
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  coordinator = new Coordinator(store, { endpoint, directory: join(root, 'runs'), bridgeScript: resolve('dist/cli.js'), adapter, concurrency: 1, now: () => now });
  t.after(async () => {
    await coordinator!.close();
    await app.close();
    store.close();
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('agiledev-consult-'));
    rmSync(root, { recursive: true, force: true });
  });
  const setting = (enabled: boolean, expectedVersion = 0) => write(owner.actor, 'wake_settings_update', { workspaceId: workspace.id, enabled, expectedVersion });
  const send = (actor: Actor, recipient: object, input: object = {}) =>
    write(actor, 'message_send', { ...thread, recipient, kind: 'QUESTION', wake: true, body: 'Fixture question', ...input });
  const runs = () => store.list<Run>('run', workspace.id);
  const run = (id: string) => store.get<Run>('run', id);
  return { thread, store, adapter, flow, endpoint, coordinator, owner, lead, worker, pm, qa, current, write, setting, send, runs, run, advance: (ms: number) => { now += ms; } };
}

async function bridge(endpoint: string, token: string, name: string) {
  const client = new Client({ name, version: 'fixture' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('dist/cli.js'), 'mcp'],
    env: { AGILEDEV_ENDPOINT: endpoint, AGILEDEV_TOKEN: token }, stderr: 'pipe'
  });
  await client.connect(transport);
  return client;
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await delay(15);
  }
  assert.fail('Controlled run failed to settle');
}

test('consult routes through real MCP and HTTP with a separately scoped credential', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const lead = await bridge(f.endpoint, f.lead.token, 'codex');
  let recipient: Client | undefined;
  try {
    f.setting(true);
    const initialIssue = canonical(f.current());
    f.send(f.lead.actor, role('qa'), { kind: 'NOTE', wake: false, body: 'QA_PRIVATE_MARKER' });
    const args = { ...f.thread, recipient: role('worker'), kind: 'QUESTION', wake: true, body: 'QUESTION_MARKER', idempotencyKey: randomUUID() };
    const asked = (await lead.callTool({ name: 'message_send', arguments: args })).structuredContent as any;
    const delivery = asked.delivery;
    assert.equal(delivery.state, 'QUEUED');
    assert.equal(delivery.harness, 'dsh');
    assert.equal((await lead.callTool({ name: 'message_send', arguments: args })).structuredContent?.replayed, true);
    await f.coordinator.tick();
    assert.equal(f.adapter.calls.length, 1);
    const { context, finish } = f.adapter.calls[0]!;
    assert.equal(context.harness, 'dsh');
    assert.deepEqual(readdirSync(context.cwd), []);
    assert.ok(context.prompt.includes('QUESTION_MARKER'));
    assert.ok(!context.prompt.includes('QA_PRIVATE_MARKER'));
    const consultActor = f.store.authenticate(context.token);
    assert.equal(consultActor.principalId, f.worker.actor.id);
    assert.notEqual(consultActor.id, f.worker.actor.id);
    const direct = new LocalClient(f.endpoint, context.token);
    assert.equal((await direct.request('/api/session')).profile, 'consult');
    await assert.rejects(direct.command('work_submit', {}), fails('ROLE_DENIED'));
    await assert.rejects(direct.command('issue_list', { workspaceId: f.thread.workspaceId }), fails('ROLE_DENIED'));
    recipient = await bridge(f.endpoint, context.token, 'dsh');
    const catalog = (await recipient.listTools()).tools;
    assert.ok(catalog.some(tool => tool.name === 'message_send'));
    assert.ok(!catalog.some(tool => tool.name === 'work_submit'));
    const nested = await direct.command('message_send', {
      ...f.thread, idempotencyKey: randomUUID(), recipient: role('lead'), kind: 'QUESTION', wake: true, body: 'No nested launch'
    });
    assert.equal(nested.delivery.reason, 'WAKE_NESTED');
    assert.equal(f.runs().length, 1);
    const waiting = lead.callTool({ name: 'message_wait', arguments: { ...f.thread, questionId: asked.message.id, timeoutMs: 4000 } });
    const sent = await recipient.callTool({ name: 'message_send', arguments: {
      ...f.thread, recipient: actorTarget(f.lead.actor), kind: 'REPLY', replyTo: asked.message.id,
      body: 'Controlled software answer', idempotencyKey: randomUUID()
    } });
    assert.notEqual(sent.isError, true);
    assert.equal((await waiting).structuredContent?.status, 'REPLIED');
    finish({ outcome: 'succeeded' });
    await until(() => f.run(delivery.runId).state === 'SUCCEEDED');
    const result = await new LocalClient(f.endpoint, f.lead.token).command('message_list', f.thread);
    assert.equal(result.messages.find((message: any) => message.id === asked.message.id).delivery.state, 'REPLIED');
    assert.equal(canonical(f.current()), initialIssue);
    assert.equal(f.store.list('approval').length, 0);
    await assert.rejects(direct.command('message_list', f.thread), fails('UNAUTHENTICATED'));
  } finally {
    await recipient?.close();
    await lead.close();
  }
});

test('wake admission honors workspace settings, capability, day quota and active slots', async t => {
  const f = await fixture(t);
  assert.equal(f.send(f.lead.actor, role('worker')).delivery.reason, 'WAKE_DISABLED');
  f.setting(true);
  f.adapter.supported.delete('dsh');
  assert.equal(f.send(f.lead.actor, role('worker')).delivery.reason, 'WAKE_UNAVAILABLE');
  f.adapter.supported.add('dsh');
  const one = f.send(f.lead.actor, role('worker'));
  const two = f.send(f.lead.actor, role('worker'));
  const three = f.send(f.lead.actor, role('worker'));
  assert.equal(f.send(f.lead.actor, role('worker')).delivery.reason, 'WAKE_BUDGET_EXHAUSTED');
  await f.coordinator.tick();
  assert.equal(f.coordinator.activeCount, 1);
  assert.equal(f.run(one.delivery.runId).budgetMs, 600000);
  assert.equal(f.run(two.delivery.runId).state, 'QUEUED');
  f.setting(false, 1);
  f.advance(600001);
  await f.coordinator.tick();
  await until(() => f.run(one.delivery.runId).state === 'CANCELLED');
  assert.equal(f.run(one.delivery.runId).errorCode, 'RUN_TIME_BUDGET');
  await f.coordinator.tick();
  await f.coordinator.tick();
  assert.equal(f.run(two.delivery.runId).errorCode, 'WAKE_DISABLED');
  assert.equal(f.run(three.delivery.runId).errorCode, 'WAKE_DISABLED');
  assert.equal(f.adapter.calls.length, 1);
  f.setting(true, 2);
  f.advance(24 * 3600000);
  assert.equal(f.send(f.lead.actor, role('worker')).delivery.state, 'QUEUED');
});

test('lead and PM wake routes use the latest logical connection and preserve failed run evidence', async t => {
  const f = await fixture(t);
  f.setting(true);
  const pm = new LocalClient(f.endpoint, f.pm.token);
  assert.equal(f.send(f.worker.actor, role('pm')).delivery.reason, 'WAKE_UNAVAILABLE');
  await pm.request('/api/connection', { name: 'codex-mcp-client', version: 'fixture' });
  const asked = f.send(f.worker.actor, role('pm'));
  assert.equal(asked.delivery.harness, 'codex');
  await f.coordinator.tick();
  assert.equal(f.adapter.calls[0]!.context.harness, 'codex');
  const scopedPm = new LocalClient(f.endpoint, f.adapter.calls[0]!.context.token);
  await assert.rejects(scopedPm.command('issue_update', {}), fails('ROLE_DENIED'));
  f.adapter.calls[0]!.finish({ outcome: 'failed', errorCode: 'AUTHENTICATION_REQUIRED' });
  await until(() => f.run(asked.delivery.runId).state === 'FAILED');
  const result = await new LocalClient(f.endpoint, f.worker.token).command('message_wait', {
    ...f.thread, questionId: asked.message.id, timeoutMs: 50
  });
  assert.equal(result.delivery.reason, 'AUTHENTICATION_REQUIRED');
  await f.coordinator.tick();
  assert.equal(f.adapter.calls.length, 1);
  await pm.request('/api/connection', { name: 'unrecognized fixture', version: 'fixture' });
  assert.equal(f.send(f.worker.actor, role('pm')).delivery.reason, 'WAKE_UNAVAILABLE');
});

test('consults do not lock ordinary planning and changed scope prevents a queued launch', async t => {
  const f = await fixture(t);
  f.setting(true);
  const queued = f.send(f.lead.actor, role('worker'));
  f.write(f.lead.actor, 'design_set', { ...f.thread, expectedVersion: f.current().version, content: 'Draft fixture revision', criteria: ['C1'] });
  await f.coordinator.tick();
  assert.equal(f.run(queued.delivery.runId).state, 'FAILED');
  assert.equal(f.run(queued.delivery.runId).errorCode, 'CONSULT_STALE');
  assert.equal(f.adapter.calls.length, 0);
  assert.equal(f.current().state, 'NOT_STARTED');
});

test('a consult provider exit without a tool reply is reported as unanswered', async t => {
  const f = await fixture(t);
  f.setting(true);
  const asked = f.send(f.lead.actor, role('qa'));
  assert.equal(asked.delivery.harness, 'claude-code');
  await f.coordinator.tick();
  const scopedQa = new LocalClient(f.endpoint, f.adapter.calls[0]!.context.token);
  await assert.rejects(scopedQa.command('qa_report_submit', {}), fails('ROLE_DENIED'));
  f.adapter.calls[0]!.finish({ outcome: 'succeeded', summary: 'Final text, no tool reply' });
  await until(() => f.run(asked.delivery.runId).state === 'FAILED');
  const outcome = await new LocalClient(f.endpoint, f.lead.token).command('message_wait', {
    ...f.thread, questionId: asked.message.id, timeoutMs: 100
  });
  assert.equal(outcome.status, 'UNANSWERED');
  assert.equal(outcome.delivery.reason, 'CONSULT_REPLY_REQUIRED');
  assert.equal(f.store.list('qa_report').length, 0);
  assert.equal(f.adapter.calls.length, 1);
});

test('an uncertain consult remains auditable and is never started again', async t => {
  const f = await fixture(t);
  f.setting(true);
  const asked = f.send(f.lead.actor, role('worker'));
  await f.coordinator.tick();
  f.adapter.calls[0]!.finish({ outcome: 'uncertain', errorCode: 'STOP_UNCONFIRMED' });
  await until(() => f.run(asked.delivery.runId).state === 'UNCERTAIN');
  assert.equal(f.send(f.lead.actor, role('worker')).delivery.reason, 'WAKE_UNCERTAIN');
  await f.coordinator.tick();
  assert.equal(f.runs().length, 1);
  assert.equal(f.adapter.calls.length, 1);
  assert.equal(f.current().state, 'NOT_STARTED');
});

test('already answered consults cancel before launch and leave no live coordinator entry', async t => {
  const f = await fixture(t);
  f.setting(true);
  const asked = f.send(f.lead.actor, role('worker'));
  f.send(f.worker.actor, actorTarget(f.lead.actor), { kind: 'REPLY', replyTo: asked.message.id, wake: false });
  await f.coordinator.tick();
  assert.equal(f.run(asked.delivery.runId).state, 'CANCELLED');
  assert.equal(f.run(asked.delivery.runId).errorCode, 'QUESTION_ALREADY_ANSWERED');
  assert.equal(f.adapter.calls.length, 0);
  assert.equal(f.coordinator['live'].size, 0);
});

test('unavailable queued launches preserve the daily budget when the target recovers', async t => {
  const f = await fixture(t);
  f.setting(true);
  const queued = Array.from({ length: 3 }, () => f.send(f.lead.actor, role('worker')));
  f.adapter.supported.delete('dsh');
  for (const question of queued) {
    await f.coordinator.tick();
    assert.equal(f.run(question.delivery.runId).errorCode, 'HARNESS_UNAVAILABLE');
  }
  assert.equal(f.adapter.calls.length, 0);
  assert.equal(f.send(f.lead.actor, role('worker')).delivery.reason, 'WAKE_UNAVAILABLE');
  f.adapter.supported.add('dsh');
  assert.equal(f.send(f.lead.actor, role('worker')).delivery.state, 'QUEUED');
});

test('a reply arriving during the launcher version check prevents native consult spawn', async t => {
  const f = await fixture(t);
  const start = f.adapter.start.bind(f.adapter);
  let release!: () => void;
  const preflight = new Promise<void>(resolve => { release = resolve; });
  f.adapter.start = async context => {
    await preflight;
    context.checkBeforeSpawn?.();
    return start(context);
  };
  f.setting(true);
  const asked = f.send(f.lead.actor, role('worker'));
  try {
    await f.coordinator.tick();
    assert.equal(f.run(asked.delivery.runId).state, 'RUNNING');
    f.send(f.worker.actor, actorTarget(f.lead.actor), { kind: 'REPLY', replyTo: asked.message.id, wake: false });
  } finally { release(); }
  await until(() => f.run(asked.delivery.runId).state === 'CANCELLED');
  assert.equal(f.run(asked.delivery.runId).errorCode, 'QUESTION_ALREADY_ANSWERED');
  assert.equal(f.adapter.calls.length, 0);
});

test('an admitted consult wait ends when its issue scope changes', async t => {
  const f = await fixture(t);
  f.setting(true);
  const asked = f.send(f.lead.actor, role('worker'));
  await f.coordinator.tick();
  const actor = f.store.authenticate(f.adapter.calls[0]!.context.token);
  const followup = f.send(actor, role('lead'), { wake: false });
  const pending = f.flow.execute(actor, 'message_wait', { ...f.thread, questionId: followup.message.id, timeoutMs: 2000 }) as Promise<unknown>;
  const denied = assert.rejects(pending, fails('CONSULT_STALE'));
  f.write(f.owner.actor, 'issue_update', {
    ...f.thread, expectedVersion: f.current().version, description: 'A changed fixture scope'
  });
  await denied;
  assert.equal(f.run(asked.delivery.runId).state, 'RUNNING');
});

test('the disposable consult probe labels controlled proof separately from native verification', { timeout: 10000 }, async () => {
  let launches = 0;
  const adapter: ExecutionAdapter = {
    supportsConsult: harness => harness === 'dsh',
    async start(context) {
      launches++;
      context.onProvider('controlled-probe-session');
      const line = context.prompt.split('\n').find(value => value.startsWith('Reply arguments: '));
      assert.ok(line);
      const args = JSON.parse(line.slice('Reply arguments: '.length, -'. Add your answer as body.'.length));
      const result = new LocalClient(context.endpoint, context.token).command('message_send', {
        ...args, body: 'AGILEDEV_CONSULT_PROBE_OK'
      }).then(() => ({ outcome: 'succeeded' as const }));
      return { result, interrupt: async () => true };
    }
  };
  const recordDirectory = join(tmpdir(), `agiledev-controlled-no-record-${randomUUID()}`);
  const observed = await verifyConsult('dsh', resolve('dist/cli.js'), { controlledAdapter: adapter, recordDirectory });
  try {
    assert.equal(observed.status, 'CONTROLLED_PASS');
    assert.equal(observed.version, null);
    assert.equal(observed.workflowUnchanged, true);
    assert.ok(observed.replyId);
    assert.equal(launches, 1);
    assert.equal(observed.recorded, false);
    assert.equal(existsSync(recordDirectory), false);
  } finally {
    const root = observed.retainedEvidenceDirectory;
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('agiledev-consult-probe-'));
    rmSync(root, { recursive: true, force: true });
  }
});

for (const waitForReply of [true, false]) {
  test(`the exchange probe ${waitForReply ? 'proves both authenticated MCP endpoints' : 'rejects a reply ID obtained without message_wait'}`, { timeout: 15000 }, async () => {
    const launches: Harness[] = [];
    const adapter: ExecutionAdapter = {
      supportsConsult: harness => harness === 'dsh',
      async start(context) {
        launches.push(context.harness);
        context.onPid(process.pid);
        context.onProvider(`controlled-${context.harness}`);
        const result = (async (): Promise<AdapterResult> => {
          const client = await bridge(context.endpoint, context.token, context.harness);
          try {
            if (context.harness === 'dsh') {
              const replyLine = context.prompt.split('\n').find(line => line.startsWith('Reply arguments: '));
              const marker = context.prompt.match(/AGILEDEV_CONSULT_PROBE_[a-f0-9-]{36}/)?.[0];
              assert.ok(replyLine);
              assert.ok(marker);
              const arguments_ = JSON.parse(replyLine.slice('Reply arguments: '.length, -'. Add your answer as body.'.length));
              const result = await client.callTool({ name: 'message_send', arguments: { ...arguments_, body: marker } });
              assert.ok(result.structuredContent?.message);
              return { outcome: 'succeeded' };
            }
            const probeLine = context.prompt.split('\n').find(line => line.startsWith('Probe inputs: '));
            assert.ok(probeLine);
            const { disabled, enabled } = JSON.parse(probeLine.slice('Probe inputs: '.length));
            const premature = await client.callTool({ name: 'message_send', arguments: enabled });
            assert.equal(premature.isError, true);
            const off = (await client.callTool({ name: 'message_send', arguments: disabled })).structuredContent as any;
            assert.deepEqual(off.delivery, { state: 'STORED', reason: 'WAKE_DISABLED' });
            const on = (await client.callTool({ name: 'message_send', arguments: enabled })).structuredContent as any;
            assert.equal(on.delivery.state, 'QUEUED');
            const thread = { workspaceId: enabled.workspaceId, issueId: enabled.issueId };
            const replay = (await client.callTool({ name: 'message_send', arguments: enabled })).structuredContent as any;
            assert.equal(replay.replayed, true);
            assert.equal(replay.delivery.runId, on.delivery.runId);
            await assert.rejects(new LocalClient(context.endpoint, context.token).command('message_send', {
              ...enabled, idempotencyKey: randomUUID(), body: 'This must never launch a second target'
            }), fails('EXCHANGE_PROBE_COMMAND_DENIED'));
            let replyId: string | undefined;
            if (waitForReply) {
              const waited = (await client.callTool({
                name: 'message_wait', arguments: { ...thread, questionId: on.message.id, timeoutMs: 4000 }
              })).structuredContent as any;
              assert.equal(waited.status, 'REPLIED');
              replyId = waited.reply.id;
            } else {
              for (let attempt = 0; attempt < 40 && !replyId; attempt++) {
                const listed = (await client.callTool({ name: 'message_list', arguments: thread })).structuredContent as any;
                replyId = listed.messages.find((message: any) => message.replyTo === on.message.id)?.id;
                if (!replyId) await delay(75);
              }
            }
            assert.ok(replyId);
            return { outcome: 'succeeded', summary: `AGILEDEV_CONSULT_SEEN ${replyId}` };
          } finally { await client.close(); }
        })();
        return { result, interrupt: async () => true };
      }
    };
    const observed = await verifyConsultExchange('codex', 'dsh', resolve('dist/cli.js'), adapter);
    const root = observed.retainedEvidenceDirectory;
    try {
      assert.deepEqual(launches, ['codex', 'dsh']);
      assert.equal(observed.status, waitForReply ? 'CONTROLLED_PASS' : 'NOT_VERIFIED');
      assert.equal(observed.sourceReadReply, waitForReply);
      assert.equal(observed.workflowUnchanged, true);
      assert.equal(observed.runCount, 1);
      assert.equal(observed.messageCount, 3);
      assert.ok(observed.disabledQuestionId);
      assert.ok(observed.questionId);
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'exchange.json'), 'utf8')), observed);
    } finally {
      assert.equal(dirname(root), resolve(tmpdir()));
      assert.ok(basename(root).startsWith('agiledev-consult-probe-'));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
