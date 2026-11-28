import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { probeHarness } from '../src/harness.js';
import { inside } from '../src/workflow.js';
import { decodeNativeEvent, NativeAdapter } from '../src/adapters.js';
import type { RunModelSettings } from '../src/contracts.js';
import { consultLauncherIdentity, loadConsultVerifications, readConsultVerification, recordConsultVerification } from '../src/consult-verification.js';

test('harness probes invoke an executable without a shell and distinguish failure', async () => {
  const good = await probeHarness({ id: 'codex', command: process.execPath, args: [] });
  assert.equal(good.available, true); assert.match(good.version!, /^v\d/); assert.equal(good.executionVerified, false);
  const bad = await probeHarness({ id: 'dsh', command: join(tmpdir(), 'missing-agiledev-executable'), args: [] });
  assert.equal(bad.available, false); assert.equal(bad.error, 'VERSION_PROBE_FAILED');
});

test('a damaged optional Windows harness directory does not block discovery of other harnesses', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-damaged-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'Claude-Data'), 'fixture file where an optional directory belongs');
  const env = { ...process.env, APPDATA: root, LOCALAPPDATA: root, PATH: '', AGILEDEV_DATA_DIR: root,
    AGILEDEV_CODEX_PATH: process.execPath, AGILEDEV_CLAUDE_PATH: '', AGILEDEV_DSH_PATH: join(root, 'missing-dsh.exe') };
  const output = execFileSync(process.execPath, [resolve('dist/cli.js'), 'doctor'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  const report = JSON.parse(output);
  assert.deepEqual(report.missing, ['claude-code', 'dsh']);
  assert.equal(report.harnesses.find((entry: { id: string }) => entry.id === 'codex')?.available, true);
});

test('artifact paths cannot escape through traversal or directory junctions', () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-path-'));
  const outside = mkdtempSync(join(tmpdir(), 'agiledev-outside-'));
  try {
    writeFileSync(join(outside, 'private.txt'), 'outside data');
    assert.throws(() => inside(root, join(outside, 'private.txt')), /escapes/);
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => inside(root, 'link/private.txt'), /escapes/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('native terminal events distinguish completed work from failure and idle notifications', () => {
  assert.equal(decodeNativeEvent('codex', { type: 'turn.failed', error: { message: 'Provider rejected request' } }).terminal, 'failed');
  assert.equal(decodeNativeEvent('claude-code', { type: 'result', is_error: true, subtype: 'error_during_execution', session_id: 'fixture' }).terminal, 'failed');
  assert.equal(decodeNativeEvent('dsh', { method: 'session.status', params: { status: 'idle' } }).terminal, undefined);
  assert.equal(decodeNativeEvent('dsh', { method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }).terminal, 'succeeded');
  assert.equal(decodeNativeEvent('dsh', { method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'error' } } } } }).terminal, 'failed');
});

test('Codex chooses the newest visible Sol and records when it inherits the harness default', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-codex-model-'));
  const previousEnv = process.env;
  process.env = { ...previousEnv };
  delete process.env.AGILEDEV_CODEX_MODEL;
  delete process.env.AGILEDEV_CODEX_REASONING_EFFORT;
  try {
    const cache = join(root, 'models_cache.json');
    writeFileSync(cache, JSON.stringify({ models: [
      { slug: 'gpt-6.2-sol', visibility: 'list' },
      { slug: 'gpt-7-sol', visibility: 'hide' },
      { slug: 'gpt-6.10-sol', visibility: 'list' },
      { slug: 'gpt-8-astra', visibility: 'list' },
      null,
    ] }));
    const script = join(root, 'codex.mjs');
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync("codex-args.json", JSON.stringify(process.argv.slice(2)));',
      'console.log(JSON.stringify({ type:"thread.started", thread_id:"fixture" }));',
      'console.log(JSON.stringify({ type:"turn.completed" }));',
    ].join('\n'));
    const adapter = new NativeAdapter(() => [{ id: 'codex', command: process.execPath, args: [script], env: { CODEX_HOME: root } }]);
    let settings: RunModelSettings = {};
    const launch = {
      harness: 'codex' as const, cwd: root, directory: root, prompt: 'Fixture', endpoint: 'http://127.0.0.1:1', token: 'fixture',
      bridgeScript: join(root, 'bridge.mjs'), onPid() {}, onProvider() {}, onOutput() {},
      onModelSettings(observed: RunModelSettings) { settings = observed; },
    };
    assert.equal((await (await adapter.start(launch)).result).outcome, 'succeeded');
    const args = () => JSON.parse(readFileSync(join(root, 'codex-args.json'), 'utf8')) as string[];
    assert.ok(args().includes('model="gpt-6.10-sol"'));
    assert.ok(args().includes('model_reasoning_effort="high"'));
    assert.deepEqual(settings, { model: { value: 'gpt-6.10-sol', source: 'codex-cache' }, reasoningEffort: { value: 'high', source: 'managed-default' } });
    writeFileSync(cache, '{broken');
    assert.equal((await (await adapter.start(launch)).result).outcome, 'succeeded');
    assert.ok(!args().some(value => /^(model|model_reasoning_effort)=/.test(value)));
    assert.deepEqual(settings, { model: { value: null, source: 'harness-default' }, reasoningEffort: { value: null, source: 'harness-default' } });
    process.env.AGILEDEV_CODEX_REASONING_EFFORT = 'low';
    assert.equal((await (await adapter.start(launch)).result).outcome, 'succeeded');
    assert.ok(args().includes('model_reasoning_effort="low"'));
    assert.deepEqual(settings.reasoningEffort, { value: 'low', source: 'launch' });
  } finally {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('DSH SDK defaults to DeepSeek Flash and supports the selected Gemini route and owner overrides', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-sdk-model-'));
  const patch = join(root, 'owner overlay.yml');
  const previousEnv = process.env;
  process.env = { ...previousEnv, AGILEDEV_DSH_PATCH: patch };
  delete process.env.AGILEDEV_DSH_PROVIDER;
  delete process.env.AGILEDEV_DSH_MODEL;
  delete process.env.AGILEDEV_DSH_REASONING_EFFORT;
  try {
    writeFileSync(patch, '[]');
    const script = join(root, 'sdk.mjs');
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      'const args = process.argv.slice(2);',
      "if (args.includes('--dump-config')) { console.log('- id: fixture-row'); process.exit(0); }",
      "writeFileSync('sdk-args.json', JSON.stringify(args));",
      'const print = value => console.log(JSON.stringify(value));',
      'for await (const line of createInterface({ input: process.stdin })) {',
      '  const request = JSON.parse(line);',
      "  if (request.method === 'initialize') writeFileSync('initialize.json', JSON.stringify(request.params));",
      "  if (request.method === 'session/wait') print({ method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });",
      '  print({ jsonrpc: "2.0", id: request.id, result: {} });',
      '}',
    ].join('\n'));
    const adapter = new NativeAdapter(() => [{ id: 'dsh', command: process.execPath, args: [script] }], new Map(), {
      runDirectoryCheck: async () => ({ state: 'OK', missing: [] }),
    });
    let settings: RunModelSettings = {};
    const launch = {
      harness: 'dsh' as const, cwd: root, directory: root, prompt: 'Fixture prompt', endpoint: 'http://127.0.0.1:1', token: 'fixture',
      bridgeScript: join(root, 'bridge.mjs'), onPid() {}, onProvider() {}, onOutput() {},
      onModelSettings(observed: RunModelSettings) { settings = observed; },
    };
    const session = await adapter.start(launch);
    assert.equal((await session.result).outcome, 'succeeded');
    const readFixture = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));
    const sdk = readFixture('sdk-args.json');
    assert.equal(sdk[1], 'sdk');
    assert.equal(basename(sdk[3]), 'owner overlay.yml');
    assert.match(readFileSync(sdk[5], 'utf8'), /reasoningEffort: "max"/);
    const { provider, model, reasoningEffort } = readFixture('initialize.json');
    assert.deepEqual({ provider, model, reasoningEffort }, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
    assert.deepEqual(settings.reasoningEffort, { value: 'max', source: 'managed-default' });
    process.env.AGILEDEV_DSH_PROVIDER = 'google';
    process.env.AGILEDEV_DSH_MODEL = 'gemini-4-hydrogen';
    delete process.env.AGILEDEV_DSH_PATCH;
    await assert.rejects(adapter.start(launch), { code: 'DSH_PATCH_REQUIRED' });
    process.env.AGILEDEV_DSH_PATCH = patch;
    assert.equal((await (await adapter.start(launch)).result).outcome, 'succeeded');
    assert.equal(readFixture('initialize.json').reasoningEffort, 'high');
    assert.deepEqual(settings.reasoningEffort, { value: 'high', source: 'managed-default' });
    process.env.AGILEDEV_DSH_REASONING_EFFORT = 'medium';
    assert.equal((await (await adapter.start(launch)).result).outcome, 'succeeded');
    assert.equal(readFixture('initialize.json').reasoningEffort, 'medium');
    assert.deepEqual(settings.reasoningEffort, { value: 'medium', source: 'launch' });
    process.env.AGILEDEV_DSH_REASONING_EFFORT = 'xhigh';
    await assert.rejects(adapter.start(launch), { code: 'INVALID_MODEL_SETTING' });
    process.env.AGILEDEV_DSH_PATCH = 'relative.yml';
    await assert.rejects(adapter.start(launch), { code: 'INVALID_DSH_PATCH' });
  } finally {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh consult adapters preserve capability gates and parse all three native transports', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-consult-adapter-'));
  const ownerPatch = join(root, 'owner.yml');
  const previousEnv = process.env;
  process.env = {
    ...previousEnv,
    AGILEDEV_CODEX_MODEL: 'fixture-codex', AGILEDEV_CODEX_REASONING_EFFORT: 'high',
    AGILEDEV_DSH_PROVIDER: 'fixture-route', AGILEDEV_DSH_MODEL: 'fixture-dsh',
    AGILEDEV_DSH_REASONING_EFFORT: 'medium', AGILEDEV_DSH_PATCH: ownerPatch,
    AGILEDEV_CLAUDE_MODEL: 'fixture-alias',
  };
  try {
    writeFileSync(ownerPatch, '[]');
    const script = join(root, 'fixture.mjs');
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      'const [harness, ...args] = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('controlled-version'); process.exit(0); }",
      "if (args.includes('--dump-config')) { console.log('- id: fixture-row'); process.exit(0); }",
      'let prompt = ""; for await (const chunk of process.stdin) prompt += String(chunk);',
      'writeFileSync("fixture-invocation.json", JSON.stringify({ args, prompt }));',
      "const emit = value => console.log(JSON.stringify(value));",
      "if (harness === 'codex') { emit({ type: 'thread.started', thread_id: 'controlled-provider' }); emit({ type: 'turn.completed' }); }",
      "if (harness === 'claude-code') { emit({ type: 'system', subtype: 'init', session_id: 'controlled-provider', model: 'fixture-resolved-model' }); emit({ type: 'result', subtype: 'success', session_id: 'controlled-provider' }); }",
      "if (harness === 'dsh') { emit({ type: 'session', sessionId: 'controlled-provider' }); emit({ type: 'final', sessionId: prompt === 'mismatch' ? 'different-provider' : 'controlled-provider', reason: { kind: 'completed' }, text: 'fixture' }); }"
    ].join('\n'));
    for (const harness of ['codex', 'claude-code', 'dsh'] as const) {
      const entries = () => [{ id: harness, command: process.execPath, args: [script, harness] }];
      const providers: string[] = [];
      let settings: RunModelSettings = {};
      const context = {
        harness, kind: 'consult' as const, cwd: root, directory: join(root, harness),
        prompt: 'Controlled consult prompt', endpoint: 'http://127.0.0.1:1', token: 'fixture-no-secret',
        bridgeScript: join(root, 'unused-mcp-fixture.mjs'), onPid() {}, onProvider(id: string) { providers.push(id); }, onOutput() {},
        onModelSettings(observed: RunModelSettings) { settings = { ...settings, ...observed }; },
      };
      const unverified = new NativeAdapter(entries);
      assert.equal(unverified.supportsConsult(harness), false);
      await assert.rejects(unverified.start(context), (error: any) => error.code === 'HARNESS_UNAVAILABLE');
      const launcher = consultLauncherIdentity(entries()[0]!);
      assert.ok(launcher);
      const verification = { launcher, version: 'controlled-version' };
      const tested = new NativeAdapter(entries, new Map([[harness, verification]]));
      assert.equal(tested.supportsConsult(harness), true);
      const session = await tested.start(context);
      assert.equal((await session.result).outcome, 'succeeded');
      assert.deepEqual([...new Set(providers)], ['controlled-provider']);
      const { args, prompt } = JSON.parse(readFileSync(join(root, 'fixture-invocation.json'), 'utf8')) as { args: string[]; prompt: string };
      assert.equal(prompt, context.prompt);
      if (harness === 'codex') {
        assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
        assert.ok(args.includes('approval_policy="never"'));
        assert.ok(args.includes('model="fixture-codex"'));
        assert.ok(args.includes('model_reasoning_effort="high"'));
        assert.deepEqual(settings, { model: { value: 'fixture-codex', source: 'launch' }, reasoningEffort: { value: 'high', source: 'launch' } });
      } else if (harness === 'claude-code') {
        assert.equal(args[args.indexOf('--tools') + 1], '');
        assert.ok(args.includes('--strict-mcp-config'));
        assert.equal(args[args.indexOf('--model') + 1], 'fixture-alias');
        assert.deepEqual(settings, { model: { value: 'fixture-resolved-model', source: 'harness' }, reasoningEffort: { value: null, source: 'harness-default' } });
      } else {
        assert.equal(args[args.indexOf('--profile') + 1], 'headless');
        assert.equal(args[args.indexOf('--permission-mode') + 1], 'read-only');
        assert.equal(args[args.indexOf('--approval-policy') + 1], 'never');
        assert.equal(basename(args[args.indexOf('--patch') + 1]!), 'owner.yml');
        const generated = args[args.lastIndexOf('--patch') + 1]!;
        assert.match(readFileSync(generated, 'utf8'), /reasoningEffort: "medium"/);
        assert.deepEqual(settings, { provider: { value: 'fixture-route', source: 'launch' }, model: { value: 'fixture-dsh', source: 'launch' }, reasoningEffort: { value: 'medium', source: 'launch' } });
        const mismatch = await tested.start({ ...context, prompt: 'mismatch' });
        assert.equal((await mismatch.result).outcome, 'failed');
      }
    }
  } finally {
    process.env = previousEnv;
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('agiledev-consult-adapter-'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('local consult capability rejects missing, corrupted, stale and mismatched verification before model launch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-consult-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'fixture.mjs');
  const marker = join(root, 'launch-attempt');
  const versionPath = join(root, 'version');
  writeFileSync(versionPath, 'controlled-version-1');
  writeFileSync(script, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const keys = Object.keys(process.env).map(key => key.toUpperCase());",
    "if (process.argv.includes('--version') && ['AGILEDEV_GITHUB_TOKEN', 'AGILEDEV_TOKEN', 'AGILEDEV_ENDPOINT', 'AGILEDEV_DATA_DIR'].some(key => keys.includes(key))) process.exit(1);",
    "if (process.argv.includes('--version')) console.log(readFileSync(new URL('./version', import.meta.url), 'utf8'));",
    "else writeFileSync(new URL('./launch-attempt', import.meta.url), 'launched');"
  ].join('\n'));
  const entry = { id: 'codex' as const, command: process.execPath, args: [script], env: {
    AgileDev_GitHub_Token: 'fixture-credential', AGILEDEV_TOKEN: 'fixture-actor', AGILEDEV_ENDPOINT: 'fixture-endpoint',
    AGILEDEV_DATA_DIR: 'fixture-directory'
  } };
  const launcher = consultLauncherIdentity(entry);
  assert.ok(launcher);
  const evidenceDir = join(root, 'evidence');
  const evidence = { harness: entry.id, launcher, version: 'controlled-version-1', verifiedAt: Date.now(), questionId: 'fixture-question', runId: 'fixture-run', replyId: 'fixture-reply' };
  const discovery = () => [entry];
  const context = {
    harness: entry.id, kind: 'consult' as const, cwd: root, directory: join(root, 'run'),
    prompt: 'Controlled fixture', endpoint: 'http://127.0.0.1:1', token: 'fixture-no-secret', bridgeScript: script,
    onPid() {}, onProvider() {}, onOutput() {}
  };
  const empty = await loadConsultVerifications(evidenceDir, discovery);
  assert.equal(new NativeAdapter(discovery, empty).supportsConsult('codex'), false);
  recordConsultVerification(evidenceDir, evidence);
  assert.deepEqual(readConsultVerification(evidenceDir, 'codex'), { ...evidence, policy: 1 });
  const adapter = new NativeAdapter(discovery, await loadConsultVerifications(evidenceDir, discovery));
  assert.equal(adapter.supportsConsult('codex'), true);
  assert.equal(adapter.supportsConsult('claude-code'), false);
  await assert.rejects(adapter.start({ ...context, checkBeforeSpawn() { throw new Error('fixture cancel after version check'); } }), /fixture cancel after version check/);
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  writeFileSync(versionPath, 'controlled-version-2');
  await assert.rejects(adapter.start(context), { code: 'HARNESS_UNAVAILABLE' });
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  assert.equal(adapter.supportsConsult('codex'), false);
  assert.equal((await loadConsultVerifications(evidenceDir, discovery)).has('codex'), false);
  recordConsultVerification(evidenceDir, { ...evidence, version: 'controlled-version-2' });
  const restarted = new NativeAdapter(discovery, await loadConsultVerifications(evidenceDir, discovery));
  assert.equal(restarted.supportsConsult('codex'), true);
  writeFileSync(script, '// updated launcher');
  assert.equal(restarted.supportsConsult('codex'), false);
  writeFileSync(join(evidenceDir, 'consult-codex.json'), 'corrupted');
  assert.equal(readConsultVerification(evidenceDir, 'codex'), undefined);
});
