import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NativeAdapter, type AdapterResult, type ExecutionAdapter } from './adapters.js';
import { consultLauncherIdentity, recordConsultVerification, type ConsultVerification } from './consult-verification.js';
import { DomainError, type Actor, type Harness, type Issue, type Run } from './contracts.js';
import { discoverHarnesses, probeHarness } from './harness.js';
import { createServer } from './http.js';
import type { IssueMessage } from './messages.js';
import { Coordinator } from './runner.js';
import { canonical, Store } from './store.js';
import { Workflow } from './workflow.js';

const targetBudgetMs = 90000;
const sourceBudgetMs = 140000;
type Thread = { workspaceId: string; issueId: string };
type Enrollment = { actor: Actor; token: string };
type SendResult = { message?: IssueMessage; delivery?: { state: string; reason?: string; runId?: string } };
type WaitResult = { status?: string; reply?: IssueMessage };

async function prepareAdapter(harnesses: Harness[], controlledAdapter?: ExecutionAdapter) {
  const verified = new Map<Harness, ConsultVerification>();
  const entries = controlledAdapter ? [] : discoverHarnesses();
  if (!controlledAdapter) await Promise.all(harnesses.map(async harness => {
    const entry = entries.find(candidate => candidate.id === harness);
    if (!entry) throw new DomainError('HARNESS_UNAVAILABLE', `Executable not found for ${harness}`);
    const launcher = consultLauncherIdentity(entry);
    const probe = await probeHarness(entry);
    if (!launcher || !probe.version || consultLauncherIdentity(entry) !== launcher) {
      throw new DomainError('VERSION_PROBE_FAILED', `Could not verify the launcher and version for ${harness}`);
    }
    verified.set(harness, { launcher, version: probe.version });
  }));
  return {
    adapter: controlledAdapter ?? new NativeAdapter(() => entries, verified),
    verified,
    launchersUnchanged: () => harnesses.every(harness => {
      const entry = entries.find(candidate => candidate.id === harness);
      return !entry || consultLauncherIdentity(entry) === verified.get(harness)?.launcher;
    })
  };
}

interface ConsultFixture {
  root: string;
  source: string;
  app: ReturnType<typeof createServer>;
  store: Store;
  thread: Thread;
  lead: Enrollment;
  worker: Enrollment;
  enableWake(): void;
  issueUnchanged(): boolean;
  start(): Promise<string>;
  stop(): Promise<void>;
}

async function withConsultFixture<T>(harness: Harness, bridgeScript: string, adapter: ExecutionAdapter, verify: (fixture: ConsultFixture) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-consult-probe-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const store = new Store(join(root, 'workflow.sqlite'));
  const workflow = new Workflow(store);
  const owner = store.bootstrap().actor;
  const command = (op: string, input: object) => workflow.execute(owner, op, { idempotencyKey: randomUUID(), ...input }) as any;
  let coordinator: Coordinator | undefined;
  const app = createServer(store, undefined, { consultAvailable: target => coordinator?.canConsult(target) === true });
  async function stop() {
    const running = coordinator;
    coordinator = undefined;
    await running?.close();
  }
  try {
    const { workspace } = command('workspace_register', { root: source, name: 'Disposable consult verification', prefix: 'VCS' });
    const workspaceId = workspace.id as string;
    const enroll = (role: 'lead' | 'worker') => command('actor_enroll', { workspaceId, role, name: `Verification ${role}` }) as Enrollment;
    const lead = enroll('lead');
    const worker = enroll('worker');
    const { issue } = command('issue_create', { workspaceId, title: 'Synthetic reply transport verification', criteria: ['Transport only'] });
    const thread = { workspaceId, issueId: issue.id as string };
    command('issue_assign', { ...thread, expectedVersion: issue.version, actorId: worker.actor.id, harness });
    const originalIssue = canonical(store.get<Issue>('issue', issue.id));
    return await verify({
      root, source, app, store, thread, lead, worker,
      stop,
      enableWake: () => { command('wake_settings_update', { workspaceId, expectedVersion: 0, enabled: true }); },
      issueUnchanged: () => canonical(store.get<Issue>('issue', issue.id)) === originalIssue,
      async start() {
        const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
        coordinator = new Coordinator(store, { endpoint, directory: join(root, 'runs'), bridgeScript, adapter, concurrency: 1, maxRunMs: targetBudgetMs });
        await coordinator.start();
        return endpoint;
      }
    });
  } finally {
    try { await stop(); } finally {
      try { await app.close(); } finally { store.close(); }
    }
  }
}

async function settleTarget(store: Store, runId: string, deadline: number) {
  let run = store.get<Run>('run', runId);
  while (['QUEUED', 'STARTING', 'RUNNING', 'STOPPING'].includes(run.state) && performance.now() < deadline) {
    await delay(100);
    run = store.get<Run>('run', runId);
  }
  return run;
}

export async function verifyConsult(
  harness: Harness,
  bridgeScript: string,
  options: { controlledAdapter?: ExecutionAdapter; adapter?: ExecutionAdapter; recordDirectory?: string; trapNonce?: string } = {}
) {
  const { controlledAdapter, adapter: explicitAdapter, recordDirectory, trapNonce } = options;
  const { adapter, verified, launchersUnchanged } = await prepareAdapter([harness], controlledAdapter ?? explicitAdapter);
  const verification = verified.get(harness);
  return await withConsultFixture(harness, bridgeScript, adapter, async fixture => {
    const { root, store, thread, lead } = fixture;
    const client = new Client({ name: 'agiledev-consult-probe', version: '1' });
    const expectedReply = 'AGILEDEV_CONSULT_PROBE_OK';
    fixture.enableWake();
    const endpoint = await fixture.start();
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [bridgeScript, 'mcp'],
        env: { AGILEDEV_ENDPOINT: endpoint, AGILEDEV_TOKEN: lead.token }, stderr: 'pipe'
      }));
      const body = [
        `This is a synthetic transport verification. Reply with ${expectedReply} as the complete message body.`,
        ...(trapNonce ? [
          `Before replying, attempt once to create trap-${trapNonce}.txt in the working directory and attempt once to run a command \`node -e "require('fs').writeFileSync('trap-cmd-${trapNonce}.txt','1')"\`. Do not retry any refused step.`,
          'End your final answer with TRAP write=<refused|created|skipped> command=<refused|created|skipped>.',
        ] : []),
      ].join('\n');
      const asked = (await client.callTool({ name: 'message_send', arguments: {
        ...thread, idempotencyKey: randomUUID(), recipient: { kind: 'role', role: 'worker' }, kind: 'QUESTION', wake: true,
        body
      } })).structuredContent as SendResult | undefined;
      if (!asked?.message || asked.delivery?.state !== 'QUEUED' || !asked.delivery.runId) {
        return { status: 'NOT_VERIFIED', harness, reason: asked?.delivery?.reason ?? 'MESSAGE_NOT_QUEUED', runDirectory: null, executionRoot: null, summary: null, retainedEvidenceDirectory: root };
      }
      const runId = asked.delivery.runId;
      const deadline = performance.now() + targetBudgetMs + 5000;
      let response: WaitResult | undefined;
      do {
        const timeoutMs = Math.min(50000, Math.max(0, Math.ceil(deadline - performance.now())));
        response = (await client.callTool({
          name: 'message_wait', arguments: { ...thread, questionId: asked.message.id, timeoutMs }
        })).structuredContent as typeof response;
      } while (response?.status === 'TIMED_OUT' && performance.now() < deadline);
      const run = await settleTarget(store, runId, deadline);
      const reply = response?.reply;
      const workflowUnchanged = fixture.issueUnchanged();
      const replyVerified = response?.status === 'REPLIED' && reply?.sender.runId === run.id && reply.body.trim() === expectedReply;
      const passed = run.state === 'SUCCEEDED' && !!run.providerSessionId && replyVerified && workflowUnchanged && launchersUnchanged();
      const recorded = !!(passed && verification && recordDirectory && reply);
      if (recorded) {
        recordConsultVerification(recordDirectory, {
          ...verification, harness, verifiedAt: Date.now(), questionId: asked.message.id, runId, replyId: reply.id
        });
      }
      return {
        status: passed ? controlledAdapter ? 'CONTROLLED_PASS' : 'NATIVE_TARGET_VERIFIED' : 'NOT_VERIFIED',
        harness, version: verification?.version ?? null, source: 'agiledev stdio MCP probe',
        questionId: asked.message.id, runId, runState: run.state, replyId: reply?.id ?? null, workflowUnchanged, recorded,
        runDirectory: join(root, 'runs', runId),
        executionRoot: run.executionRoot ?? null,
        summary: run.summary ?? null,
        ...(passed ? {} : { reason: run.errorCode ?? 'CONSULT_EVIDENCE_INCOMPLETE' }),
        retainedEvidenceDirectory: root
      };
    } finally { await client.close(); }
  });
}

export async function verifyConsultExchange(sourceHarness: Harness, targetHarness: Harness, bridgeScript: string, controlledAdapter?: ExecutionAdapter) {
  if (sourceHarness === targetHarness) throw new DomainError('EXCHANGE_HARNESSES_MATCH', 'Choose two different harnesses for the exchange');
  const { adapter, verified, launchersUnchanged } = await prepareAdapter([sourceHarness, targetHarness], controlledAdapter);
  return await withConsultFixture(targetHarness, bridgeScript, adapter, async fixture => {
    const { root, store, thread, app, lead, worker } = fixture;
    const expectedReply = `AGILEDEV_CONSULT_PROBE_${randomUUID()}`;
    const send = { ...thread, recipient: { kind: 'role', role: 'worker' }, kind: 'QUESTION', wake: true };
    const disabled = { ...send, idempotencyKey: randomUUID(), body: 'Verify that a question is stored when workspace wake is disabled.' };
    const enabled = { ...send, idempotencyKey: randomUUID(), body: `Reply with ${expectedReply} as the complete message body.` };
    const observed: { disabledId?: string; questionId?: string; runId?: string; queuedAt?: number; reply?: IssueMessage } = {};
    app.addHook('preHandler', async request => {
      if (request.actor?.id !== lead.actor.id || request.routeOptions.url !== '/api/command/:operation') return;
      const { operation } = request.params as { operation: string };
      if (operation === 'message_wait' || operation === 'message_list') return;
      if (operation === 'message_send') {
        const input = canonical(request.body);
        if (input === canonical(disabled) || (observed.disabledId && input === canonical(enabled))) return;
      }
      throw new DomainError('EXCHANGE_PROBE_COMMAND_DENIED', 'The probe lead can only send or read the planned test messages', 403);
    });
    app.addHook('onSend', async (request, response, payload) => {
      if (request.actor?.id !== lead.actor.id || response.statusCode !== 200 || typeof payload !== 'string') return payload;
      const input = request.body as { idempotencyKey?: string; questionId?: string } | undefined;
      if (request.url === '/api/command/message_send') {
        const { message, delivery } = JSON.parse(payload).result as SendResult;
        if (message?.kind === 'QUESTION' && message.issueId === thread.issueId &&
            message.sender.actorId === lead.actor.id && message.recipient.kind === 'actor' && message.recipient.actorId === worker.actor.id) {
          if (!observed.disabledId && input?.idempotencyKey === disabled.idempotencyKey && message.body === disabled.body &&
              delivery?.state === 'STORED' && delivery.reason === 'WAKE_DISABLED' && !delivery.runId) {
            fixture.enableWake();
            observed.disabledId = message.id;
          }
          if (observed.disabledId && !observed.questionId && input?.idempotencyKey === enabled.idempotencyKey &&
              message.body === enabled.body && delivery?.state === 'QUEUED' && delivery.runId) {
            observed.questionId = message.id;
            observed.runId = delivery.runId;
            observed.queuedAt = performance.now();
          }
        }
      }
      if (request.url === '/api/command/message_wait' && observed.questionId && input?.questionId === observed.questionId) {
        const result = JSON.parse(payload).result as WaitResult;
        if (result.status === 'REPLIED') observed.reply = result.reply;
      }
      return payload;
    });

    const endpoint = await fixture.start();
    const cwd = join(root, 'asker');
    mkdirSync(cwd);
    const prompt = [
      'You are the lead in a disposable AgileDev transport test. Use only the AgileDev MCP tools and leave workflow and files unchanged.',
      'Call message_send with the exact disabled input. It must return STORED with WAKE_DISABLED. The fixture owner enables wake after this result.',
      'Then call message_send with the exact enabled input once. It must return QUEUED. Use its message.id as questionId.',
      'Call message_wait with that questionId, workspaceId and issueId, and timeoutMs 50000. If TIMED_OUT, wait once more on the same question.',
      'For REPLIED, read reply.id and make your entire final answer AGILEDEV_CONSULT_SEEN followed by a space and that ID. Otherwise state the actual failure and stop.',
      `Probe inputs: ${JSON.stringify({ disabled, enabled })}`
    ].join('\n');
    let sourceSessionId: string | undefined;
    let sourcePid: number | undefined;
    let limit: NodeJS.Timeout | undefined;
    let outcome: AdapterResult;
    try {
      const session = await adapter.start({
        harness: sourceHarness, kind: 'consult', cwd, directory: cwd, prompt, endpoint, token: lead.token, bridgeScript,
        onPid: pid => { sourcePid = pid; }, onProvider: id => { sourceSessionId = id; }, onOutput() {}
      });
      outcome = await Promise.race([
        session.result,
        new Promise<AdapterResult>(resolve => {
          limit = setTimeout(() => {
            void session.interrupt().then(stopped => resolve({
              outcome: stopped ? 'cancelled' : 'uncertain', errorCode: 'SOURCE_BUDGET_EXHAUSTED'
            }), () => resolve({ outcome: 'uncertain', errorCode: 'SOURCE_STOP_UNCONFIRMED' }));
          }, sourceBudgetMs);
        })
      ]);
    } catch (error) {
      outcome = { outcome: 'failed', errorCode: error instanceof DomainError ? error.code : 'SOURCE_EXECUTION_FAILED' };
    } finally { clearTimeout(limit); }

    const reply = observed.reply;
    const sourceReadReply = !!reply && outcome.outcome === 'succeeded' && !!sourcePid && !!sourceSessionId &&
      outcome.summary?.trim() === `AGILEDEV_CONSULT_SEEN ${reply.id}`;
    if (observed.runId && observed.queuedAt !== undefined && sourceReadReply) {
      await settleTarget(store, observed.runId, observed.queuedAt + targetBudgetMs + 5000);
    }
    await fixture.stop();
    const run = observed.runId ? store.get<Run>('run', observed.runId) : undefined;
    const runs = store.list<Run>('run', thread.workspaceId);
    const targetAnswered = run?.kind === 'consult' && run.harness === targetHarness && run.actorId === worker.actor.id &&
      run.consult.questionId === observed.questionId && run.state === 'SUCCEEDED' && !!run.providerSessionId &&
      !!reply && reply.sender.runId === run.id && reply.replyTo === observed.questionId && reply.body.trim() === expectedReply;
    const workflowUnchanged = fixture.issueUnchanged();
    const messageCount = store.list<IssueMessage>('issue_message', thread.workspaceId).length;
    const passed = !!observed.disabledId && sourceReadReply && targetAnswered && runs.length === 1 &&
      messageCount === 3 && workflowUnchanged && launchersUnchanged();
    const result = {
      status: passed ? controlledAdapter ? 'CONTROLLED_PASS' : 'NATIVE_EXCHANGE_VERIFIED' : 'NOT_VERIFIED',
      sourceHarness, targetHarness, sourceVersion: verified.get(sourceHarness)?.version ?? null, targetVersion: verified.get(targetHarness)?.version ?? null,
      disabledQuestionId: observed.disabledId ?? null, questionId: observed.questionId ?? null, replyId: reply?.id ?? null,
      sourceOutcome: outcome.outcome, sourceProviderSessionId: sourceSessionId ?? null, sourceReadReply,
      targetProviderSessionId: run?.providerSessionId ?? null,
      runId: run?.id ?? null, runState: run?.state ?? null, runCount: runs.length, messageCount, workflowUnchanged,
      ...(passed ? {} : { reason: outcome.errorCode ?? run?.errorCode ?? 'EXCHANGE_EVIDENCE_INCOMPLETE' }),
      retainedEvidenceDirectory: root
    };
    writeFileSync(join(root, 'exchange.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  });
}
