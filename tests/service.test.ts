import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureService, readDescriptor, serviceAvailable, stopService } from '../src/service-launcher.js';
import { LocalClient } from '../src/client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';

const exec = promisify(execFile);
const script = resolve('dist/cli.js');
test('concurrent real launchers share one daemon; MCP silently restarts it with retained identity and data', { timeout: 40000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-service-'));
  const env = { ...process.env, AGILEDEV_DATA_DIR: directory, AGILEDEV_PORT: '0', AGILEDEV_RUNNER_ENABLED: '0' };
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
    await Promise.all(credentials.map(async (entry, index) => {
      const client = new Client({ name: `silent-entry-${index}`, version: '0.1.0' });
      const defined = Object.fromEntries(Object.entries(env).filter((p): p is [string, string] => p[1] !== undefined));
      delete defined.AGILEDEV_ENDPOINT;
      const transport = new StdioClientTransport({ command: process.execPath, args: [script, 'mcp'], cwd: resolve('.'), env: { ...defined, AGILEDEV_TOKEN: entry.token }, stderr: 'pipe' });
      await client.connect(transport); entries.push(client);
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
    await Promise.all(entries.map(client => client.close())); entries.length = 0;
    process.kill(restarted.pid, 'SIGKILL');
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

test('launcher rejects foreign descriptors and refuses to replace a live uncertain lock', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-service-denial-'));
  const descriptor = join(directory, 'daemon.json');
  writeFileSync(descriptor, JSON.stringify({ endpoint: 'https://example.org', ownerToken: 'private-fixture', pid: process.pid, instance: randomUUID() }));
  const before = readFileSync(descriptor, 'utf8');
  await assert.rejects(ensureService({ dataDir: directory, node: process.execPath, script, timeoutMs: 200 }), { code: 'INVALID_SERVICE_METADATA' });
  assert.equal(readFileSync(descriptor, 'utf8'), before);
  const held = mkdtempSync(join(tmpdir(), 'agiledev-service-held-'));
  const lock = JSON.stringify({ pid: process.pid, instance: randomUUID() });
  writeFileSync(join(held, 'daemon.lock'), lock);
  await assert.rejects(ensureService({ dataDir: held, node: process.execPath, script, timeoutMs: 200 }), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(readFileSync(join(held, 'daemon.lock'), 'utf8'), lock);
});

test('generated local connection really restarts its daemon while explicit endpoints remain pinned', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-service-config-'));
  const env = { ...process.env, AGILEDEV_DATA_DIR: directory, AGILEDEV_PORT: '0', AGILEDEV_RUNNER_ENABLED: '0' };
  delete env.AGILEDEV_ENDPOINT; delete env.AGILEDEV_TOKEN;
  let client: Client | undefined;
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
    assert.equal(await stopService(directory), true);
    const defined = Object.fromEntries(Object.entries(env).filter((p): p is [string, string] => p[1] !== undefined));
    client = new Client({ name: 'generated-config-fixture', version: '0.1.0' });
    await client.connect(new StdioClientTransport({ command: connection.command, args: connection.args, env: { ...defined, ...connection.env, AGILEDEV_TOKEN: credential.token }, stderr: 'pipe' }));
    const result = await client.callTool({ name: 'workspace_list', arguments: {} });
    assert.equal((result.structuredContent as any).workspaces[0].id, workspace.id);
    assert.notEqual(readDescriptor(directory)!.instance, descriptor.instance);
  } finally { await client?.close(); await stopService(directory); }
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
    identity = { ...identity, instance, version: '999.0.0' };
    await assert.rejects(ensureService(options), { code: 'SERVICE_VERSION_MISMATCH' });
    assert.deepEqual(authorizations, [undefined, undefined]);
  } finally { await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); }
});
