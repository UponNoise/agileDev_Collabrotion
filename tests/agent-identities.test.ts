import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { createServer } from '../src/http.js';
import { queueQa } from '../src/qa-policy.js';
import { disableAgent } from '../src/identities.js';
import type { Issue, Run } from '../src/contracts.js';

test('scoped identity listing, disabling, messaging and assignment checks use active logical agents', async t => {
  const store = new Store(':memory:');
  const flow = new Workflow(store);
  const owner = store.bootstrap();
  const call = (op: string, args: object) => flow.execute(owner.actor, op, { idempotencyKey: randomUUID(), ...args }) as any;
  const { workspace } = call('workspace_register', { root: tmpdir(), name: 'Identity fixture', prefix: 'IDS' });
  const workspaceId = workspace.id;
  const create = (role: string, name: string) => call('actor_enroll', { workspaceId, name, role });
  const lead = create('lead', 'Lead');
  const firstPm = create('pm', 'Retiring PM');
  const pm = create('pm', 'Active PM');
  const worker = create('worker', 'Worker');
  const qa = create('qa', 'QA');
  const { issue } = call('issue_create', { workspaceId, title: 'Fixture issue', description: 'Fixture', criteria: ['AC1'] });
  const app = createServer(store);
  t.after(async () => { await app.close(); store.close(); });
  const command = (token: string, op: string, args: object = {}) => app.inject({ method: 'POST', url: '/api/command/' + op,
    headers: { host: 'localhost:43170', authorization: 'Bearer ' + token }, payload: { workspaceId, ...args } });
  const list = (token: string, args: object = {}) => command(token, 'agent_list', args);
  const send = (token: string, recipient: object, kind = 'NOTE') => command(token, 'message_send', {
    issueId: issue.id, recipient, kind, body: 'Fixture message', idempotencyKey: randomUUID(),
  });
  const disable = (actorId: string, token = owner.token) => command(token, 'agent_disable', { actorId, idempotencyKey: randomUUID() });
  for (const token of [owner.token, lead.token, pm.token]) assert.equal((await list(token)).json().result.total, 5);
  for (const token of [worker.token, qa.token]) assert.equal((await list(token)).json().error.code, 'ROLE_DENIED');
  const page = (await list(lead.token, { agentRole: 'pm', offset: 1, limit: 1 })).json().result;
  assert.deepEqual(page, { agents: [{ id: pm.actor.id, name: 'Active PM', role: 'pm', harness: null, status: 'ACTIVE',
    joinedVia: 'owner', joinedAt: pm.actor.joinedAt, disabledAt: null, lastConnectedAt: null }], total: 2, nextOffset: null });
  assert.equal((await disable(firstPm.actor.id, lead.token)).json().error.code, 'ROLE_DENIED');
  assert.equal((await disable(owner.actor.id)).json().error.code, 'SCOPE_DENIED');
  assert.equal((await disable('nonexistent')).json().error.code, 'NOT_FOUND');
  assert.equal((await send(firstPm.token, { kind: 'owner' }, 'QUESTION')).statusCode, 200);
  assert.equal((await command(owner.token, 'inbox_list')).json().result.summary.byKind.AGENT_QUESTION, 1);
  assert.equal((await send(lead.token, { kind: 'role', role: 'pm' })).json().error.code, 'MESSAGE_RECIPIENT_AMBIGUOUS');
  assert.equal((await disable(firstPm.actor.id)).statusCode, 200);
  assert.equal((await list(firstPm.token)).json().error.code, 'UNAUTHENTICATED');
  const message = await send(lead.token, { kind: 'role', role: 'pm' });
  assert.equal(message.json().result.message.recipient.actorId, pm.actor.id);
  assert.equal((await send(lead.token, { kind: 'actor', actorId: firstPm.actor.id })).json().error.code, 'MESSAGE_RECIPIENT_UNAVAILABLE');
  assert.equal((await command(owner.token, 'inbox_list')).json().result.summary.byKind.AGENT_QUESTION, 0);
  assert.equal((await list(pm.token, { agentRole: 'pm' })).json().result.total, 1);
  const both = (await list(pm.token, { agentRole: 'pm', includeDisabled: true })).json().result;
  assert.deepEqual(both.agents.map((actor: any) => actor.status), ['DISABLED', 'ACTIVE']);

  const issueArgs = { workspaceId, issueId: issue.id, expectedVersion: issue.version };
  assert.throws(() => call('grant_create', { ...issueArgs, granteeId: firstPm.actor.id, action: 'hold', scopeHash: 'fixture',
    expiresAt: new Date(Date.now() + 60000).toISOString(), reason: 'Disabled fixture' }), { code: 'ACTOR_DISABLED' });
  await disable(qa.actor.id);
  assert.throws(() => call('qa_configure', { ...issueArgs, actorId: qa.actor.id, harness: 'codex', checkProfileIds: ['fixture'] }), { code: 'ACTOR_DISABLED' });
  assert.equal(queueQa(store, { ...issue, qaAssignee: qa.actor.id, qaHarness: 'codex', checkProfileIds: ['fixture'] } as Issue), null);
});

test('disabling retires run credentials and records requested stops without clearing uncertainty', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { actor: owner } = store.bootstrap();
  const workspaceId = 'fixture';
  const actor = { id: 'worker', name: 'Worker', role: 'worker' as const, sessionId: 'session', workspaceIds: [workspaceId] };
  const agentToken = store.token(actor);
  const runToken = store.token({ ...actor, id: 'run-actor', runId: 'running', principalId: actor.id });
  const now = Date.parse('2026-11-28T00:00:00Z');
  for (const state of ['QUEUED', 'STARTING', 'RUNNING', 'STOPPING', 'UNCERTAIN'] as const) {
    store.put('run', { id: state.toLowerCase(), actorId: actor.id, workspaceId, state, version: 1 }, workspaceId);
  }
  disableAgent(store, { ...owner, channel: 'desktop' }, workspaceId, actor.id, 'agent_disable', now, 'Inactive fixture');
  assert.throws(() => store.authenticate(agentToken), { code: 'UNAUTHENTICATED' });
  assert.throws(() => store.authenticate(runToken), { code: 'UNAUTHENTICATED' });
  assert.deepEqual(store.list<Run>('run').map(({ state, version }) => [state, version]), [
    ['CANCELLED', 2], ['STOPPING', 2], ['STOPPING', 2], ['STOPPING', 1], ['UNCERTAIN', 1],
  ]);
  const runsStopped = store.db.prepare("SELECT data FROM events WHERE operation='agent_disable'").get() as { data: string };
  assert.deepEqual(JSON.parse(runsStopped.data), { role: 'worker', name: 'Worker', reason: 'Inactive fixture',
    channel: 'desktop', runsStopped: ['queued', 'starting', 'running'] });
});
