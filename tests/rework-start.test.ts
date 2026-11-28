import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store, hash } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Actor, Issue, Run, Snapshot } from '../src/contracts.js';
import { Coordinator } from '../src/runner.js';
import { AdapterContext, AdapterResult, ExecutionAdapter } from '../src/adapters.js';
import { createServer } from '../src/http.js';
import { LocalClient } from '../src/client.js';
import { applyFixturePlan, executeFixture } from './fixtures.js';

async function until(check: () => boolean, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Expected state did not arrive'); await new Promise(done => setTimeout(done, 20)); }
}
class ProviderDouble implements ExecutionAdapter {
  contexts: AdapterContext[] = [];
  finish = new Map<string, (result: AdapterResult) => void>();
  async start(context: AdapterContext) {
    this.contexts.push(context); context.onProvider(`test-session-${randomUUID()}`);
    return { result: new Promise<AdapterResult>(done => this.finish.set(context.cwd, done)), interrupt: async () => { this.finish.get(context.cwd)?.({ outcome: 'cancelled' }); return true; } };
  }
}
const gitOut = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const tracked = (cwd: string) => gitOut(cwd, 'ls-files').split('\n').filter(Boolean).sort();
const manifest = (snapshot: Snapshot) => snapshot.files.map(file => file.path).sort();

async function fixture(git = true) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-rework-')); const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'source.txt'), 'original'); writeFileSync(join(source, 'contract.txt'), 'preserve this independent file');
  if (git) {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: source, windowsHide: true, stdio: 'ignore' });
    run('init'); run('add', '.'); run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
  }
  const store = new Store(join(root, 'workflow.sqlite')); const flow = new Workflow(store); const human = store.bootstrap().actor;
  const call = (actor: Actor, op: string, input: object) => executeFixture(flow, actor, op, { idempotencyKey: randomUUID(), ...input }) as any;
  const workspace = call(human, 'workspace_register', { root: source, name: 'Rework fixture', prefix: 'RW' }).workspace;
  const run = (op: string, input: object) => call(human, op, { workspaceId: workspace.id, ...input });
  const current = (id: string) => store.get<Issue>('issue', id);
  const change = (op: string, id: string, input: object = {}, actor = human) => call(actor, op, { workspaceId: workspace.id, issueId: id, expectedVersion: current(id).version, ...input });
  const parent = run('issue_create', { title: 'Rework pipeline', description: 'Deliver exact content', criteria: ['FILE'], artifactMode: 'artifact', artifactReason: 'Disposable test of non-code artifact delivery' }).issue;
  change('design_set', parent.id, { content: 'source.txt must contain delivered. Test the actual delivered source.', criteria: ['FILE'] });
  change('design_submit', parent.id); change('design_decide', parent.id, { designId: current(parent.id).designId, decision: 'APPROVED', reason: 'Automated test fixture approval only' });
  const issue = run('issue_create', { parentId: parent.id, expectedParentVersion: current(parent.id).version, title: '[Test] Content: deliver exact output -> verified artifact', description: 'source.txt must be exactly delivered', criteria: ['FILE'] }).issue;
  const worker = run('actor_enroll', { role: 'worker', name: 'Worker' }).actor;
  const lead = run('actor_enroll', { role: 'lead', name: 'Lead' }).actor;
  const qa = run('actor_enroll', { role: 'qa', name: 'Independent QA' }).actor;
  const profile = run('check_profile_create', { name: 'Independent Node check', command: process.execPath, args: ['.qa/check.mjs'], criteria: ['FILE'], timeoutMs: 5000 }).profile;
  change('issue_assign', issue.id, { actorId: worker.id, harness: 'codex' }); change('qa_configure', issue.id, { actorId: qa.id, harness: 'dsh', checkProfileIds: [profile.id] });
  applyFixturePlan(flow, human, parent.id);
  const dispatch = (start?: 'candidate' | 'workspace') => change('work_dispatch', issue.id, { designId: current(parent.id).designId, scopeRevision: current(issue.id).scopeRevision, ...(start ? { start } : {}) }).run as Run;
  const first = dispatch();
  const app = createServer(store); const endpoint = await app.listen({ host: '127.0.0.1', port: 0 }); const adapter = new ProviderDouble();
  const coordinator = new Coordinator(store, { endpoint, directory: join(root, 'runs'), bridgeScript: resolve('dist/cli.js'), adapter });
  const tickUntil = async (check: () => boolean) => { const deadline = Date.now() + 15000; while (!check()) { if (Date.now() > deadline) throw new Error('Expected state did not arrive'); await coordinator.tick(); await new Promise(done => setTimeout(done, 20)); } };
  const context = async (index: number) => { await tickUntil(() => adapter.contexts.length > index); return adapter.contexts[index]!; };
  const complete = async (ctx: AdapterContext) => {
    const actor = store.authenticate(ctx.token); adapter.finish.get(ctx.cwd)!({ outcome: 'succeeded' });
    await until(() => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN'].includes(store.get<Run>('run', actor.runId!).state));
    return store.get<Run>('run', actor.runId!);
  };
  const submit = async (ctx: AdapterContext, content: string, options: { add?: Record<string, string>; remove?: string[]; files?: string[] } = {}) => {
    writeFileSync(join(ctx.cwd, 'source.txt'), content);
    for (const [name, text] of Object.entries(options.add ?? {})) writeFileSync(join(ctx.cwd, name), text);
    for (const name of options.remove ?? []) rmSync(join(ctx.cwd, name));
    const i = current(issue.id);
    await new LocalClient(endpoint, ctx.token).command('work_submit', { workspaceId: workspace.id, issueId: issue.id, expectedVersion: i.version, fence: i.fence, summary: 'Fixture delivery', files: options.files ?? ['source.txt'], idempotencyKey: randomUUID() });
    assert.equal((await complete(ctx)).state, 'SUCCEEDED');
    return store.get<Snapshot>('snapshot', current(issue.id).candidate!.snapshotId!);
  };
  const review = (verdict: 'PASS' | 'FAIL') => change('review_submit', issue.id, { candidateId: current(issue.id).candidate!.id, verdict, reason: 'Fixture review' }, lead);
  const close = async () => { await coordinator.close(); await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, source, workspace, issue, parent, store, flow, human, qa, profile, adapter, coordinator, current, change, dispatch, first, context, tickUntil, complete, submit, review, close, endpoint };
}
const restored = (cwd: string, snapshot: Snapshot) => {
  for (const file of snapshot.files) assert.equal(hash(readFileSync(join(cwd, file.path))), file.hash, file.path);
};
const workspaceUntouched = (f: Awaited<ReturnType<typeof fixture>>, head: string) => {
  assert.equal(readFileSync(join(f.source, 'source.txt'), 'utf8'), 'original');
  assert.equal(readFileSync(join(f.source, 'contract.txt'), 'utf8'), 'preserve this independent file');
  assert.equal(existsSync(join(f.source, 'added.txt')), false);
  assert.equal(gitOut(f.source, 'status', '--porcelain'), '');
  assert.equal(gitOut(f.source, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(gitOut(f.source, 'branch', '--list').trim().split('\n').length, 1);
};

test('a rework after lead and user rejection continues from the rejected delivery in an isolated worktree', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const head = gitOut(f.source, 'rev-parse', 'HEAD').trim();
    const worker = await f.context(0);
    assert.deepEqual(f.store.get<Run>('run', f.first.id).base, { kind: 'workspace', reason: 'NOT_REJECTED' });
    const sealed = await f.submit(worker, 'v1', { add: { 'added.txt': 'new file' }, remove: ['contract.txt'], files: ['source.txt', 'added.txt'] });
    assert.deepEqual(manifest(sealed), ['added.txt', 'source.txt']);
    const candidate = f.current(f.issue.id).candidate!;
    f.review('FAIL'); assert.equal(f.current(f.issue.id).state, 'LEAD_REJECTED');

    const queued = f.dispatch();
    assert.deepEqual(queued.base, { kind: 'candidate', candidateId: candidate.id, snapshotId: sealed.id, baseSha: candidate.baseSha });
    const event = f.store.db.prepare("SELECT data FROM events WHERE operation='work_dispatch' ORDER BY sequence DESC").get() as { data: string };
    assert.deepEqual(JSON.parse(event.data).base, queued.base);
    const rework = await f.context(1);
    const started = f.store.db.prepare("SELECT data FROM events WHERE operation='run_starting' ORDER BY sequence DESC").get() as { data: string };
    assert.deepEqual(JSON.parse(started.data).base, queued.base);
    assert.deepEqual(tracked(rework.cwd), manifest(sealed));
    restored(rework.cwd, sealed);
    assert.equal(existsSync(join(rework.cwd, 'contract.txt')), false);
    const status = gitOut(rework.cwd, 'status', '--porcelain');
    assert.match(status, /^A {2}added\.txt$/m); assert.match(status, /^M {2}source\.txt$/m); assert.match(status, /^D {2}contract\.txt$/m);
    assert.equal(gitOut(rework.cwd, 'rev-parse', 'HEAD').trim(), candidate.baseSha);
    assert.match(rework.prompt, /Rework start: the previous delivery/);
    assert.ok(rework.prompt.includes('source.txt, added.txt'));
    workspaceUntouched(f, head);

    const second = await f.submit(rework, 'v2');
    assert.deepEqual(manifest(second), ['added.txt', 'source.txt']);
    assert.equal(readFileSync(join(second.root, 'added.txt'), 'utf8'), 'new file');
    assert.equal(readFileSync(join(second.root, 'source.txt'), 'utf8'), 'v2');

    const stored = f.current(f.issue.id); stored.state = 'USER_REJECTED'; stored.stage = null; f.store.put('issue', stored, f.workspace.id);
    f.store.put('delivery_approval', { id: randomUUID(), issueId: f.issue.id, candidateId: stored.candidate!.id, actorId: f.human.id, decision: 'REJECT', reason: 'Fixture user rejection', at: new Date().toISOString() }, f.workspace.id);
    const again = f.dispatch(); assert.equal(again.base?.kind, 'candidate');
    const third = await f.context(2);
    assert.deepEqual(tracked(third.cwd), manifest(second));
    restored(third.cwd, second);
    workspaceUntouched(f, head);
  } finally { await f.close(); }
});

test('a rework after QA rejection continues from the delivery; QA runs carry no base', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const worker = await f.context(0);
    const sealed = await f.submit(worker, 'incorrect', { add: { 'added.txt': 'new file' }, files: ['source.txt', 'added.txt'] });
    f.review('PASS');
    const qa = await f.context(1);
    const qaRun = f.store.get<Run>('run', f.store.authenticate(qa.token).runId!);
    assert.equal(qaRun.kind, 'qa'); assert.equal(qaRun.base, undefined);
    mkdirSync(join(qa.cwd, '.qa'), { recursive: true });
    writeFileSync(join(qa.cwd, '.qa/check.mjs'), `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(readFileSync('source.txt','utf8'),'delivered');`);
    const client = new LocalClient(f.endpoint, qa.token);
    const check = (await client.command('qa_check_run', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: f.current(f.issue.id).version, profileId: f.profile.id, testFiles: ['.qa/check.mjs'], idempotencyKey: randomUUID() })).check;
    await f.tickUntil(() => ['PASSED', 'FAILED', 'UNCERTAIN'].includes((f.store.get<any>('check', check.id)).state));
    assert.equal(f.store.get<any>('check', check.id).state, 'FAILED');
    await client.command('qa_report_submit', { workspaceId: f.workspace.id, issueId: f.issue.id, expectedVersion: f.current(f.issue.id).version, candidateId: f.current(f.issue.id).candidate!.id, verdict: 'FAIL', summary: 'Wrong content', results: [{ criterionId: 'FILE', result: 'FAIL', evidenceIds: [check.id], reason: 'Observed wrong content' }], findings: [{ criterionId: 'FILE', severity: 'MAJOR', expected: 'delivered', actual: 'incorrect', reproduce: 'Run the captured check' }], idempotencyKey: randomUUID() });
    await f.complete(qa);
    assert.equal(f.current(f.issue.id).state, 'QA_REJECTED');
    f.dispatch();
    const rework = await f.context(2);
    assert.deepEqual(tracked(rework.cwd), manifest(sealed));
    restored(rework.cwd, sealed);
    assert.equal(readFileSync(join(rework.cwd, 'source.txt'), 'utf8'), 'incorrect');
  } finally { await f.close(); }
});

test('every workspace-start reason is recorded and nothing starts without a dispatch', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const worker = await f.context(0);
    const sealed = await f.submit(worker, 'v1');
    const candidate = f.current(f.issue.id).candidate!; f.review('FAIL');
    const produced = f.store.get<Run>('run', candidate.runId!);
    const patchIssue = (patch: (i: Issue) => void) => { const before = f.current(f.issue.id); const copy = structuredClone(before); patch(copy); f.store.put('issue', copy, f.workspace.id); return () => { const latest = f.current(f.issue.id); latest.state = before.state; latest.candidate = before.candidate; f.store.put('issue', latest, f.workspace.id); }; };
    const cases: [string, 'candidate' | 'workspace' | undefined, () => () => void][] = [
      ['NOT_REJECTED', undefined, () => patchIssue(i => { i.candidate = { ...i.candidate!, id: 'candidate-without-rejection' }; })],
      ['REQUESTED', 'workspace', () => () => {}],
      ['NO_CANDIDATE', undefined, () => patchIssue(i => { i.candidate = null; })],
      ['NOT_SEALED', undefined, () => patchIssue(i => { i.candidate = { ...i.candidate!, snapshotId: undefined }; })],
      ['DESIGN_CHANGED', undefined, () => patchIssue(i => { i.candidate = { ...i.candidate!, designId: 'earlier-design' }; })],
      ['SCOPE_CHANGED', undefined, () => { f.store.put('run', { ...produced, scopeRevision: 99 }, f.workspace.id); return () => f.store.put('run', produced, f.workspace.id); }],
      ['ARTIFACT_MODE', undefined, () => { f.store.put('snapshot', { ...sealed, files: sealed.files.map(({ blob, ...file }) => file) }, f.workspace.id); return () => f.store.put('snapshot', sealed, f.workspace.id); }]
    ];
    for (const [reason, start, mutate] of cases) {
      const undo = mutate();
      const queued = f.dispatch(start);
      assert.deepEqual(queued.base, { kind: 'workspace', reason }, reason);
      f.store.put('run', { ...queued, state: 'CANCELLED' }, f.workspace.id); undo();
    }
    assert.equal(f.adapter.contexts.length, 1);
    assert.equal(f.dispatch().base?.kind, 'candidate');
  } finally { await f.close(); }
});

test('a missing base commit or a tampered snapshot ends before any harness starts, and a workspace start recovers', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const worker = await f.context(0);
    const sealed = await f.submit(worker, 'v1', { add: { 'added.txt': 'new file' }, files: ['source.txt', 'added.txt'] });
    f.review('FAIL');
    const broken = f.dispatch();
    f.store.put('run', { ...broken, base: { ...broken.base!, baseSha: '0'.repeat(40) } as Run['base'] }, f.workspace.id);
    await f.tickUntil(() => f.store.get<Run>('run', broken.id).state === 'FAILED');
    let failed = f.store.get<Run>('run', broken.id);
    assert.equal(failed.errorCode, 'REWORK_BASE_UNAVAILABLE'); assert.match(failed.summary!, /dispatch again from the workspace/);
    assert.equal(f.adapter.contexts.length, 1);
    assert.equal(f.current(f.issue.id).state, 'LEAD_REJECTED'); assert.equal(f.current(f.issue.id).lease, null);
    assert.equal(existsSync(join(f.root, 'runs', broken.id, 'workspace')), false);
    assert.equal(gitOut(f.source, 'worktree', 'list', '--porcelain').includes(broken.id), false);

    const tampered = f.dispatch();
    writeFileSync(join(sealed.root, 'source.txt'), 'tampered');
    await f.tickUntil(() => f.store.get<Run>('run', tampered.id).state === 'FAILED');
    failed = f.store.get<Run>('run', tampered.id);
    assert.equal(failed.errorCode, 'REWORK_BASE_UNAVAILABLE'); assert.equal(f.adapter.contexts.length, 1);
    assert.equal(f.current(f.issue.id).state, 'LEAD_REJECTED');

    const fresh = f.dispatch('workspace'); assert.deepEqual(fresh.base, { kind: 'workspace', reason: 'REQUESTED' });
    const rework = await f.context(1);
    assert.equal(readFileSync(join(rework.cwd, 'contract.txt'), 'utf8'), 'preserve this independent file');
    assert.equal(existsSync(join(rework.cwd, 'added.txt')), false);
    assert.equal(readFileSync(join(rework.cwd, 'source.txt'), 'utf8'), 'original');
  } finally { await f.close(); }
});

test('a rework that failed before submitting still continues from the returned delivery', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const head = gitOut(f.source, 'rev-parse', 'HEAD').trim();
    const worker = await f.context(0);
    const sealed = await f.submit(worker, 'v1', { add: { 'added.txt': 'new file' }, remove: ['contract.txt'], files: ['source.txt', 'added.txt'] });
    const candidate = f.current(f.issue.id).candidate!;
    f.review('FAIL');
    const first = f.dispatch(); assert.equal(first.base?.kind, 'candidate');
    const failing = await f.context(1);
    f.adapter.finish.get(failing.cwd)!({ outcome: 'failed', errorCode: 'PROVIDER_FAILED' });
    await f.tickUntil(() => f.store.get<Run>('run', first.id).state === 'FAILED');
    const returned = f.current(f.issue.id);
    assert.equal(returned.state, 'NOT_STARTED'); assert.equal(returned.candidate?.id, candidate.id);

    const again = f.dispatch();
    assert.deepEqual(again.base, { kind: 'candidate', candidateId: candidate.id, snapshotId: sealed.id, baseSha: candidate.baseSha });
    const rework = await f.context(2);
    assert.deepEqual(tracked(rework.cwd), manifest(sealed));
    restored(rework.cwd, sealed);
    assert.equal(existsSync(join(rework.cwd, 'contract.txt')), false);
    assert.match(rework.prompt, /Historical rejection context/);
    workspaceUntouched(f, head);
  } finally { await f.close(); }
});

test('a non-Git workspace restores the rejected delivery by copy', { timeout: 60000 }, async () => {
  const f = await fixture(false);
  try {
    const worker = await f.context(0);
    const sealed = await f.submit(worker, 'v1', { add: { 'added.txt': 'new file' }, remove: ['contract.txt'], files: ['source.txt', 'added.txt'] });
    assert.deepEqual(manifest(sealed), ['added.txt', 'source.txt']);
    f.review('FAIL');
    const queued = f.dispatch(); assert.equal(queued.base?.kind, 'candidate');
    const rework = await f.context(1);
    assert.deepEqual(readdirSync(rework.cwd).sort(), ['added.txt', 'source.txt']);
    restored(rework.cwd, sealed);
    assert.equal(readFileSync(join(f.source, 'contract.txt'), 'utf8'), 'preserve this independent file');
    assert.equal(readFileSync(join(f.source, 'source.txt'), 'utf8'), 'original');
  } finally { await f.close(); }
});
