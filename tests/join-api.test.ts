import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { createServer } from '../src/http.js';
import { postPublic } from '../src/client.js';
import { claimOwner } from '../src/owner.js';
import { operationProfiles } from '../src/agent-profiles.js';
import { randomBytes, randomUUID } from 'node:crypto';

async function fixture(t: TestContext) {
  const store = new Store(':memory:');
  const flow = new Workflow(store);
  const owner = store.bootstrap();
  const workspace = (flow.execute(owner.actor, 'workspace_register', { root: tmpdir(), name: 'Join fixture', prefix: 'JOIN', idempotencyKey: 'workspace' }) as any).workspace;
  let ms = Date.now();
  const app = createServer(store, undefined, { now: () => ms });
  t.after(async () => { await app.close(); store.close(); });
  const host = '127.0.0.1:43170';
  const origin = `http://${host}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers: { host, ...headers } });
  const command = (op: string, payload: unknown, headers: Record<string, string>) => post(`/api/command/${op}`, payload, headers);
  const pair = async (headers: Record<string, string>) => {
    const code = await post('/api/ui/pairing', {}, headers);
    assert.equal(code.statusCode, 200);
    return code.json().code as string;
  };
  const login = async (code: string) => {
    const response = await post('/api/ui/login', { code }, { origin });
    assert.equal(response.statusCode, 200);
    return { actor: response.json().actor, headers: { origin, cookie: String(response.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': response.json().csrf as string } };
  };
  const old = bearer(owner.token);
  const newToken = randomBytes(32).toString('base64url');
  const claim = () => post('/api/owner/claim', { credentialHash: hash(newToken) }, old);
  const desktop = async () => {
    assert.equal((await claim()).statusCode, 200);
    return login(await pair(bearer(newToken)));
  };
  const enroll = (name: string, role: string) => (flow.execute(owner.actor, 'actor_enroll',
    { workspaceId: workspace.id, role, name, idempotencyKey: randomUUID() }) as any);
  const event = (op: string) => {
    const row = store.db.prepare('SELECT data FROM events WHERE operation=? ORDER BY sequence DESC LIMIT 1').get(op) as { data: string };
    return JSON.parse(row.data);
  };
  return { store, workspace, app, host, origin, post, command, pair, login, desktop, enroll, event, bearer, old,
    advance: (change: number) => { ms += change; } };
}

test('local public join routes ignore authorization and surface owner decisions with trusted audit channels', async t => {
  const f = await fixture(t);
  const body = { name: 'Test Joiner', role: 'pm', harness: 'other' };
  const existing = f.enroll('Existing PM', 'pm');
  const owned = await f.command('issue_create', { workspaceId: f.workspace.id, title: 'File credential fixture', idempotencyKey: 'owner-issue' }, f.old);
  assert.equal(owned.statusCode, 200);
  assert.equal(f.event('issue_create').channel, 'owner_credential');
  const early = await f.login(await f.pair(f.old));
  assert.equal((await f.post('/api/ui/pairing', {}, early.headers)).json().error.code, 'ROLE_DENIED');
  assert.equal((await f.post('/api/join', body, { host: 'foreign.invalid' })).json().error.code, 'HOST_DENIED');
  assert.equal((await f.post('/api/join', body, { origin: 'https://foreign.invalid' })).json().error.code, 'ORIGIN_DENIED');
  assert.equal((await f.post('/api/join', { ...body, name: 'x'.repeat(1024) })).statusCode, 413);
  assert.equal((await f.post('/api/join', { ...body, unexpected: true })).json().error.code, 'INVALID_INPUT');
  const requested = await f.post('/api/join', body, f.bearer('invalid'));
  assert.equal(requested.statusCode, 201);
  const { requestId, secret } = requested.json();
  const proof = { requestId, secret };
  assert.equal((await f.post('/api/join/poll', proof)).json().state, 'PENDING');
  assert.equal(f.event('agent_join_requested').channel, 'applicant');
  const desktop = await f.desktop();
  assert.equal(desktop.actor.channel, 'desktop');
  const view = (await f.command('inbox_list', {}, desktop.headers)).json().result;
  assert.equal(view.summary.byKind.JOIN_REQUEST, 1);
  assert.equal(view.summary.attention, 1);
  assert.equal(view.entries[0].issueId, '');
  assert.equal(view.entries[0].target.requestVersion, 1);
  assert.deepEqual(view.entries[0].join.existing, [{ id: existing.actor.id, name: 'Existing PM', role: 'pm' }]);
  assert.ok(!JSON.stringify(view).includes(secret));
  const addIssue = { workspaceId: f.workspace.id, title: 'Desktop event', idempotencyKey: 'desktop-issue' };
  assert.equal((await f.command('issue_create', addIssue, desktop.headers)).statusCode, 200);
  assert.equal(f.event('issue_create').channel, 'desktop');
  const browser = await f.login(await f.pair(desktop.headers));
  assert.equal(browser.actor.channel, 'browser');
  assert.equal((await f.post('/api/ui/pairing', {}, browser.headers)).json().error.code, 'ROLE_DENIED');
  const runId = randomUUID();
  f.store.put('run', { id: runId, kind: 'implementation', workspaceId: f.workspace.id });
  const runToken = f.store.token({ ...existing.actor, id: randomUUID(), runId, principalId: existing.actor.id, role: 'worker' });
  for (const token of [existing.token, runToken]) {
    for (const [op, roles] of Object.entries(operationProfiles)) {
      if (roles.length !== 1 || roles[0] !== 'human') continue;
      const denied = await f.command(op, { malformed: true }, f.bearer(token));
      assert.equal(denied.json().error.code, 'ROLE_DENIED', op);
    }
    assert.equal((await f.post('/api/connection', { name: 'test', version: '0' }, f.bearer(token))).statusCode, 200);
    assert.equal(f.event('connection_initialized').channel, token === runToken ? 'run' : 'agent');
    assert.equal((await f.post('/api/join/retire', {}, f.bearer(token))).json().error.code, 'ROLE_DENIED');
  }
  const approval = await f.command('join_request_decide', { workspaceId: f.workspace.id, requestId, expectedVersion: 1,
    decision: 'APPROVE', idempotencyKey: randomUUID() }, browser.headers);
  assert.equal(approval.statusCode, 200);
  assert.equal(f.event('join_request_decide').channel, 'browser');
  const claimed = (await f.post('/api/join/poll', proof)).json();
  assert.equal(claimed.state, 'APPROVED');
  assert.equal(claimed.endpoint, f.origin);
  assert.equal(claimed.firstSteps.role, 'pm');
  assert.deepEqual((await f.post('/api/join/poll', proof)).json(), { ok: true, state: 'CLAIMED' });
  assert.equal(f.event('actor_enroll').channel, 'confirmed');
  assert.equal(f.event('actor_enroll').decidedChannel, 'browser');
  const auth = f.bearer(claimed.token);
  assert.equal((await f.post('/api/join/retire', { unexpected: true }, auth)).json().error.code, 'INVALID_INPUT');
  assert.equal((await f.post('/api/join/retire', {}, browser.headers)).json().error.code, 'ROLE_DENIED');
  assert.equal((await f.post('/api/join/retire', {}, auth)).statusCode, 200);
  assert.deepEqual(f.event('agent_retire'), { role: 'pm', name: body.name, runsStopped: [], channel: 'agent' });
  assert.equal((await f.post('/api/join/retire', {}, auth)).statusCode, 401);
  assert.ok(f.store.list('actor').every(actor => !Object.hasOwn(actor as object, 'channel')));
});

test('a write rechecks authentication after receiving its body', async t => {
  const f = await fixture(t);
  const owner = f.store.list<any>('actor').find(actor => actor.role === 'human');
  f.app.addHook('preParsing', (_request, _reply, body, done) => {
    claimOwner(f.store, owner, hash(randomBytes(32)), Date.now());
    done(null, body);
  });
  const result = await f.command('issue_create', { workspaceId: f.workspace.id, title: 'Queued fixture write', idempotencyKey: 'revoked-write' }, f.old);
  assert.equal(result.json().error.code, 'UNAUTHENTICATED');
  assert.deepEqual(f.store.list('issue'), []);
});

test('CLI join passes access to the child and retires it on zero and nonzero exit', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  let stopAfterSession = false;
  f.app.addHook('onResponse', async request => {
    if (stopAfterSession && request.url === '/api/session') void f.app.close();
  });
  const desktop = await f.desktop();
  const endpoint = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-join-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = join(directory, 'agent.mjs');
  writeFileSync(child, `const {AGILEDEV_TOKEN, AGILEDEV_ENDPOINT} = process.env;
if (!AGILEDEV_TOKEN || !AGILEDEV_ENDPOINT) process.exit(70);
const response = await fetch(AGILEDEV_ENDPOINT + '/api/session', { headers: { authorization: 'Bearer ' + AGILEDEV_TOKEN } });
if (!response.ok) process.exit(71);
const data = await response.json(); console.log(data.actor.id);
process.exit(Number(process.argv[2]));`);
  const start = (name: string, code: string) => new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    execFile(process.execPath, [resolve('dist/cli.js'), 'join', '--name', name, '--role', 'pm', '--harness', 'other', '--', process.execPath, child, code], {
      env: { ...process.env, AGILEDEV_ENDPOINT: endpoint, AGILEDEV_TOKEN: 'ignored-parent-fixture' }, timeout: 9000, windowsHide: true,
    }, (error, stdout, stderr) => done({ code: Number(error?.code ?? 0), stdout, stderr }));
  });
  async function waitFor(name: string) {
    for (let count = 0; count < 100; count++) {
      const response = await f.command('inbox_list', { kind: 'JOIN_REQUEST' }, desktop.headers);
      const entry = response.json().result.entries.find((item: any) => item.title === name);
      if (entry) return entry.target.requestId;
      await delay(25);
    }
    throw new Error('Join request did not appear');
  }
  for (const code of [0, 7]) {
    const name = `CLI fixture ${code}`;
    const result = start(name, String(code));
    const requestId = await waitFor(name);
    const approved = await f.command('join_request_decide', { requestId, workspaceId: f.workspace.id, expectedVersion: 1, decision: 'APPROVE', idempotencyKey: randomUUID() }, desktop.headers);
    assert.equal(approved.statusCode, 200);
    const exit = await result;
    assert.equal(exit.code, code);
    assert.match(exit.stdout.trim(), /^[a-f0-9-]{36}$/);
    const actor = f.store.get<any>('actor', exit.stdout.trim());
    assert.ok(actor.disabledAt);
    assert.equal(actor.name, name);
    const [wait, instructions, ...remainder] = exit.stderr.trim().split(/\r?\n/);
    assert.match(wait!, /waiting for the owner/);
    assert.equal(JSON.parse(instructions!).role, 'pm');
    assert.deepEqual(remainder, []);
  }
  const refused = start('Refused CLI', '0');
  const requestId = await waitFor('Refused CLI');
  await f.command('join_request_decide', { requestId, workspaceId: f.workspace.id, expectedVersion: 1, decision: 'REFUSE', idempotencyKey: randomUUID() }, desktop.headers);
  const refusedResult = await refused;
  assert.equal(refusedResult.code, 1);
  assert.match(refusedResult.stderr, /JOIN_REQUEST_REFUSED/);
  const expired = start('Expired CLI', '0');
  await waitFor('Expired CLI');
  f.advance(600_000);
  const result = await expired;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /JOIN_REQUEST_EXPIRED/);
  await assert.rejects(postPublic('https://example.invalid', '/api/join', {}), { code: 'ENDPOINT_DENIED' });
  const lost = start('Service closes', '9');
  const last = await waitFor('Service closes');
  stopAfterSession = true;
  await f.command('join_request_decide', { requestId: last, workspaceId: f.workspace.id, expectedVersion: 1,
    decision: 'APPROVE', idempotencyKey: randomUUID() }, desktop.headers);
  const failedRetire = await lost;
  assert.equal(failedRetire.code, 9);
  assert.match(failedRetire.stderr.trim().split(/\r?\n/).at(-1)!, /^(SERVICE_UNAVAILABLE|FST_ERR_CLOSING|SERVICE_ERROR)$/);
});

