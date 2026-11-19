import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NativeAdapter, type ExecutionAdapter } from './adapters.js';
import { DomainError, type Actor, type Harness, type Issue, type Run } from './contracts.js';
import { discoverHarnesses, probeHarness } from './harness.js';
import { createServer } from './http.js';
import { Coordinator } from './runner.js';
import { canonical, Store } from './store.js';
import { Workflow } from './workflow.js';

export async function verifyConsult(harness: Harness, bridgeScript: string, controlledAdapter?: ExecutionAdapter) {
  const entry = controlledAdapter ? undefined : discoverHarnesses().find(candidate => candidate.id === harness);
  if (!controlledAdapter && !entry) throw new DomainError('HARNESS_UNAVAILABLE', 'The requested native executable was not found');
  const probe = entry ? await probeHarness(entry) : null;
  if (probe && !probe.available) throw new DomainError('VERSION_PROBE_FAILED', 'The target executable did not report a version');
  const adapter = controlledAdapter ?? new NativeAdapter(() => entry ? [entry] : [], new Set([harness]));
  const root = mkdtempSync(join(tmpdir(), 'agiledev-consult-probe-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const store = new Store(join(root, 'workflow.sqlite'));
  const workflow = new Workflow(store);
  const owner = store.bootstrap().actor;
  const command = (op: string, input: object) => workflow.execute(owner, op, { idempotencyKey: randomUUID(), ...input }) as any;
  let coordinator: Coordinator | undefined;
  const app = createServer(store, undefined, target => coordinator?.canConsult(target) === true);
  const client = new Client({ name: 'agiledev-consult-probe', version: '1' });
  const budgetMs = 90000;
  const expectedReply = 'AGILEDEV_CONSULT_PROBE_OK';
  try {
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    coordinator = new Coordinator(store, { endpoint, directory: join(root, 'runs'), bridgeScript, adapter, concurrency: 1, maxRunMs: budgetMs });
    const { workspace } = command('workspace_register', { root: source, name: 'Disposable consult verification', prefix: 'VCS' });
    const workspaceId = workspace.id as string;
    const enroll = (role: 'lead' | 'worker') => command('actor_enroll', { workspaceId, role, name: `Verification ${role}` }) as { actor: Actor; token: string };
    const lead = enroll('lead');
    const worker = enroll('worker');
    const { issue } = command('issue_create', { workspaceId, title: 'Synthetic reply transport verification', criteria: ['Transport only'] });
    const thread = { workspaceId, issueId: issue.id as string };
    command('issue_assign', { ...thread, expectedVersion: issue.version, actorId: worker.actor.id, harness });
    command('wake_settings_update', { workspaceId, expectedVersion: 0, enabled: true });
    const originalIssue = canonical(store.get<Issue>('issue', issue.id));

    await coordinator.start();
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [bridgeScript, 'mcp'],
      env: { AGILEDEV_ENDPOINT: endpoint, AGILEDEV_TOKEN: lead.token }, stderr: 'pipe'
    }));
    const asked = (await client.callTool({ name: 'message_send', arguments: {
      ...thread, idempotencyKey: randomUUID(), recipient: { kind: 'role', role: 'worker' }, kind: 'QUESTION', wake: true,
      body: `This is a synthetic transport verification. Reply with ${expectedReply} as the complete message body.`
    } })).structuredContent as { message?: { id: string }; delivery?: { state: string; reason?: string; runId?: string } } | undefined;
    if (!asked?.message || asked.delivery?.state !== 'QUEUED' || !asked.delivery.runId) {
      return { status: 'NOT_VERIFIED', harness, reason: asked?.delivery?.reason ?? 'MESSAGE_NOT_QUEUED', retainedEvidenceDirectory: root };
    }
    const runId = asked.delivery.runId;
    const deadline = performance.now() + budgetMs + 5000;
    let response: { status?: string; reply?: { id: string; body: string; sender: { runId?: string } } } | undefined;
    do {
      const timeoutMs = Math.min(50000, Math.max(0, Math.ceil(deadline - performance.now())));
      response = (await client.callTool({
        name: 'message_wait', arguments: { ...thread, questionId: asked.message.id, timeoutMs }
      })).structuredContent as typeof response;
    } while (response?.status === 'TIMED_OUT' && performance.now() < deadline);
    let run = store.get<Run>('run', runId);
    while (['QUEUED', 'STARTING', 'RUNNING', 'STOPPING'].includes(run.state) && performance.now() < deadline) {
      await delay(100);
      run = store.get<Run>('run', runId);
    }
    const reply = response?.reply;
    const workflowUnchanged = canonical(store.get<Issue>('issue', issue.id)) === originalIssue;
    const replyVerified = response?.status === 'REPLIED' && reply?.sender.runId === run.id && reply.body.trim() === expectedReply;
    const passed = run.state === 'SUCCEEDED' && !!run.providerSessionId && replyVerified && workflowUnchanged;
    return {
      status: passed ? controlledAdapter ? 'CONTROLLED_PASS' : 'NATIVE_TARGET_VERIFIED' : 'NOT_VERIFIED',
      harness, version: probe?.version ?? null, source: 'agiledev stdio MCP probe',
      questionId: asked.message.id, runId, runState: run.state, replyId: reply?.id ?? null, workflowUnchanged,
      ...(passed ? {} : { reason: run.errorCode ?? 'CONSULT_EVIDENCE_INCOMPLETE' }),
      retainedEvidenceDirectory: root
    };
  } finally {
    await client.close();
    await coordinator?.close();
    await app.close();
    store.close();
  }
}
