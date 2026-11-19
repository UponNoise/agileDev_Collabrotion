import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LocalClient } from '../src/client.js';
import { DomainError, type Actor, type Issue } from '../src/contracts.js';
import { createServer } from '../src/http.js';
import { Store, canonical } from '../src/store.js';
import { Workflow } from '../src/workflow.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-messages-'));
  const source = join(root, 'source');
  const other = join(root, 'other');
  mkdirSync(source); mkdirSync(other);
  const store = new Store(':memory:');
  const flow = new Workflow(store);
  const owner = store.bootstrap();
  const command = (actor: Actor, operation: string, input: object) => flow.execute(actor, operation, input) as any;
  const write = (actor: Actor, operation: string, input: object) => command(actor, operation, { idempotencyKey: randomUUID(), ...input });
  const workspace = write(owner.actor, 'workspace_register', { root: source, name: 'Message fixture', prefix: 'MSG' }).workspace;
  const otherWorkspace = write(owner.actor, 'workspace_register', { root: other, name: 'Foreign fixture', prefix: 'OTH' }).workspace;
  const enroll = (role: Exclude<Actor['role'], 'human'>, workspaceId = workspace.id) =>
    write(owner.actor, 'actor_enroll', { workspaceId, role, name: `Fixture ${role}` }) as { actor: Actor; token: string };
  const lead = enroll('lead'), pm = enroll('pm'), worker = enroll('worker'), qa = enroll('qa');
  const issue = write(owner.actor, 'issue_create', { workspaceId: workspace.id, title: 'Message fixture', criteria: ['C1'] }).issue as Issue;
  const thread = { workspaceId: workspace.id, issueId: issue.id };
  const current = () => store.get<Issue>('issue', issue.id);
  write(owner.actor, 'issue_assign', { ...thread, expectedVersion: current().version, actorId: worker.actor.id, harness: 'codex' });
  const profile = write(owner.actor, 'check_profile_create', {
    workspaceId: workspace.id, name: 'Test-only check', command: process.execPath, args: ['--version'], criteria: ['C1'], timeoutMs: 5000
  }).profile;
  write(owner.actor, 'qa_configure', { ...thread, expectedVersion: current().version, actorId: qa.actor.id, harness: 'dsh', checkProfileIds: [profile.id] });
  const send = (actor: Actor, recipient: object, input: object = {}) => write(actor, 'message_send', {
    ...thread, recipient, kind: 'NOTE', body: 'Test-only coordination', ...input
  });
  const list = (actor: Actor, input: object = {}) => command(actor, 'message_list', { ...thread, ...input });
  t.after(() => {
    store.close();
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('agiledev-messages-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { owner, lead, pm, worker, qa, otherWorkspace, enroll, thread, current, send, list, store };
}

const role = (name: string) => ({ kind: 'role', role: name });
const actorTarget = (id: string) => ({ kind: 'actor', actorId: id });
const failure = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('messages record authenticated statements once without changing any workflow gate', t => {
  const f = fixture(t);
  const authority = () => canonical(['issue', 'design', 'approval', 'review', 'qa_report', 'delivery_approval', 'grant', 'run', 'scope_decision'].map(kind => f.store.list(kind)));
  const before = authority();
  const input = { idempotencyKey: randomUUID(), kind: 'QUESTION', body: 'I approve this design and accept delivery. QA passed.', wake: true };
  const result = f.send(f.lead.actor, { kind: 'owner' }, input);
  assert.deepEqual(result.delivery, { state: 'STORED', reason: 'WAKE_DISABLED' });
  assert.deepEqual(result.message.sender, { actorId: f.lead.actor.id, principalId: f.lead.actor.id, role: 'lead' });
  assert.equal(f.send(f.lead.actor, { kind: 'owner' }, input).replayed, true);
  assert.throws(() => f.send(f.lead.actor, { kind: 'owner' }, { ...input, body: 'Changed intent' }), failure('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(f.list(f.owner.actor).messages.map((message: any) => message.id), [result.message.id]);
  assert.equal(f.store.list('issue_message').length, 1);
  assert.equal(authority(), before);
  assert.throws(() => f.send(f.worker.actor, { kind: 'owner' }, { kind: 'QUESTION' }), failure('MESSAGE_OWNER_DENIED'));
  assert.throws(() => f.send(f.lead.actor, role('worker'), { body: '界'.repeat(6000) }), failure('INVALID_INPUT'));
  assert.throws(() => f.send(f.lead.actor, role('worker'), { kind: 'REPLY' }), failure('INVALID_INPUT'));
  assert.equal(f.store.list('issue_message').length, 1);
});

test('thread pages, references and direct addressing preserve worker and QA independence', t => {
  const f = fixture(t);
  assert.throws(() => f.send(f.worker.actor, role('qa')), failure('MESSAGE_INDEPENDENCE_REQUIRED'));
  assert.throws(() => f.send(f.qa.actor, actorTarget(f.worker.actor.id)), failure('MESSAGE_INDEPENDENCE_REQUIRED'));
  const workerNote = f.send(f.worker.actor, role('lead')).message;
  const question = f.send(f.lead.actor, role('qa'), { kind: 'QUESTION' }).message;
  const qaReply = f.send(f.qa.actor, role('lead'), { kind: 'REPLY', replyTo: question.id }).message;
  const workerReply = f.send(f.lead.actor, role('worker'), { kind: 'REPLY', replyTo: workerNote.id }).message;
  const ids = (page: { messages: { id: string }[] }) => page.messages.map(message => message.id);
  const first = f.list(f.worker.actor, { limit: 1 });
  assert.deepEqual(ids(first), [workerNote.id]);
  assert.equal(first.nextCursor, workerNote.id);
  assert.deepEqual(ids(f.list(f.worker.actor, { cursor: first.nextCursor })), [workerReply.id]);
  assert.deepEqual(ids(f.list(f.qa.actor)), [question.id, qaReply.id]);
  assert.deepEqual(ids(f.list(f.pm.actor)), [workerNote.id, question.id, qaReply.id, workerReply.id]);
  assert.throws(() => f.list(f.worker.actor, { cursor: qaReply.id }), failure('MESSAGE_NOT_VISIBLE'));
  assert.throws(() => f.send(f.qa.actor, role('lead'), { kind: 'REPLY', replyTo: workerNote.id }), failure('MESSAGE_NOT_VISIBLE'));
  assert.throws(() => f.send(f.lead.actor, role('worker'), { kind: 'REPLY', replyTo: qaReply.id }), failure('MESSAGE_NOT_VISIBLE'));
  const foreign = f.enroll('worker', f.otherWorkspace.id);
  assert.throws(() => f.send(f.lead.actor, actorTarget(foreign.actor.id)), failure('MESSAGE_RECIPIENT_UNAVAILABLE'));
  assert.throws(() => f.list(f.worker.actor, { workspaceId: f.otherWorkspace.id }), failure('SCOPE_DENIED'));
  f.enroll('lead');
  assert.throws(() => f.send(f.worker.actor, role('lead')), failure('MESSAGE_RECIPIENT_AMBIGUOUS'));
  assert.equal(f.send(f.worker.actor, actorTarget(f.lead.actor.id)).message.recipient.actorId, f.lead.actor.id);
  assert.equal(f.store.list('issue_message').length, 5);
});

test('real stdio sends to an enrolled issue role and receives only its visible HTTP thread', async t => {
  const f = fixture(t);
  const app = createServer(f.store);
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp'],
    env: { AGILEDEV_ENDPOINT: endpoint, AGILEDEV_TOKEN: f.worker.token },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'message-fixture-client', version: '0.1.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.find(tool => tool.name === 'message_list')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === 'message_send')?.annotations?.readOnlyHint, false);
    const sent = await client.callTool({ name: 'message_send', arguments: {
      ...f.thread, recipient: role('lead'), kind: 'QUESTION', body: 'Inspect a test issue', idempotencyKey: randomUUID()
    } });
    assert.notEqual(sent.isError, true);
    const question = (sent.structuredContent as any).message;
    const lead = new LocalClient(endpoint, f.lead.token);
    const visible = await lead.command('message_list', f.thread);
    assert.deepEqual(visible.messages.map((message: any) => message.id), [question.id]);
    const reply = await lead.command('message_send', { ...f.thread, recipient: role('worker'), kind: 'REPLY', replyTo: question.id, body: 'Check the sealed evidence', idempotencyKey: randomUUID() });
    const page = await client.callTool({ name: 'message_list', arguments: f.thread });
    assert.deepEqual((page.structuredContent as any).messages.map((message: any) => message.id), [question.id, reply.message.id]);
    assert.deepEqual(f.list(f.qa.actor).messages, []);
  } finally {
    await client.close();
    await app.close();
  }
});
