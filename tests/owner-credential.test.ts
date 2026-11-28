import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LocalClient, postPublic } from '../src/client.js';
import { readDescriptor, stopService } from '../src/service-launcher.js';
import { hash } from '../src/store.js';

const exec = promisify(execFile);

test('daemon takeover rotates owner access, binds shutdown, survives restart and supports stopped reset', { timeout: 35000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-owner-rotation-'));
  const env: NodeJS.ProcessEnv = { ...process.env, AGILEDEV_DATA_DIR: directory, AGILEDEV_PORT: '0', AGILEDEV_RUNNER_ENABLED: '0' };
  delete env.AGILEDEV_ENDPOINT;
  delete env.AGILEDEV_TOKEN;
  const cli = (...args: string[]) => exec(process.execPath, [resolve('dist/cli.js'), ...args], { env, windowsHide: true, timeout: 10000 });
  const profile = join(directory, 'desktop');
  const descriptorFile = join(directory, 'daemon.json');
  const descriptor = () => JSON.parse(readFileSync(descriptorFile, 'utf8'));
  const token = randomBytes(32).toString('base64url');
  const login = (endpoint: string, code: string) => fetch(endpoint + '/api/ui/login', { method: 'POST',
    headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  try {
    await cli('service-start');
    const { endpoint, ownerToken, stopToken, instance, pid } = descriptor();
    assert.match(ownerToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(stopToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await (await fetch(endpoint + '/api/ui/status')).json()).ownerClaimed, false);
    const old = new LocalClient(endpoint, ownerToken);
    const oldIdentity = (await old.request('/api/session')).actor.id;
    const workspace = (await old.command('workspace_register', { root: directory, name: 'Owner fixture', prefix: 'OWN', idempotencyKey: 'workspace' })).workspace;
    const agent = await old.command('actor_enroll', { workspaceId: workspace.id, role: 'pm', name: 'Existing PM', idempotencyKey: 'agent' });
    const staleCode = (await old.request('/api/ui/pairing', {})).code;
    assert.equal(JSON.parse((await cli('ui')).stdout).url, endpoint);
    const expiredLogin = await login(endpoint, (await old.request('/api/ui/pairing', {})).code);
    const staleCookie = expiredLogin.headers.get('set-cookie')!.split(';')[0]!;
    const resetBlocked = cli('owner-reset');
    await assert.rejects(resetBlocked, /SERVICE_RUNNING/);
    await assert.rejects(cli('command', 'workspace_list'), /AGENT_CREDENTIAL_REQUIRED/);
    await old.request('/api/owner/claim', { credentialHash: hash(token) });
    assert.deepEqual(descriptor(), { endpoint, pid, instance, stopToken });
    const owner = new LocalClient(endpoint, token);
    await assert.rejects(old.request('/api/session'), { code: 'UNAUTHENTICATED' });
    const afterClaim = await fetch(endpoint + '/api/session', { headers: { cookie: staleCookie } });
    assert.equal(afterClaim.status, 401);
    assert.equal((await (await login(endpoint, staleCode)).json()).error.code, 'PAIRING_INVALID');
    assert.equal((await owner.request('/api/session')).actor.id, oldIdentity);
    assert.equal((await owner.request('/api/session')).actor.channel, 'desktop');
    assert.equal((await new LocalClient(endpoint, agent.token).request('/api/session')).actor.id, agent.actor.id);
    await assert.rejects(owner.command('workspace_list', {}), { code: 'HUMAN_SESSION_REQUIRED' });
    await assert.rejects(owner.request('/api/owner/claim', { credentialHash: hash(token) }), { code: 'OWNER_ALREADY_CLAIMED' });
    await assert.rejects(cli('ui'), /OWNER_CREDENTIAL_PROTECTED/);
    const unclaimedCode = (await owner.request('/api/ui/pairing', {})).code;
    const requested = await postPublic(endpoint, '/api/join', { name: 'Joining', role: 'pm', harness: 'other' });
    const desktopLogin = await login(endpoint, (await owner.request('/api/ui/pairing', {})).code);
    const desktopHeaders = { cookie: desktopLogin.headers.get('set-cookie')!.split(';')[0]!, origin: endpoint,
      'content-type': 'application/json', 'x-csrf-token': String((await desktopLogin.json()).csrf) };
    const approved = await fetch(endpoint + '/api/command/join_request_decide', { method: 'POST', headers: desktopHeaders,
      body: JSON.stringify({ workspaceId: workspace.id, requestId: requested.requestId, expectedVersion: 1, decision: 'APPROVE', idempotencyKey: 'join' }) });
    assert.equal(approved.status, 200);
    const joined = await postPublic(endpoint, '/api/join/poll', { requestId: requested.requestId, secret: requested.secret });
    assert.equal(joined.state, 'APPROVED');
    for (const file of readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())) {
      const bytes = readFileSync(join(file.parentPath, file.name));
      for (const secret of [ownerToken, token, joined.token, requested.secret]) assert.ok(!bytes.includes(Buffer.from(secret)), file.name);
      if (file.name !== 'daemon.json') assert.ok(!bytes.includes(Buffer.from(stopToken)), file.name);
    }
    for (const wrong of [undefined, token, ownerToken, agent.token, joined.token]) {
      const response = await fetch(endpoint + '/api/service/stop', { method: 'POST', headers: {
        'content-type': 'application/json', ...(wrong ? { authorization: 'Bearer ' + wrong } : {}) }, body: JSON.stringify({ instance }) });
      assert.equal(response.status, 401);
    }
    const stop = new LocalClient(endpoint, stopToken);
    await assert.rejects(stop.request('/api/session'), { code: 'UNAUTHENTICATED' });
    await assert.rejects(stop.request('/api/service/stop', { instance: '00000000-0000-4000-8000-000000000000' }), { code: 'SERVICE_IDENTITY_MISMATCH' });
    assert.ok(!(await (await fetch(endpoint + '/health')).text()).includes(stopToken));
    assert.equal((await (await fetch(endpoint + '/api/ui/status')).json()).ownerClaimed, true);
    assert.equal(JSON.parse((await cli('stop')).stdout).stopped, true);
    await cli('service-start');
    const restarted = readDescriptor(directory)!;
    assert.equal(restarted.ownerToken, undefined);
    assert.notEqual(restarted.stopToken, stopToken);
    assert.equal((await new LocalClient(restarted.endpoint, token).request('/api/session')).actor.id, oldIdentity);

    await cli('stop');
    mkdirSync(profile);
    for (const file of ['owner-credential.bin', 'owner-credential.bin.pending']) writeFileSync(join(profile, file), 'encrypted fixture');
    assert.deepEqual(JSON.parse((await cli('owner-reset')).stdout), { reset: true });
    assert.ok(!existsSync(join(profile, 'owner-credential.bin')));
    assert.ok(!existsSync(join(profile, 'owner-credential.bin.pending')));
    await cli('service-start');
    const reset = readDescriptor(directory)!;
    assert.ok(reset.ownerToken && reset.ownerToken !== ownerToken);
    assert.equal((await (await fetch(reset.endpoint + '/api/ui/status')).json()).ownerClaimed, false);
    assert.equal((await new LocalClient(reset.endpoint, reset.ownerToken).request('/api/session')).actor.id, oldIdentity);
    await assert.rejects(new LocalClient(reset.endpoint, token).request('/api/session'), { code: 'UNAUTHENTICATED' });
    assert.equal((await (await login(reset.endpoint, unclaimedCode)).json()).error.code, 'PAIRING_INVALID');
  } finally {
    await stopService(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});
