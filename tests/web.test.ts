import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { createServer } from '../src/http.js';
import { WebSessions } from '../src/web-session.js';
import { agentOperations } from '../src/contracts.js';

test('human browser pairing is one-use, origin-bound, cookie-only, CSRF-protected and revocable', async () => {
  const store = new Store(':memory:');
  const owner = store.bootstrap();
  const app = createServer(store);
  const host = '127.0.0.1:43170';
  const origin = `http://${host}`;
  try {
    const flow = new Workflow(store);
    const workspace = (
      flow.execute(owner.actor, 'workspace_register', {
        root: tmpdir(),
        name: 'Web fixture',
        prefix: 'WEB',
        idempotencyKey: 'workspace'
      }) as any
    ).workspace;
    const worker = flow.execute(owner.actor, 'actor_enroll', {
      workspaceId: workspace.id,
      role: 'worker',
      name: 'Worker',
      idempotencyKey: 'enroll'
    }) as any;
    const denied = await app.inject({
      method: 'POST',
      url: '/api/ui/pairing',
      headers: { host, authorization: `Bearer ${worker.token}` },
      payload: {}
    });
    assert.equal(denied.statusCode, 403);
    const pairing = await app.inject({
      method: 'POST',
      url: '/api/ui/pairing',
      headers: { host, authorization: `Bearer ${owner.token}` },
      payload: {}
    });
    const code = pairing.json().code;
    assert.equal(pairing.statusCode, 200);
    assert.ok(code);
    assert.ok(!JSON.stringify(store.list('ui_pairing')).includes(code));
    for (const value of [undefined, 'https://external.example']) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/ui/login',
        headers: { host, ...(value ? { origin: value } : {}) },
        payload: { code }
      });
      assert.equal(rejected.statusCode, 403);
    }
    const login = await app.inject({
      method: 'POST',
      url: '/api/ui/login',
      headers: { host, origin },
      payload: { code }
    });
    assert.equal(login.statusCode, 200);
    const cookieHeader = String(login.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0]!;
    const csrf = login.json().csrf;
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Strict/);
    assert.notEqual(login.json().actor.id, owner.actor.id);
    assert.equal(login.json().actor.principalId, owner.actor.id);
    assert.ok(!JSON.stringify(login.json()).includes(cookie.slice(cookie.indexOf('=') + 1)));
    const reused = await app.inject({
      method: 'POST',
      url: '/api/ui/login',
      headers: { host, origin },
      payload: { code }
    });
    assert.equal(reused.statusCode, 401);
    const bearer = await app.inject({
      url: '/api/session',
      headers: { host, authorization: `Bearer ${cookie.split('=')[1]}` }
    });
    assert.equal(bearer.statusCode, 401);
    const body = { workspaceId: workspace.id, title: 'Browser-owned draft', idempotencyKey: 'create' };
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/command/issue_create',
      headers: { host, origin, cookie },
      payload: body
    });
    assert.equal(missingCsrf.statusCode, 403);
    const created = await app.inject({
      method: 'POST',
      url: '/api/command/issue_create',
      headers: { host, origin, cookie, 'x-csrf-token': csrf },
      payload: body
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().result.issue.state, 'NOT_STARTED');
    const actor = store.get<any>('actor', login.json().actor.id);
    assert.equal(actor.role, 'human');
    const creation = store.db.prepare('SELECT actor_id FROM events WHERE operation=?').get('issue_create') as {
      actor_id: string;
    };
    assert.equal(creation.actor_id, actor.id);
    const pm = flow.execute(owner.actor, 'actor_enroll', {
      workspaceId: workspace.id,
      role: 'pm',
      name: 'Delegated fixture PM',
      idempotencyKey: 'pm'
    }) as any;
    const createdIssue = created.json().result.issue;
    const packet = flow.execute(owner.actor, 'issue_get', {
      workspaceId: workspace.id,
      issueId: createdIssue.id
    }) as any;
    const authorization = {
      workspaceId: workspace.id,
      issueId: createdIssue.id,
      expectedVersion: createdIssue.version,
      scopeHash: packet.authorizationScopeHash,
      granteeId: pm.actor.id,
      action: 'hold',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      reason: 'Automated browser fixture delegation',
      idempotencyKey: 'human-grant'
    };
    const csrfDenied = await app.inject({
      method: 'POST',
      url: '/api/command/grant_create',
      headers: { host, origin, cookie },
      payload: authorization
    });
    assert.equal(csrfDenied.statusCode, 403);
    const granted = await app.inject({
      method: 'POST',
      url: '/api/command/grant_create',
      headers: { host, origin, cookie, 'x-csrf-token': csrf },
      payload: authorization
    });
    assert.equal(granted.statusCode, 200);
    assert.equal(granted.json().result.grant.grantorId, actor.id);
    assert.ok(!agentOperations.includes('grant_create'));
    assert.ok(!agentOperations.includes('grant_revoke'));
    const logout = await app.inject({
      method: 'POST',
      url: '/api/ui/logout',
      headers: { host, origin, cookie, 'x-csrf-token': csrf },
      payload: {}
    });
    assert.equal(logout.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/session', headers: { host, cookie } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/ui/status', headers: { host, cookie } })).json().authenticated, false);
    assert.ok(!JSON.stringify(store.list('ui_session')).includes(cookie.split('=')[1]!));
  } finally {
    await app.close();
    store.close();
  }
});

test('browser sessions and pairing codes expire and cannot be replayed at the zero timestamp', () => {
  const store = new Store(':memory:');
  const owner = store.bootstrap();
  let clock = 0;
  const sessions = new WebSessions(store, () => clock);
  try {
    const code = sessions.createPairing(owner.actor).code;
    const paired = sessions.pair(code);
    assert.throws(
      () => sessions.pair(code),
      (e: any) => e.code === 'PAIRING_INVALID'
    );
    sessions.checkCsrf(paired.cookie, paired.csrf);
    assert.throws(
      () => sessions.checkCsrf(paired.cookie, '0'.repeat(64)),
      (e: any) => e.code === 'CSRF_DENIED'
    );
    sessions.revoke(paired.cookie);
    assert.throws(
      () => sessions.authenticate(paired.cookie),
      (e: any) => e.code === 'UNAUTHENTICATED'
    );
    const expired = sessions.createPairing(owner.actor).code;
    clock = 300001;
    assert.throws(
      () => sessions.pair(expired),
      (e: any) => e.code === 'PAIRING_INVALID'
    );
    const current = sessions.pair(sessions.createPairing(owner.actor).code);
    clock += 28800001;
    assert.throws(
      () => sessions.authenticate(current.cookie),
      (e: any) => e.code === 'UNAUTHENTICATED'
    );
  } finally {
    store.close();
  }
});

test('web projections are human-only, scoped, searchable, bounded and cursor-aware', () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-web-view-'));
  const store = new Store(':memory:');
  const owner = store.bootstrap().actor;
  const flow = new Workflow(store);
  const call = (operation: string, input: object) =>
    flow.execute(owner, operation, {
      ...(!operation.startsWith('ui_') ? { idempotencyKey: randomUUID() } : {}),
      ...input
    }) as any;
  try {
    const workspace = call('workspace_register', { root, name: 'Projection fixture', prefix: 'WEB' }).workspace;
    const other = call('workspace_register', { root: tmpdir(), name: 'Another project', prefix: 'ALT' }).workspace;
    call('issue_create', { workspaceId: other.id, title: 'Other private scope' });
    for (let index = 0; index < 25; index++)
      call('issue_create', {
        workspaceId: workspace.id,
        title: `Requirement ${index}`,
        description: index === 0 ? '<img src=x onerror=alert(1)>' : 'Fixture requirement'
      });
    const first = call('ui_workspace', { workspaceId: workspace.id });
    assert.equal(first.issues.length, 20);
    assert.equal(first.total, 25);
    assert.equal(first.nextOffset, 20);
    const next = call('ui_workspace', { workspaceId: workspace.id, offset: 20 });
    assert.equal(next.issues.length, 5);
    assert.equal(next.nextOffset, null);
    assert.equal(call('ui_workspace', { workspaceId: workspace.id, afterCursor: first.cursor }).unchanged, true);
    const search = call('ui_workspace', { workspaceId: workspace.id, search: 'Requirement 24' });
    assert.equal(search.issues.length, 1);
    const issue = first.issues[0];
    const current = () => store.get<any>('issue', issue.id);
    call('issue_update', {
      workspaceId: workspace.id,
      issueId: issue.id,
      expectedVersion: current().version,
      description: 'Current scope'
    });
    const detail = call('ui_issue', { workspaceId: workspace.id, issueId: issue.id, limit: 1 });
    assert.equal(detail.history.length, 1);
    assert.ok(detail.nextAfter);
    const history = call('ui_issue', { workspaceId: workspace.id, issueId: issue.id, after: detail.nextAfter });
    assert.ok(history.history.some((event: any) => event.operation === 'issue_update'));
    const parent = call('issue_create', { workspaceId: workspace.id, title: 'Parent——with delimiter' }).issue;
    const suffix = '[Feature] Naming: preserve suffix -> stable hierarchy';
    const child = call('issue_create', {
      workspaceId: workspace.id,
      parentId: parent.id,
      expectedParentVersion: parent.version,
      title: suffix
    }).issue;
    const displayed = call('ui_issue', { workspaceId: workspace.id, issueId: child.id }).issue;
    assert.equal(displayed.titleSuffix, suffix);
    assert.equal(displayed.title, `Parent——with delimiter——${suffix}`);
    call('issue_update', {
      workspaceId: workspace.id,
      issueId: parent.id,
      expectedVersion: store.get<any>('issue', parent.id).version,
      title: 'Renamed——parent'
    });
    const renamed = call('ui_issue', { workspaceId: workspace.id, issueId: child.id }).issue;
    assert.equal(renamed.id, child.id);
    assert.equal(renamed.titleSuffix, suffix);
    assert.equal(renamed.title, `Renamed——parent——${suffix}`);
    const worker = call('actor_enroll', { workspaceId: workspace.id, name: 'Worker', role: 'worker' }).actor;
    assert.throws(
      () => flow.execute(worker, 'ui_workspace', { workspaceId: workspace.id }),
      (e: any) => e.code === 'ROLE_DENIED'
    );
    assert.throws(
      () => call('ui_issue', { workspaceId: workspace.id, issueId: store.list<any>('issue', other.id)[0].id }),
      (e: any) => e.code === 'SCOPE_DENIED'
    );
    assert.ok(!agentOperations.some((name) => name.startsWith('ui_')));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale browser design dialog cannot silently approve a replacement revision', async () => {
  const store = new Store(':memory:');
  const owner = store.bootstrap();
  const flow = new Workflow(store);
  const app = createServer(store);
  const host = '127.0.0.1:43170';
  const origin = `http://${host}`;
  const call = (operation: string, input: object) =>
    flow.execute(owner.actor, operation, {
      ...(!operation.startsWith('ui_') ? { idempotencyKey: randomUUID() } : {}),
      ...input
    }) as any;
  try {
    const workspace = call('workspace_register', {
      root: tmpdir(),
      name: 'Stale dialog fixture',
      prefix: 'REV'
    }).workspace;
    const issue = call('issue_create', { workspaceId: workspace.id, title: 'Review exact content' }).issue;
    const change = (operation: string, input: object) =>
      call(operation, {
        workspaceId: workspace.id,
        issueId: issue.id,
        expectedVersion: store.get<any>('issue', issue.id).version,
        ...input
      });
    change('design_set', { content: 'Revision one', criteria: ['AC'] });
    change('design_submit', {});
    const captured = call('ui_issue', { workspaceId: workspace.id, issueId: issue.id });
    const pair = await app.inject({
      method: 'POST',
      url: '/api/ui/pairing',
      headers: { host, authorization: `Bearer ${owner.token}` },
      payload: {}
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/ui/login',
      headers: { host, origin },
      payload: { code: pair.json().code }
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    change('design_set', { content: 'Revision two', criteria: ['AC'] });
    change('design_submit', {});
    const response = await app.inject({
      method: 'POST',
      url: '/api/command/design_decide',
      headers: { host, origin, cookie, 'x-csrf-token': login.json().csrf },
      payload: {
        workspaceId: workspace.id,
        issueId: issue.id,
        expectedVersion: captured.issue.version,
        designId: captured.design.id,
        decision: 'APPROVED',
        reason: 'Fixture stale browser decision',
        idempotencyKey: randomUUID()
      }
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'VERSION_CONFLICT');
    assert.equal(store.list('approval', workspace.id).length, 0);
  } finally {
    await app.close();
    store.close();
  }
});

test('built web entry and direct issue links load without exposing private files or owner credentials', async () => {
  const store = new Store(':memory:');
  const owner = store.bootstrap();
  const app = createServer(store);
  const headers = { host: '127.0.0.1:43170' };
  try {
    const entry = await app.inject({ url: '/', headers });
    assert.equal(entry.statusCode, 200);
    assert.match(entry.body, /AgileDev/);
    assert.ok(!entry.body.includes(owner.token));
    assert.match(String(entry.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(entry.headers['referrer-policy'], 'no-referrer');
    const asset = entry.body.match(/src="([^"]+\.js)"/)![1]!;
    const script = await app.inject({ url: asset, headers });
    assert.equal(script.statusCode, 200);
    assert.ok(!script.body.includes(owner.token));
    const direct = await app.inject({ url: '/w/workspace/issues/issue', headers });
    assert.equal(direct.statusCode, 200);
    assert.match(direct.body, /AgileDev/);
    assert.equal((await app.inject({ url: '/assets/../../package.json', headers })).statusCode, 401);
    assert.equal((await app.inject({ url: '/assets/missing.js', headers })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/session', headers })).statusCode, 401);
  } finally {
    await app.close();
    store.close();
  }
});
