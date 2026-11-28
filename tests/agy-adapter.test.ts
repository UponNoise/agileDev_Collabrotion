import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeNativeEvent, NativeAdapter, type AdapterContext } from '../src/adapters.js';
import { consultLauncherIdentity } from '../src/consult-verification.js';
import type { RunModelSettings } from '../src/contracts.js';
import { agyCapabilities, type DispatchVerification } from '../src/dispatch-verification.js';
import { discoverHarnesses, type HarnessEntry } from '../src/harness.js';

const fakeScript = [
  "import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { spawn } from 'node:child_process';",
  "import { join } from 'node:path';",
  'const args = process.argv.slice(2);',
  "const versionFile = process.env.FAKE_AGY_VERSION_FILE;",
  "if (args.includes('--version')) { console.log(versionFile ? readFileSync(versionFile, 'utf8').trim() : '1.5.16'); process.exit(0); }",
  "const recordDir = process.env.FAKE_AGY_RECORD_DIR;",
  "const home = process.env.USERPROFILE || process.env.HOME || '';",
  "let stdin = '';",
  'for await (const chunk of process.stdin) stdin += String(chunk);',
  'if (recordDir) {',
  '  let mcpConfig = null;',
  "  try { mcpConfig = readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'); } catch {}",
  "  const seq = (process.env.FAKE_AGY_SEQ || '0');",
  "  writeFileSync(join(recordDir, `invocation-${seq}.json`), JSON.stringify({",
  '    args, stdin, cwd: process.cwd(),',
  '    USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME,',
  '    AGILEDEV_TOKEN: process.env.AGILEDEV_TOKEN, AGILEDEV_ENDPOINT: process.env.AGILEDEV_ENDPOINT,',
  '    AGILEDEV_DATA_DIR: process.env.AGILEDEV_DATA_DIR ?? null,',
  '    AGILEDEV_GITHUB_TOKEN: process.env.AGILEDEV_GITHUB_TOKEN ?? null,',
  '    mcpConfig,',
  '  }));',
  '}',
  "const servers = (process.env.FAKE_AGY_SERVERS ?? 'agiledev').split(',').filter(Boolean);",
  'if (servers.length) {',
  "  const mcpDir = join(home, '.gemini', 'antigravity-cli', 'mcp');",
  '  for (const name of servers) mkdirSync(join(mcpDir, name), { recursive: true });',
  '}',
  "const mode = process.env.FAKE_AGY_MODE || 'success';",
  "const emit = value => console.log(JSON.stringify(value));",
  "if (mode === 'sleep') {",
  '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  '  if (recordDir) writeFileSync(join(recordDir, "child-pid.txt"), String(child.pid));',
  "  emit({ event: 'init', conversation_id: 'conv-sleep', init: { model: 'gemini-4-hydrogen-high' } });",
  '  setInterval(() => {}, 1000);',
  "} else if (mode === 'uncertain') {",
  '  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.env.TEMP || process.env.TMP || "/", detached: true, stdio: ["ignore", 1, "ignore"] });',
  '  holder.unref();',
  '  if (recordDir) writeFileSync(join(recordDir, "holder-pid.txt"), String(holder.pid));',
  "  emit({ event: 'init', conversation_id: 'conv-uncertain', init: { model: 'gemini-4-hydrogen-high' } });",
  '  process.exit(0);',
  "} else if (mode === 'exit-1') {",
  "  emit({ event: 'init', conversation_id: 'conv-err', init: { model: 'gemini-4-hydrogen-high' } });",
  "  console.error('Unknown model slug');",
  "  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'Unknown model' } });",
  '  process.exit(1);',
  "} else if (mode === 'no-result') {",
  "  emit({ event: 'init', conversation_id: 'conv-no-result' });",
  "} else if (mode === 'malformed') {",
  "  console.log('not-json');",
  "  console.log(JSON.stringify({ x: 1 }).repeat(1));",
  "  emit({ event: 'init', conversation_id: 'conv-1' });",
  "  emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'mcp_agiledev_x', tool_info: { parameters: { k: 'v' } } } });",
  "  console.log('[' + '\"x\",'.repeat(270000) + '\"y\"]');",
  "  emit({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'done' } });",
  "} else if (mode === 'consult-mismatch') {",
  "  emit({ event: 'init', conversation_id: 'conv-1' });",
  "  emit({ event: 'result', result: { conversation_id: 'conv-2', status: 'SUCCESS', response: 'done' } });",
  "} else if (mode === 'steps') {",
  "  emit({ event: 'init', conversation_id: 'conv-steps', init: { model: 'gemini-4-hydrogen-high' } });",
  "  emit({ event: 'step_update', step_update: { step_type: 'thought', state: 'DONE', text_delta: 'ignored' } });",
  "  emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'write_file', tool_info: { parameters: { path: 'a' } } } });",
  "  emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'write_file', tool_info: { parameters: { secret: process.env.AGILEDEV_TOKEN, pad: 'p'.repeat(700) }, error: { type: 'PERMISSION_DENIED' } } } });",
  "  for (let i = 0; i < 2300; i++) emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { parameters: { i, pad: 'q'.repeat(600) } } } });",
  "  emit({ event: 'result', result: { conversation_id: 'conv-steps', status: 'SUCCESS', response: 'steps-done' } });",
  '} else {',
  "  emit({ event: 'init', conversation_id: 'conv-ok', init: { model: process.env.FAKE_AGY_REPORTED_MODEL ?? 'gemini-4-hydrogen-high' } });",
  "  emit({ event: 'step_update', step_update: { step_type: 'thought', state: 'DONE', text_delta: 'should not reach summary' } });",
  "  emit({ event: 'result', result: { conversation_id: 'conv-ok', status: 'SUCCESS', response: 'final-answer' } });",
  '}',
].join('\n');

function allConfirmedRecord(entry: HarnessEntry, version = '1.5.16'): DispatchVerification {
  const launcher = consultLauncherIdentity(entry);
  assert.ok(launcher);
  return {
    policy: 1,
    harness: 'agy',
    launcher,
    version,
    verifiedAt: Date.now(),
    capabilities: Object.fromEntries(agyCapabilities.map(c => [c, 'CONFIRMED'])) as DispatchVerification['capabilities'],
  };
}

function normalizedHome(home: string) {
  return home.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '');
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-agy-adapter-'));
  const previousEnv = process.env;
  process.env = { ...previousEnv };
  for (const key of ['AGILEDEV_AGY_WORKER_MODEL', 'AGILEDEV_AGY_QA_MODEL', 'AGILEDEV_AGY_CONSULT_MODEL', 'AGILEDEV_AGY_PATH']) {
    delete process.env[key];
  }
  t.after(() => {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const script = join(root, 'fake-agy.mjs');
  writeFileSync(script, fakeScript);
  const recordDir = join(root, 'records');
  mkdirSync(recordDir);
  const versionFile = join(root, 'version.txt');
  writeFileSync(versionFile, '1.5.16');
  const makeEntry = (extraEnv: Record<string, string> = {}): HarnessEntry => ({
    id: 'agy',
    command: process.execPath,
    args: [script],
    env: {
      FAKE_AGY_RECORD_DIR: recordDir,
      FAKE_AGY_VERSION_FILE: versionFile,
      AGILEDEV_GITHUB_TOKEN: 'gh-secret',
      AGILEDEV_DATA_DIR: 'data-dir-secret',
      ...extraEnv,
    },
  });
  const makeContext = (name: string, overrides: Partial<AdapterContext> = {}): AdapterContext => {
    const directory = join(root, 'runs', name);
    const cwd = join(root, 'cwds', name);
    mkdirSync(cwd, { recursive: true });
    return {
      harness: 'agy',
      cwd,
      directory,
      prompt: 'Test prompt',
      endpoint: 'http://127.0.0.1:43199',
      token: 'run-secret-token-123',
      bridgeScript: join(root, 'bridge.mjs'),
      onPid() {},
      onProvider() {},
      onOutput() {},
      ...overrides,
    };
  };
  return { root, script, recordDir, versionFile, makeEntry, makeContext };
}

test('discoverHarnesses finds AGILEDEV_AGY_PATH and skips missing', { timeout: 10000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-agy-discover-'));
  const previous = process.env;
  process.env = { ...previous, PATH: '', APPDATA: root, LOCALAPPDATA: root };
  t.after(() => {
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const agyExe = join(root, 'agy.exe');
  writeFileSync(agyExe, 'fake');
  process.env.AGILEDEV_AGY_PATH = agyExe;
  assert.deepEqual(discoverHarnesses().find(e => e.id === 'agy'), { id: 'agy', command: agyExe, args: [] });
  process.env.AGILEDEV_AGY_PATH = join(root, 'missing.exe');
  assert.equal(discoverHarnesses().find(e => e.id === 'agy'), undefined);
});

test('agy launches worker, QA, and consult with exact args, stdin, env, settings, mcp_config, and clean cwd', { timeout: 15000 }, async t => {
  const f = setup(t);
  for (const [index, spec] of ([
    { name: 'worker', kind: undefined, defaultModel: 'gemini-4-hydrogen-high', prompt: 'Worker prompt' },
    { name: 'qa', kind: 'qa' as const, defaultModel: 'gemini-4-neon-high', prompt: 'QA prompt' },
    { name: 'consult', kind: 'consult' as const, defaultModel: 'gemini-4-neon-high', prompt: 'x'.repeat(200000) },
  ]).entries()) {
    const entry = f.makeEntry({ FAKE_AGY_SEQ: String(index), FAKE_AGY_SERVERS: 'canary,agiledev' });
    const launcher = consultLauncherIdentity(entry)!;
    const adapter = new NativeAdapter(
      () => [entry],
      new Map([['agy', { launcher, version: '1.5.16' }]]),
      {
        dispatchVerification: new Map([['agy', allConfirmedRecord(entry)]]),
        agyExtraMcpServers: { canary: { command: process.execPath, args: [join(f.root, 'canary.mjs')] } },
      },
    );
    let settings: RunModelSettings = {};
    const c = f.makeContext(spec.name, {
      kind: spec.kind,
      prompt: spec.prompt,
      onModelSettings: value => { settings = { ...settings, ...value }; },
    });
    const session = await adapter.start(c);
    const outcome = await session.result;
    assert.equal(outcome.outcome, 'succeeded');
    assert.equal(outcome.summary, 'final-answer');

    const recorded = JSON.parse(readFileSync(join(f.recordDir, `invocation-${index}.json`), 'utf8'));
    const home = join(c.directory, 'agy-home');
    const settingsPath = join(c.directory, 'agy-settings.json');
    const expectedArgs = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', spec.defaultModel,
      '--settings', settingsPath,
      '--disable-slash-commands',
      ...(spec.kind === 'consult' ? [] : ['--mode', 'accept-edits', '--sandbox']),
    ];
    assert.deepEqual(recorded.args, expectedArgs);
    assert.equal(recorded.stdin, `${JSON.stringify({ event: 'user', message: { content: spec.prompt } })}\n`);
    assert.equal(recorded.USERPROFILE, home);
    assert.equal(recorded.HOME, home);
    assert.equal(recorded.AGILEDEV_TOKEN, c.token);
    assert.equal(recorded.AGILEDEV_ENDPOINT, c.endpoint);
    assert.equal(recorded.AGILEDEV_DATA_DIR, null);
    assert.equal(recorded.AGILEDEV_GITHUB_TOKEN, null);

    assert.deepEqual(JSON.parse(recorded.mcpConfig), {
      mcpServers: {
        agiledev: { command: process.execPath, args: [c.bridgeScript, 'mcp'] },
        canary: { command: process.execPath, args: [join(f.root, 'canary.mjs')] },
      },
    });
    assert.ok(!recorded.mcpConfig.includes(c.token));

    const norm = normalizedHome(home);
    const allow = ['mcp(agiledev/*)', `read_file(${norm}/.gemini/antigravity-cli/mcp)`];
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), spec.kind === 'consult' ? {
      agentMode: '',
      toolPermission: 'request-review',
      allowNonWorkspaceAccess: false,
      trustedWorkspaces: [c.cwd],
      permissions: { allow, deny: ['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)'] },
    } : {
      toolPermission: 'proceed-in-sandbox',
      allowNonWorkspaceAccess: false,
      trustedWorkspaces: [c.cwd],
      permissions: { allow, deny: [] },
    });

    assert.deepEqual(readdirSync(c.cwd), []);
    assert.equal(existsSync(home), false);
    assert.deepEqual(JSON.parse(readFileSync(join(c.directory, 'agy-loaded-servers.json'), 'utf8')), {
      servers: ['agiledev', 'canary'],
    });
    for (const file of readdirSync(c.directory)) {
      assert.ok(!readFileSync(join(c.directory, file), 'utf8').includes(c.token));
    }
    assert.deepEqual(settings, {
      model: { value: 'gemini-4-hydrogen-high', source: 'harness' },
      reasoningEffort: { value: 'high', source: 'managed-default' },
    });
  }
});

test('agy models, overrides, effort parsing, and invalid overrides work as specified', { timeout: 15000 }, async t => {
  const f = setup(t);
  const entry = f.makeEntry({ FAKE_AGY_REPORTED_MODEL: 'reported-model' });
  const launcher = consultLauncherIdentity(entry)!;
  const adapter = new NativeAdapter(
    () => [entry],
    new Map([['agy', { launcher, version: '1.5.16' }]]),
    { dispatchVerification: new Map([['agy', allConfirmedRecord(entry)]]) },
  );

  for (const [envVar, kind, modelSlug, expectedEffort] of [
    ['AGILEDEV_AGY_WORKER_MODEL', undefined, 'gemini-4-hydrogen-xhigh', 'xhigh'],
    ['AGILEDEV_AGY_QA_MODEL', 'qa', 'gemini-4-neon-low', 'low'],
    ['AGILEDEV_AGY_CONSULT_MODEL', 'consult', 'custom-no-effort', null],
  ] as const) {
    process.env[envVar] = modelSlug;
    const observed: RunModelSettings[] = [];
    const c = f.makeContext(`override-${envVar}`, { kind, onModelSettings: s => observed.push(s) });
    assert.equal((await (await adapter.start(c)).result).outcome, 'succeeded');
    assert.deepEqual(observed[0], {
      model: { value: modelSlug, source: 'launch' },
      reasoningEffort: expectedEffort ? { value: expectedEffort, source: 'launch' } : { value: null, source: 'harness-default' },
    });
    assert.deepEqual(observed[1], { model: { value: 'reported-model', source: 'harness' } });
    delete process.env[envVar];
  }

  process.env.AGILEDEV_AGY_WORKER_MODEL = 'invalid model with spaces!';
  const invalidCtx = f.makeContext('invalid-model');
  await assert.rejects(adapter.start(invalidCtx), { code: 'INVALID_MODEL_SETTING' });
  assert.equal(existsSync(invalidCtx.directory), false);
});

test('agy decodes init, result, errors, malformed lines, steps cap/redaction, and loaded servers', { timeout: 15000 }, async t => {
  const f = setup(t);

  assert.deepEqual(decodeNativeEvent('agy', { event: 'init', conversation_id: 'c1', init: { model: 'bad model!' } }), {
    sessionId: 'c1', model: undefined,
  });
  assert.deepEqual(decodeNativeEvent('agy', { event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'bad' } }), {
    sessionId: '', terminal: 'failed', text: 'bad',
  });
  assert.deepEqual(decodeNativeEvent('agy', { event: 'step_update', step_update: { step_type: 'thought', text_delta: 'hi' } }), {});

  const runMode = async (mode: string, servers = '', kind?: 'consult') => {
    const entry = f.makeEntry({ FAKE_AGY_MODE: mode, FAKE_AGY_SERVERS: servers });
    const launcher = consultLauncherIdentity(entry)!;
    const adapter = new NativeAdapter(
      () => [entry],
      new Map([['agy', { launcher, version: '1.5.16' }]]),
      { dispatchVerification: new Map([['agy', allConfirmedRecord(entry)]]) },
    );
    const c = f.makeContext(`mode-${mode}-${servers}-${kind ?? 'w'}`, { kind });
    const outcome = await (await adapter.start(c)).result;
    return { c, outcome };
  };

  const exit1 = await runMode('exit-1');
  assert.equal(exit1.outcome.outcome, 'failed');
  assert.equal(exit1.outcome.errorCode, 'PROVIDER_FAILED');
  assert.equal(exit1.outcome.summary, 'Unknown model');
  assert.equal(existsSync(join(exit1.c.directory, 'agy-home')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(exit1.c.directory, 'agy-loaded-servers.json'), 'utf8')), { servers: [] });

  assert.equal((await runMode('no-result')).outcome.outcome, 'failed');
  assert.equal((await runMode('malformed')).outcome.outcome, 'failed');
  assert.equal((await runMode('consult-mismatch', '', 'consult')).outcome.outcome, 'failed');

  const stepsRun = await runMode('steps');
  assert.equal(stepsRun.outcome.outcome, 'succeeded');
  const stepsRaw = readFileSync(join(stepsRun.c.directory, 'agy-steps.jsonl'), 'utf8');
  assert.ok(!stepsRaw.includes(stepsRun.c.token));
  assert.ok(Buffer.byteLength(stepsRaw) <= 1024 * 1024);
  const firstStep = JSON.parse(stepsRaw.trimEnd().split('\n')[0]!);
  assert.equal(firstStep.tool, 'write_file');
  assert.equal(firstStep.error, 'PERMISSION_DENIED');
  assert.equal(firstStep.parameters.length, 500);
  assert.ok(firstStep.parameters.includes('[redacted]'));
});

test('agy fails closed on existing agy-home and on workspace .agents/mcp_config.json', { timeout: 15000 }, async t => {
  const f = setup(t);
  const entry = f.makeEntry();
  const launcher = consultLauncherIdentity(entry)!;
  const adapter = new NativeAdapter(
    () => [entry],
    new Map([['agy', { launcher, version: '1.5.16' }]]),
    { dispatchVerification: new Map([['agy', allConfirmedRecord(entry)]]) },
  );

  const existingHomeCtx = f.makeContext('existing-home');
  mkdirSync(join(existingHomeCtx.directory, 'agy-home'), { recursive: true });
  await assert.rejects(adapter.start(existingHomeCtx), { code: 'EEXIST' });

  for (const kind of [undefined, 'qa', 'consult'] as const) {
    for (const form of ['file', 'dir', 'symlink'] as const) {
      const ctx = f.makeContext(`ws-mcp-${kind ?? 'worker'}-${form}`, { kind });
      mkdirSync(join(ctx.cwd, '.agents'), { recursive: true });
      const target = join(ctx.cwd, '.agents', 'mcp_config.json');
      if (form === 'file') writeFileSync(target, '{"mcpServers":{}}');
      else if (form === 'dir') mkdirSync(target);
      else {
        const missingTarget = join(ctx.cwd, 'nonexistent-mcp.json');
        symlinkSync(missingTarget, target, 'file');
      }
      await assert.rejects(adapter.start(ctx), {
        code: 'MCP_ISOLATION_UNAVAILABLE',
        message: 'Could not keep other MCP servers out of this Antigravity run (workspace MCP config present). The run was not started.',
      });
      assert.equal(existsSync(ctx.directory), false);
    }
  }

  const otherAgentsFileCtx = f.makeContext('other-agents-file');
  mkdirSync(join(otherAgentsFileCtx.cwd, '.agents'), { recursive: true });
  writeFileSync(join(otherAgentsFileCtx.cwd, '.agents', 'other.json'), '{}');
  assert.equal((await (await adapter.start(otherAgentsFileCtx)).result).outcome, 'succeeded');
});

test('agy interrupt terminates process tree, uncertain leaves agy-home, and gate enforces fresh open records', { timeout: 15000 }, async t => {
  const f = setup(t);
  const sleepEntry = f.makeEntry({ FAKE_AGY_MODE: 'sleep' });
  const sleepLauncher = consultLauncherIdentity(sleepEntry)!;
  const sleepAdapter = new NativeAdapter(
    () => [sleepEntry],
    new Map([['agy', { launcher: sleepLauncher, version: '1.5.16' }]]),
    { dispatchVerification: new Map([['agy', allConfirmedRecord(sleepEntry)]]) },
  );
  const sleepCtx = f.makeContext('interrupt');
  let gotProvider = false;
  sleepCtx.onProvider = () => { gotProvider = true; };
  const session = await sleepAdapter.start(sleepCtx);
  for (let i = 0; i < 60 && !gotProvider; i++) await delay(50);
  assert.ok(gotProvider);
  assert.equal(await session.interrupt(), true);
  const sleepOutcome = await session.result;
  assert.equal(sleepOutcome.outcome, 'cancelled');
  const childPid = Number(readFileSync(join(f.recordDir, 'child-pid.txt'), 'utf8'));
  assert.throws(() => process.kill(childPid, 0));
  assert.equal(existsSync(join(sleepCtx.directory, 'agy-home')), false);

  const uncertainEntry = f.makeEntry({ FAKE_AGY_MODE: 'uncertain' });
  const uncertainAdapter = new NativeAdapter(
    () => [uncertainEntry],
    new Map(),
    { dispatchVerification: new Map([['agy', allConfirmedRecord(uncertainEntry)]]) },
  );
  const uncertainCtx = f.makeContext('uncertain');
  let uncertainProvider = false;
  uncertainCtx.onProvider = () => { uncertainProvider = true; };
  const uncertainSession = await uncertainAdapter.start(uncertainCtx);
  for (let i = 0; i < 60 && !uncertainProvider; i++) await delay(50);
  await delay(100);
  const killHolder = () => {
    try {
      const holderPid = Number(readFileSync(join(f.recordDir, 'holder-pid.txt'), 'utf8'));
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(holderPid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(holderPid, 'SIGKILL');
    } catch {}
  };
  t.after(killHolder);
  assert.equal(await uncertainSession.interrupt(), false);
  const uncertainOutcome = await uncertainSession.result;
  assert.equal(uncertainOutcome.outcome, 'uncertain');
  assert.equal(existsSync(join(uncertainCtx.directory, 'agy-home')), true);
  assert.equal(existsSync(join(uncertainCtx.directory, 'agy-loaded-servers.json')), false);
  killHolder();

  const gatedEntry = f.makeEntry();
  const unverified = new NativeAdapter(() => [gatedEntry]);
  assert.equal(unverified.supportsDispatch('agy'), false);
  assert.equal(unverified.supportsDispatch('codex'), true);
  for (const kind of [undefined, 'qa', 'consult'] as const) {
    const ctx = f.makeContext(`unverified-${kind ?? 'w'}`, { kind });
    await assert.rejects(unverified.start(ctx), { code: 'HARNESS_NOT_VERIFIED' });
    assert.equal(existsSync(ctx.directory), false);
  }

  const record = allConfirmedRecord(gatedEntry);
  const staleAdapter = new NativeAdapter(() => [gatedEntry], new Map(), {
    dispatchVerification: new Map([['agy', record]]),
  });
  assert.equal(staleAdapter.supportsDispatch('agy'), true);
  writeFileSync(f.versionFile, '1.5.17');
  await assert.rejects(staleAdapter.start(f.makeContext('stale-version')), { code: 'HARNESS_NOT_VERIFIED' });
  assert.equal(staleAdapter.supportsDispatch('agy'), false);
});
