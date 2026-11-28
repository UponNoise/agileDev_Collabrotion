import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consultLauncherIdentity } from '../src/consult-verification.js';
import { DomainError, harnesses, type Actor, type Harness, type Issue, type Run } from '../src/contracts.js';
import { harnessDiagnostics } from '../src/diagnostics.js';
import {
  agyCapabilities,
  dispatchOpen,
  loadDispatchVerifications,
  readDispatchVerification,
  recordDispatchVerification,
  type DispatchVerification,
} from '../src/dispatch-verification.js';
import type { HarnessEntry } from '../src/harness.js';
import { createServer } from '../src/http.js';
import { commandFailure } from '../src/issue-brief.js';
import { Coordinator } from '../src/runner.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';

function makeRecord(
  launcher: string,
  version = '1.5.16',
  overrides: Partial<DispatchVerification['capabilities']> = {},
): Omit<DispatchVerification, 'policy'> {
  return {
    harness: 'agy',
    launcher,
    version,
    verifiedAt: Date.now(),
    capabilities: {
      ...(Object.fromEntries(agyCapabilities.map(c => [c, 'CONFIRMED'])) as DispatchVerification['capabilities']),
      ...overrides,
    },
  };
}

function fakeAgySetup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-agy-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const versionFile = join(root, 'version.txt');
  writeFileSync(versionFile, '1.5.16');
  const script = join(root, 'fake-agy.mjs');
  writeFileSync(script, [
    "import { readFileSync } from 'node:fs';",
    `if (process.argv.includes('--version')) console.log(readFileSync(${JSON.stringify(versionFile)}, 'utf8').trim());`,
  ].join('\n'));
  const entry: HarnessEntry = { id: 'agy', command: process.execPath, args: [script] };
  return { root, versionFile, script, entry };
}

test('dispatch verification records round-trip, reject invalid schemas, and drop stale launchers/versions', async t => {
  const f = fakeAgySetup(t);
  const dir = join(f.root, 'data');
  const launcher = consultLauncherIdentity(f.entry)!;
  assert.ok(launcher);

  const evidence = makeRecord(launcher);
  recordDispatchVerification(dir, evidence);
  assert.deepEqual(readdirSync(dir), ['dispatch-agy.json']);
  const loaded = readDispatchVerification(dir, 'agy');
  assert.deepEqual(loaded, { ...evidence, policy: 1 });
  assert.equal(dispatchOpen(loaded!), true);
  assert.equal(dispatchOpen({ ...loaded!, capabilities: { ...loaded!.capabilities, COMMAND_EXECUTION: 'UNAVAILABLE' } }), true);
  assert.equal(dispatchOpen({ ...loaded!, capabilities: { ...loaded!.capabilities, HEADLESS_RUN: 'NOT_RUN' } }), false);

  const discovery = () => [f.entry];
  assert.equal((await loadDispatchVerifications(dir, discovery)).has('agy'), true);

  writeFileSync(f.versionFile, '1.5.17');
  assert.equal((await loadDispatchVerifications(dir, discovery)).has('agy'), false);

  writeFileSync(f.versionFile, '1.5.16');
  writeFileSync(f.script, '// modified launcher');
  assert.equal((await loadDispatchVerifications(dir, discovery)).has('agy'), false);

  writeFileSync(join(dir, 'dispatch-agy.json'), JSON.stringify({ ...loaded, extraField: true }));
  assert.equal(readDispatchVerification(dir, 'agy'), undefined);

  writeFileSync(join(dir, 'dispatch-agy.json'), 'not json');
  assert.equal(readDispatchVerification(dir, 'agy'), undefined);
});

function workflowFixture(t: TestContext, dispatchAvailable?: (harness: Harness) => boolean) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-agy-wf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const flow = new Workflow(store, Date.now, undefined, dispatchAvailable);
  const owner = store.bootstrap();
  const write = (actor: Actor, op: string, input: object) =>
    flow.execute(actor, op, { idempotencyKey: randomUUID(), ...input }) as any;
  const { workspace } = write(owner.actor, 'workspace_register', { root: source, name: 'Gate fixture', prefix: 'AGT' });
  const enroll = (role: Actor['role']) => write(owner.actor, 'actor_enroll', { workspaceId: workspace.id, role, name: `Test ${role}` }) as { actor: Actor; token: string };
  const lead = enroll('lead'), pm = enroll('pm'), worker = enroll('worker'), qa = enroll('qa');
  const { issue: parent } = write(lead.actor, 'issue_create', {
    workspaceId: workspace.id, title: 'Parent', description: 'Parent desc', criteria: ['C1'],
    artifactMode: 'artifact', artifactReason: 'Test fixture',
  });
  write(lead.actor, 'design_set', {
    workspaceId: workspace.id, issueId: parent.id, expectedVersion: 1, content: 'Design', criteria: ['C1'],
  });
  write(lead.actor, 'design_submit', { workspaceId: workspace.id, issueId: parent.id, expectedVersion: 2 });
  const brief = flow.execute(owner.actor, 'issue_get', { workspaceId: workspace.id, issueId: parent.id }) as any;
  write(owner.actor, 'design_decide', {
    workspaceId: workspace.id, issueId: parent.id, expectedVersion: 3,
    designId: brief.design.id, designHash: brief.design.hash, riskHash: brief.designRisks.hash,
    decision: 'APPROVED', reason: 'Fixture setup',
  });
  const taskTitle = '[Test] Gate: check verification -> blocks unverified agy';
  const { issue: task } = write(pm.actor, 'issue_create', {
    workspaceId: workspace.id, parentId: parent.id, expectedParentVersion: store.get<Issue>('issue', parent.id).version,
    title: taskTitle, description: 'Task desc', criteria: ['C1'],
  });
  write(pm.actor, 'plan_apply', {
    workspaceId: workspace.id, issueId: parent.id, expectedVersion: store.get<Issue>('issue', parent.id).version,
    expectedPlanId: null, designId: brief.design.id, mode: 'READY', reason: 'Fixture plan',
    tasks: [{
      ref: 't1', issueId: task.id, expectedVersion: store.get<Issue>('issue', task.id).version,
      title: taskTitle, description: 'Task desc', criteria: ['C1'], dependencies: [],
    }],
  });
  const { profile } = write(owner.actor, 'check_profile_create', {
    workspaceId: workspace.id, name: 'Check', command: process.execPath, args: ['.qa/check.mjs'], criteria: ['C1'],
  });
  return { root, store, flow, owner, lead, pm, worker, qa, workspace, parent, task, taskTitle, designId: brief.design.id as string, profile, write };
}

test('Workflow dispatch gate enforces HARNESS_NOT_VERIFIED on assignment, QA, planning, and dispatch without breaking active runs', t => {
  let agyOpen = false;
  const f = workflowFixture(t, harness => harness !== 'agy' || agyOpen);

  assert.deepEqual(
    (f.flow.execute(f.owner.actor, 'ui_workspace', { workspaceId: f.workspace.id }) as any).dispatchHarnesses,
    ['codex', 'claude-code', 'dsh'],
  );

  const beforeVersion = f.store.get<Issue>('issue', f.task.id).version;
  assert.throws(
    () => f.write(f.pm.actor, 'issue_assign', {
      workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: beforeVersion,
      actorId: f.worker.actor.id, harness: 'agy',
    }),
    (err: unknown) => err instanceof DomainError && err.code === 'HARNESS_NOT_VERIFIED',
  );
  assert.equal(f.store.get<Issue>('issue', f.task.id).version, beforeVersion);

  assert.throws(
    () => f.write(f.pm.actor, 'qa_configure', {
      workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: beforeVersion,
      actorId: f.qa.actor.id, harness: 'agy', checkProfileIds: [f.profile.id],
    }),
    (err: unknown) => err instanceof DomainError && err.code === 'HARNESS_NOT_VERIFIED',
  );
  assert.equal(f.store.get<Issue>('issue', f.task.id).version, beforeVersion);

  const parentVersionBefore = f.store.get<Issue>('issue', f.parent.id).version;
  assert.throws(
    () => f.write(f.pm.actor, 'plan_apply', {
      workspaceId: f.workspace.id, issueId: f.parent.id, expectedVersion: parentVersionBefore,
      expectedPlanId: f.store.get<Issue>('issue', f.parent.id).planId!, designId: f.designId, mode: 'READY', reason: 'Assign agy',
      tasks: [{
        ref: 't1', issueId: f.task.id, expectedVersion: beforeVersion,
        title: f.taskTitle, description: 'Task desc', criteria: ['C1'], dependencies: [],
        assigneeId: f.worker.actor.id, harness: 'agy',
      }],
    }),
    (err: unknown) => err instanceof DomainError && err.code === 'HARNESS_NOT_VERIFIED',
  );
  assert.equal(f.store.get<Issue>('issue', f.parent.id).version, parentVersionBefore);
  assert.equal(f.store.get<Issue>('issue', f.task.id).harness, null);

  const remedy = commandFailure('HARNESS_NOT_VERIFIED', '');
  assert.equal(remedy.remedy.role, 'human');
  assert.match(remedy.remedy.action, /verify-agy --record/);

  // Open gate, assign & dispatch, then close gate while run is in flight
  agyOpen = true;
  assert.deepEqual(
    (f.flow.execute(f.owner.actor, 'ui_workspace', { workspaceId: f.workspace.id }) as any).dispatchHarnesses,
    [...harnesses],
  );
  f.write(f.pm.actor, 'issue_assign', {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: beforeVersion,
    actorId: f.worker.actor.id, harness: 'agy',
  });
  f.write(f.pm.actor, 'qa_configure', {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
    actorId: f.qa.actor.id, harness: 'agy', checkProfileIds: [f.profile.id],
  });

  // Close gate before dispatch: issue_get & work_dispatch reflect HARNESS_NOT_VERIFIED
  agyOpen = false;
  const blockedBrief = f.flow.execute(f.pm.actor, 'issue_get', { workspaceId: f.workspace.id, issueId: f.task.id }) as any;
  const blocker = blockedBrief.blockers.find((b: any) => b.code === 'HARNESS_NOT_VERIFIED');
  assert.ok(blocker);
  assert.equal(blocker.remedy.role, 'human');
  assert.ok(!blockedBrief.nextActions.some((a: any) => a.operation === 'work_dispatch'));
  assert.throws(
    () => f.write(f.pm.actor, 'work_dispatch', {
      workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
      designId: f.designId, scopeRevision: 1,
    }),
    (err: unknown) => err instanceof DomainError && err.code === 'NOT_READY' && (err.details as any).blockers.includes('HARNESS_NOT_VERIFIED'),
  );

  // Unassigning an agy issue while gate is closed is allowed
  f.write(f.pm.actor, 'issue_assign', {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
    actorId: null, harness: null,
  });
  agyOpen = true;
  f.write(f.pm.actor, 'issue_assign', {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
    actorId: f.worker.actor.id, harness: 'agy',
  });

  // Dispatch while open, claim, close gate, verify heartbeat & submit succeed
  const { run: dispatchedRun } = f.write(f.pm.actor, 'work_dispatch', {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
    designId: f.designId, scopeRevision: 1,
  }) as { run: Run };
  const execRoot = join(f.root, 'runs', dispatchedRun.id, 'workspace');
  mkdirSync(execRoot, { recursive: true });
  writeFileSync(join(execRoot, 'out.txt'), 'ok');
  const execActor: Actor = {
    id: randomUUID(), role: 'worker', name: 'In-flight worker', principalId: f.worker.actor.id,
    runId: dispatchedRun.id, workspaceIds: [f.workspace.id], sessionId: randomUUID(),
  };
  f.store.token(execActor);
  dispatchedRun.state = 'STARTING';
  dispatchedRun.coordinatorId = 'coord-1';
  dispatchedRun.executionActorId = execActor.id;
  dispatchedRun.executionRoot = execRoot;
  f.store.put('run', dispatchedRun, f.workspace.id);
  f.flow.claimReservedWork(execActor, {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
    designId: f.designId, scopeRevision: 1, idempotencyKey: randomUUID(),
  });
  dispatchedRun.state = 'RUNNING';
  dispatchedRun.providerSessionId = 'provider-1';
  f.store.put('run', dispatchedRun, f.workspace.id);

  agyOpen = false;
  f.write(execActor, 'work_heartbeat', {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
    fence: f.store.get<Issue>('issue', f.task.id).fence,
  });
  const submitted = f.write(execActor, 'work_submit', {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
    fence: f.store.get<Issue>('issue', f.task.id).fence, summary: 'Done', files: ['out.txt'],
  });
  assert.equal(submitted.issue.state, 'LEAD_REVIEW');
});

test('Workflow without dispatchAvailable leaves every harness including agy dispatchable', async t => {
  const f = workflowFixture(t);
  assert.deepEqual(
    (f.flow.execute(f.owner.actor, 'ui_workspace', { workspaceId: f.workspace.id }) as any).dispatchHarnesses,
    [...harnesses],
  );
  f.write(f.pm.actor, 'issue_assign', {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
    actorId: f.worker.actor.id, harness: 'agy',
  });
  const { run } = f.write(f.pm.actor, 'work_dispatch', {
    workspaceId: f.workspace.id, issueId: f.task.id, expectedVersion: f.store.get<Issue>('issue', f.task.id).version,
    designId: f.designId, scopeRevision: 1,
  });
  assert.equal(run.harness, 'agy');

  const app = createServer(f.store, undefined, {
    consultAvailable: () => false,
    dispatchAvailable: harness => harness !== 'agy',
  });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/command/ui_workspace',
    headers: { host: '127.0.0.1:43170', authorization: `Bearer ${f.owner.token}` },
    payload: { workspaceId: f.workspace.id },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().result.dispatchHarnesses, ['codex', 'claude-code', 'dsh']);
});

test('harnessDiagnostics for agy reports UNKNOWN without a record, recorded states with a fresh one, and STALE after version change', async t => {
  const f = fakeAgySetup(t);
  const dataDir = join(f.root, 'data');
  const launcher = consultLauncherIdentity(f.entry)!;

  const missing = await harnessDiagnostics(f.entry, { dataDir, version: '1.5.16' });
  assert.deepEqual(missing.find(d => d.id === 'DISPATCH'), { id: 'DISPATCH', state: 'UNKNOWN', detail: 'NOT_VERIFIED' });
  assert.deepEqual(missing.find(d => d.id === 'MCP_ISOLATION'), { id: 'MCP_ISOLATION', state: 'UNKNOWN', detail: 'NOT_VERIFIED' });
  for (const cap of agyCapabilities) {
    assert.deepEqual(missing.find(d => d.id === `CAPABILITY_${cap}`), { id: `CAPABILITY_${cap}`, state: 'UNKNOWN' });
  }

  recordDispatchVerification(dataDir, makeRecord(launcher, '1.5.16', {
    MCP_ISOLATION: 'NOT_RUN',
    COMMAND_EXECUTION: 'UNAVAILABLE',
  }));
  const partial = await harnessDiagnostics(f.entry, { dataDir, version: '1.5.16' });
  assert.deepEqual(partial.find(d => d.id === 'DISPATCH'), { id: 'DISPATCH', state: 'UNAVAILABLE' });
  assert.deepEqual(partial.find(d => d.id === 'CAPABILITY_HEADLESS_RUN'), { id: 'CAPABILITY_HEADLESS_RUN', state: 'CONFIRMED' });
  assert.deepEqual(partial.find(d => d.id === 'CAPABILITY_MCP_ISOLATION'), { id: 'CAPABILITY_MCP_ISOLATION', state: 'UNKNOWN' });
  assert.deepEqual(partial.find(d => d.id === 'CAPABILITY_COMMAND_EXECUTION'), { id: 'CAPABILITY_COMMAND_EXECUTION', state: 'UNAVAILABLE' });
  assert.deepEqual(partial.find(d => d.id === 'MCP_ISOLATION'), {
    id: 'MCP_ISOLATION',
    state: 'UNKNOWN',
    detail: 'private home only; loaded servers not observable',
  });

  recordDispatchVerification(dataDir, makeRecord(launcher, '1.5.16', {
    MCP_ISOLATION: 'UNAVAILABLE',
  }));
  const unisolated = await harnessDiagnostics(f.entry, { dataDir, version: '1.5.16' });
  assert.deepEqual(unisolated.find(d => d.id === 'MCP_ISOLATION'), { id: 'MCP_ISOLATION', state: 'NOT_GUARANTEED' });

  recordDispatchVerification(dataDir, makeRecord(launcher, '1.5.16'));
  const confirmed = await harnessDiagnostics(f.entry, { dataDir, version: '1.5.16' });
  assert.deepEqual(confirmed.find(d => d.id === 'DISPATCH'), { id: 'DISPATCH', state: 'CONFIRMED' });
  assert.deepEqual(confirmed.find(d => d.id === 'MCP_ISOLATION'), { id: 'MCP_ISOLATION', state: 'ENFORCED' });

  writeFileSync(f.versionFile, '1.5.17');
  const stale = await harnessDiagnostics(f.entry, { dataDir });
  assert.deepEqual(stale.find(d => d.id === 'DISPATCH'), { id: 'DISPATCH', state: 'UNKNOWN', detail: 'STALE' });
  assert.deepEqual(stale.find(d => d.id === 'MCP_ISOLATION'), { id: 'MCP_ISOLATION', state: 'UNKNOWN', detail: 'STALE' });
  for (const cap of agyCapabilities) {
    assert.deepEqual(stale.find(d => d.id === `CAPABILITY_${cap}`), { id: `CAPABILITY_${cap}`, state: 'UNKNOWN' });
  }
});
