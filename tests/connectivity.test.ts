import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { createServer } from '../src/http.js';
import { LocalClient } from '../src/client.js';

test('real SQLite service shares one issue across three independent MCP processes', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-mcp-'));
  const store = new Store(join(root, 'workflow.sqlite'));
  const owner = store.bootstrap(); const flow = new Workflow(store);
  const workspace = (flow.execute(owner.actor, 'workspace_register', { root, name: 'Shared test', prefix: 'MCP', idempotencyKey: 'workspace' }) as any).workspace;
  const server = createServer(store);
  const endpoint = await server.listen({ host: '127.0.0.1', port: 0 });
  const clients: Client[] = [];
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((p): p is [string, string] => p[1] !== undefined));
    for (const harness of ['codex', 'claude-code', 'dsh']) {
      const enrollment = flow.execute(owner.actor, 'actor_enroll', { workspaceId: workspace.id, role: 'lead', name: harness, idempotencyKey: `enroll-${harness}` }) as any;
      const client = new Client({ name: `protocol-test-${harness}`, version: '0.1.0' });
      const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('src/cli.ts'), 'mcp'], cwd: resolve('.'), env: { ...env, AGILEDEV_ENDPOINT: endpoint, AGILEDEV_TOKEN: enrollment.token }, stderr: 'pipe' });
      await client.connect(transport); clients.push(client);
    }
    const tools = await clients[0]!.listTools();
    assert.ok(tools.tools.some(t => t.name === 'work_dispatch'));
    assert.ok(!tools.tools.some(t => ['design_decide','actor_enroll','grant_create','grant_revoke'].includes(t.name)));
    assert.ok(tools.tools.some(t => t.name === 'grant_list' && t.annotations?.readOnlyHint));
    const created = await clients[0]!.callTool({ name: 'issue_create', arguments: { workspaceId: workspace.id, title: 'Shared across entries', description: 'Create in entry A; read in B and C', criteria: ['AC-1'], idempotencyKey: 'create-shared' } });
    assert.ok(!created.isError);
    const issue = (created.structuredContent as any).issue;
    for (const client of clients.slice(1)) {
      const response = await client.callTool({ name: 'issue_get', arguments: { workspaceId: workspace.id, issueId: issue.id } });
      assert.equal((response.structuredContent as any).issue.id, issue.id);
      assert.equal((response.structuredContent as any).issue.state, 'NOT_STARTED');
    }
    const changed = await clients[1]!.callTool({ name: 'issue_update', arguments: { workspaceId: workspace.id, issueId: issue.id, expectedVersion: 1, priority: 1, idempotencyKey: 'update-shared' } });
    assert.equal((changed.structuredContent as any).issue.version, 2);
    const conflict = await clients[2]!.callTool({ name: 'issue_update', arguments: { workspaceId: workspace.id, issueId: issue.id, expectedVersion: 1, priority: 4, idempotencyKey: 'stale-update' } });
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict.content), /VERSION_CONFLICT/);
    const forbidden = await clients[2]!.callTool({ name: 'issue_transition', arguments: { workspaceId: workspace.id, issueId: issue.id, expectedVersion: 2, action: 'abandon', reason: 'No human grant', idempotencyKey: 'unauthorized' } });
    assert.equal(forbidden.isError, true); assert.match(JSON.stringify(forbidden.content), /ROLE_DENIED/);
  } finally {
    await Promise.all(clients.map(c => c.close())); await server.close(); store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP enforces authentication, Origin, host and actor boundaries', async () => {
  const store = new Store(':memory:'); const owner = store.bootstrap(); const server = createServer(store);
  try {
    const headers = { host: '127.0.0.1:43170', authorization: `Bearer ${owner.token}` };
    const unauth = await server.inject({ method: 'GET', url: '/api/session', headers: { host: headers.host } });
    assert.equal(unauth.statusCode, 401);
    const foreign = await server.inject({ method: 'GET', url: '/api/session', headers: { ...headers, origin: 'https://example.org' } });
    assert.equal(foreign.statusCode, 403);
    const badHost = await server.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example' } });
    assert.equal(badHost.statusCode, 403);
    const spoof = await server.inject({ method: 'POST', url: '/api/command/workspace_register', headers, payload: { root: tmpdir(), name: 'Spoof', prefix: 'SP', idempotencyKey: randomUUID(), role: 'human' } });
    assert.equal(spoof.statusCode, 400);
    assert.throws(() => new LocalClient('https://example.org', owner.token), /loopback/);
  } finally { await server.close(); store.close(); }
});

test('accepted mutations survive store restart and concurrent stale requests lose safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-restart-')); const db = join(root, 'workflow.sqlite');
  let store = new Store(db); const owner = store.bootstrap(); let flow = new Workflow(store);
  const workspace = (flow.execute(owner.actor, 'workspace_register', { root, name: 'Restart', prefix: 'RS', idempotencyKey: 'workspace' }) as any).workspace;
  const issue = (flow.execute(owner.actor, 'issue_create', { workspaceId: workspace.id, title: 'Persistent delivery', idempotencyKey: 'create' }) as any).issue;
  store.close(); store = new Store(db); flow = new Workflow(store);
  const server = createServer(store); const endpoint = await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    assert.equal(store.authenticate(owner.token).id, owner.actor.id);
    const client = new LocalClient(endpoint, owner.token);
    const changes = await Promise.allSettled([1, 3].map(priority => client.command('issue_update', { workspaceId: workspace.id, issueId: issue.id, expectedVersion: 1, priority, idempotencyKey: `parallel-${priority}` })));
    assert.equal(changes.filter(r => r.status === 'fulfilled').length, 1);
    const current = await client.command('issue_get', { workspaceId: workspace.id, issueId: issue.id });
    assert.equal(current.issue.version, 2);
    const replay = flow.execute(owner.actor, 'issue_create', { workspaceId: workspace.id, title: 'Persistent delivery', idempotencyKey: 'create' }) as any;
    assert.equal(replay.issue.id, issue.id); assert.equal(replay.replayed, true);
  } finally { await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
