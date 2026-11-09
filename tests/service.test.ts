import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureService, processExists, readDescriptor, requireService, serviceAvailable, stopService } from '../src/service-launcher.js';
import { LocalClient } from '../src/client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const script = resolve('dist/cli.js');
function fixtureEnvironment(directory: string): NodeJS.ProcessEnv {
  const env = { ...process.env, AGILEDEV_DATA_DIR: directory, AGILEDEV_PORT: '0', AGILEDEV_RUNNER_ENABLED: '0' };
  delete env.AGILEDEV_ENDPOINT; delete env.AGILEDEV_TOKEN; delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
async function ownerStartRequired(args: string[], env: NodeJS.ProcessEnv) {
  await assert.rejects(exec(process.execPath, [script, ...args], { env, windowsHide: true, timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /SERVICE_OWNER_START_REQUIRED/);
    assert.match(error.stderr, /desktop app.*service-start/);
    assert.equal(error.stdout, '');
    return true;
  });
}

test('offline agent entries and ordinary owner commands never start a service', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-service-offline-'));
  const env = fixtureEnvironment(directory);
  for (const args of [['mcp'], ['command', 'workspace_list'], ...['codex', 'claude-code', 'dsh'].map(format => ['connection', format])]) {
    await ownerStartRequired(args, { ...env, AGILEDEV_TOKEN: 'private-offline-agent-fixture' });
  }
  await ownerStartRequired(['command', 'workspace_list'], env);
  await delay(100);
  assert.deepEqual(readdirSync(directory), []);
});

test('owner launchers share one daemon; bridge disconnect preserves it and a crash requires explicit owner restart', { timeout: 40000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-service-'));
  const env = fixtureEnvironment(directory);
  const entries: Client[] = [];
  try {
    const launched = await Promise.all(['ui', 'service-start', 'ui', 'service-start'].map(command => exec(process.execPath, [script, command], { env, windowsHide: true, timeout: 25000 })));
    const metadata = launched.map(result => JSON.parse(result.stdout));
    assert.equal(new Set(metadata.map(value => value.url ?? value.endpoint)).size, 1);
    for (const value of metadata.filter(value => value.endpoint)) assert.deepEqual(Object.keys(value).sort(), ['endpoint', 'instance', 'pid']);
    const descriptor = readDescriptor(directory)!;
    assert.equal(await serviceAvailable(descriptor, directory), true);
    const owner = new LocalClient(descriptor.endpoint, descriptor.ownerToken);
    const workspace = (await owner.command('workspace_register', { root: directory, name: 'Lifecycle fixture', prefix: 'LIFE', idempotencyKey: 'workspace' })).workspace;
    const created = await owner.command('issue_create', { workspaceId: workspace.id, title: 'Retained after UI closes', idempotencyKey: 'issue' });
    const credentials = [];
    for (const harness of ['codex', 'claude-code', 'dsh']) credentials.push(await owner.command('actor_enroll', { workspaceId: workspace.id, role: 'lead', name: harness, idempotencyKey: harness }));
    assert.equal(await stopService(directory), true);
    assert.equal(await stopService(directory), false);
    await ownerStartRequired(['mcp'], { ...env, AGILEDEV_TOKEN: credentials[0]!.token });
    assert.deepEqual(readDescriptor(directory), descriptor);
    await exec(process.execPath, [script, 'service-start'], { env, windowsHide: true, timeout: 25000 });
    await Promise.all(credentials.map(async (entry, index) => {
      const client = new Client({ name: `silent-entry-${index}`, version: '0.1.0' });
      const defined = Object.fromEntries(Object.entries(env).filter((p): p is [string, string] => p[1] !== undefined));
      delete defined.AGILEDEV_ENDPOINT;
      const transport = new StdioClientTransport({ command: process.execPath, args: [script, 'mcp'], cwd: resolve('.'), env: { ...defined, AGILEDEV_TOKEN: entry.token }, stderr: 'pipe' });
      entries.push(client); await client.connect(transport);
      const issue = await client.callTool({ name: 'issue_get', arguments: { workspaceId: workspace.id, issueId: created.issue.id } });
      assert.equal((issue.structuredContent as any).issue.id, created.issue.id);
    }));
    const restarted = readDescriptor(directory)!;
    assert.notEqual(restarted.instance, descriptor.instance);
    assert.notEqual(restarted.pid, descriptor.pid);
    assert.equal(restarted.ownerToken, descriptor.ownerToken);
    const reconnected = new LocalClient(restarted.endpoint, restarted.ownerToken);
    assert.equal((await reconnected.command('issue_get', { workspaceId: workspace.id, issueId: created.issue.id })).issue.state, 'NOT_STARTED');
    const duplicate = await exec(process.execPath, [script, 'serve'], { env, windowsHide: true }).then(() => null, error => error);
    assert.ok(duplicate);
    assert.match(duplicate.stderr, /live process owns/);
    assert.equal(readDescriptor(directory)!.pid, restarted.pid);
    const oldInstance = await fetch(`${restarted.endpoint}/api/service/stop`, { method: 'POST', headers: { authorization: `Bearer ${restarted.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ instance: descriptor.instance }) });
    assert.equal(oldInstance.status, 409);
    const agentStop = await fetch(`${restarted.endpoint}/api/service/stop`, { method: 'POST', headers: { authorization: `Bearer ${credentials[0]!.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ instance: restarted.instance }) });
    assert.equal(agentStop.status, 403);
    const pairing = await reconnected.request('/api/ui/pairing', {});
    const login = await fetch(`${restarted.endpoint}/api/ui/login`, { method: 'POST', headers: { origin: restarted.endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = await login.json() as any;
    const browserStop = await fetch(`${restarted.endpoint}/api/service/stop`, { method: 'POST', headers: { origin: restarted.endpoint, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ instance: restarted.instance }) });
    assert.equal(browserStop.status, 403);
    await entries[0]!.close();
    assert.equal(await serviceAvailable(restarted, directory), true);
    assert.notEqual((await entries[1]!.callTool({ name: 'issue_get', arguments: { workspaceId: workspace.id, issueId: created.issue.id } })).isError, true);
    process.kill(restarted.pid, 'SIGKILL');
    const deadline = Date.now() + 3000;
    while (processExists(restarted.pid) && Date.now() < deadline) await delay(50);
    assert.equal(processExists(restarted.pid), false);
    const interrupted = await entries[1]!.callTool({ name: 'workspace_list', arguments: {} });
    assert.equal(interrupted.isError, true);
    await ownerStartRequired(['mcp'], { ...env, AGILEDEV_TOKEN: credentials[0]!.token });
    await ownerStartRequired(['command', 'workspace_list'], { ...env, AGILEDEV_TOKEN: credentials[0]!.token });
    await ownerStartRequired(['connection', 'codex'], { ...env, AGILEDEV_TOKEN: credentials[0]!.token });
    assert.deepEqual(readDescriptor(directory), restarted);
    assert.equal(processExists(restarted.pid), false);
    await Promise.all(entries.map(client => client.close())); entries.length = 0;
    const recovered = await Promise.all(Array.from({ length: 3 }, () => exec(process.execPath, [script, 'ui'], { env, windowsHide: true, timeout: 25000 })));
    assert.equal(new Set(recovered.map(result => JSON.parse(result.stdout).url)).size, 1);
    const current = readDescriptor(directory)!;
    assert.notEqual(current.instance, restarted.instance);
    assert.equal((await new LocalClient(current.endpoint, current.ownerToken).command('issue_get', { workspaceId: workspace.id, issueId: created.issue.id })).issue.id, created.issue.id);
  } finally {
    await Promise.allSettled(entries.map(client => client.close()));
    await stopService(directory);
  }
});

test('explicit endpoint commands require an agent token and never forward the local owner credential', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-service-endpoint-'));
  const env = fixtureEnvironment(directory);
  const requests: unknown[] = [];
  const receiver = createServer((request, response) => { requests.push(request.headers.authorization); response.end('{}'); });
  await new Promise<void>(done => receiver.listen(0, '127.0.0.1', done));
  const foreignEndpoint = `http://127.0.0.1:${(receiver.address() as any).port}`;
  try {
    await exec(process.execPath, [script, 'service-start'], { env, windowsHide: true });
    const descriptor = readDescriptor(directory)!;
    const owner = new LocalClient(descriptor.endpoint, descriptor.ownerToken);
    const workspace = (await owner.command('workspace_register', { root: directory, name: 'Explicit endpoint fixture', prefix: 'EP', idempotencyKey: 'workspace' })).workspace;
    const credential = await owner.command('actor_enroll', { workspaceId: workspace.id, role: 'lead', name: 'Endpoint agent', idempotencyKey: 'lead' });
    const input = join(directory, 'input.json'); writeFileSync(input, '{}');
    const local = await exec(process.execPath, [script, 'command', 'workspace_list', input], { env, windowsHide: true });
    assert.equal(JSON.parse(local.stdout).workspaces[0].id, workspace.id);
    const scoped = await exec(process.execPath, [script, 'command', 'workspace_list', input], { env: { ...env, AGILEDEV_ENDPOINT: descriptor.endpoint, AGILEDEV_TOKEN: credential.token }, windowsHide: true });
    assert.equal(JSON.parse(scoped.stdout).workspaces[0].id, workspace.id);
    await assert.rejects(exec(process.execPath, [script, 'command', 'workspace_list', input], { env: { ...env, AGILEDEV_ENDPOINT: foreignEndpoint }, windowsHide: true, timeout: 5000 }), (error: any) => {
      assert.match(error.stderr, /AGENT_CREDENTIAL_REQUIRED/);
      assert.ok(!error.stderr.includes(descriptor.ownerToken));
      return true;
    });
    assert.deepEqual(requests, []);
    assert.equal(await serviceAvailable(descriptor, directory), true);
  } finally {
    await stopService(directory);
    await new Promise<void>((done, fail) => receiver.close(error => error ? fail(error) : done()));
  }
});

test('launcher rejects foreign descriptors and refuses to replace a live uncertain lock', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-service-denial-'));
  const descriptor = join(directory, 'daemon.json');
  writeFileSync(descriptor, JSON.stringify({ endpoint: 'https://example.org', ownerToken: 'private-fixture', pid: process.pid, instance: randomUUID() }));
  const before = readFileSync(descriptor, 'utf8');
  await assert.rejects(ensureService({ dataDir: directory, node: process.execPath, script, timeoutMs: 200 }), { code: 'INVALID_SERVICE_METADATA' });
  await assert.rejects(requireService(directory), { code: 'INVALID_SERVICE_METADATA' });
  assert.equal(readFileSync(descriptor, 'utf8'), before);
  const held = mkdtempSync(join(tmpdir(), 'agiledev-service-held-'));
  const lock = JSON.stringify({ pid: process.pid, instance: randomUUID() });
  writeFileSync(join(held, 'daemon.lock'), lock);
  await assert.rejects(ensureService({ dataDir: held, node: process.execPath, script, timeoutMs: 200 }), { code: 'SERVICE_UNAVAILABLE' });
  await assert.rejects(requireService(held), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(readFileSync(join(held, 'daemon.lock'), 'utf8'), lock);
});

test('generated local connection discovers an explicit owner restart while explicit endpoints remain pinned', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-service-config-'));
  const env = fixtureEnvironment(directory);
  let client: Client | undefined;
  let oldPortReservation: ReturnType<typeof createServer> | undefined;
  try {
    await exec(process.execPath, [script, 'service-start'], { env, windowsHide: true });
    const descriptor = readDescriptor(directory)!;
    const owner = new LocalClient(descriptor.endpoint, descriptor.ownerToken);
    const workspace = (await owner.command('workspace_register', { root: directory, name: 'Generated config fixture', prefix: 'CFG', idempotencyKey: 'workspace' })).workspace;
    const credential = await owner.command('actor_enroll', { workspaceId: workspace.id, role: 'lead', name: 'Configured lead', idempotencyKey: 'lead' });
    let connection: any;
    for (const format of ['codex', 'claude-code', 'dsh']) {
      const generated = await exec(process.execPath, [script, 'connection', format], { env: { ...env, AGILEDEV_TOKEN: credential.token }, windowsHide: true });
      assert.ok(generated.stdout.includes('AGILEDEV_DATA_DIR'));
      assert.ok(!generated.stdout.includes('AGILEDEV_ENDPOINT'));
      assert.ok(!generated.stdout.includes(credential.token) && !generated.stdout.includes(descriptor.ownerToken));
      if (format === 'claude-code') connection = JSON.parse(generated.stdout).mcpServers.agiledev;
      const explicit = await exec(process.execPath, [script, 'connection', format], { env: { ...env, AGILEDEV_TOKEN: credential.token, AGILEDEV_ENDPOINT: descriptor.endpoint }, windowsHide: true });
      assert.ok(explicit.stdout.includes('AGILEDEV_ENDPOINT'));
      assert.ok(!explicit.stdout.includes('AGILEDEV_DATA_DIR'));
    }
    assert.equal(connection.env.AGILEDEV_DATA_DIR, directory);
    const defined = Object.fromEntries(Object.entries(env).filter((p): p is [string, string] => p[1] !== undefined));
    client = new Client({ name: 'generated-config-before-restart', version: '0.1.0' });
    await client.connect(new StdioClientTransport({ command: connection.command, args: connection.args, env: { ...defined, ...connection.env, AGILEDEV_TOKEN: credential.token }, stderr: 'pipe' }));
    assert.equal(((await client.callTool({ name: 'workspace_list', arguments: {} })).structuredContent as any).workspaces[0].id, workspace.id);
    await client.close(); client = undefined;
    assert.equal(await serviceAvailable(descriptor, directory), true);
    assert.equal(await stopService(directory), true);
    await ownerStartRequired(['mcp'], { ...defined, ...connection.env, AGILEDEV_TOKEN: credential.token });
    assert.deepEqual(readDescriptor(directory), descriptor);
    oldPortReservation = createServer();
    await new Promise<void>((done, fail) => { oldPortReservation!.once('error', fail); oldPortReservation!.listen(Number(new URL(descriptor.endpoint).port), '127.0.0.1', done); });
    await exec(process.execPath, [script, 'service-start'], { env, windowsHide: true });
    const restarted = readDescriptor(directory)!;
    assert.notEqual(restarted.instance, descriptor.instance);
    assert.notEqual(restarted.endpoint, descriptor.endpoint);
    client = new Client({ name: 'generated-config-fixture', version: '0.1.0' });
    await client.connect(new StdioClientTransport({ command: connection.command, args: connection.args, env: { ...defined, ...connection.env, AGILEDEV_TOKEN: credential.token }, stderr: 'pipe' }));
    const result = await client.callTool({ name: 'workspace_list', arguments: {} });
    assert.equal((result.structuredContent as any).workspaces[0].id, workspace.id);
    await client.close(); client = undefined;
    assert.equal(await serviceAvailable(restarted, directory), true);
    assert.equal(readDescriptor(directory)!.instance, restarted.instance);
  } finally {
    await client?.close(); await stopService(directory);
    if (oldPortReservation?.listening) await new Promise<void>((done, fail) => oldPortReservation!.close(error => error ? fail(error) : done()));
  }
});

test('service identity and version mismatches stop attachment before any credential is transmitted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-service-identity-'));
  const instance = randomUUID();
  let identity: any = { name: 'agiledev-collaboration', version: '0.1.0', instance: randomUUID(), pid: process.pid };
  const authorizations: unknown[] = [];
  const server = createServer((request, response) => { authorizations.push(request.headers.authorization); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(identity)); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  writeFileSync(join(directory, 'daemon.json'), JSON.stringify({ endpoint, ownerToken: 'a'.repeat(43), pid: process.pid, instance }));
  writeFileSync(join(directory, 'daemon.lock'), JSON.stringify({ pid: process.pid, instance }));
  try {
    const options = { dataDir: directory, node: process.execPath, script, timeoutMs: 200 };
    await assert.rejects(ensureService(options), { code: 'SERVICE_IDENTITY_MISMATCH' });
    await assert.rejects(requireService(directory), { code: 'SERVICE_IDENTITY_MISMATCH' });
    identity = { ...identity, instance, version: '999.0.0' };
    await assert.rejects(ensureService(options), { code: 'SERVICE_VERSION_MISMATCH' });
    await assert.rejects(requireService(directory), { code: 'SERVICE_VERSION_MISMATCH' });
    assert.deepEqual(authorizations, [undefined, undefined, undefined, undefined]);
  } finally { await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); }
});
