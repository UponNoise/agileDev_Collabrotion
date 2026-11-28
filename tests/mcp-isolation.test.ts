import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativeAdapter, type AdapterContext } from '../src/adapters.js';
import { consultLauncherIdentity } from '../src/consult-verification.js';
import { harnessDiagnostics } from '../src/diagnostics.js';
import type { HarnessEntry } from '../src/harness.js';
import { parseDshComposition } from '../src/mcp-isolation.js';
import type { RunDirectoryCheck } from '../src/run-directory.js';

const client = '@deepseek-ai/dsh-mcp-client';
const manager = '@deepseek-ai/dsh-mcp-manager';
const composition = [
  '# == profile',
  '- id : owner-one # trailing comment',
  '  name: ' + client + ' # MCP',
  '  config:',
  '    id: nested-id',
  '    name: ' + manager,
  '- name: "' + client + '" # another MCP',
  "  id: 'owner two # literal' # trailing comment",
  '- id: mcp-resources',
  '  name: builtin',
  '- id: browser-use-playwright-mcp',
  '  name: builtin',
  '- id: agiledev-mcp',
  '  name: ' + client,
  '- id: owner-one',
  '  name: ' + client,
].join('\n');

test('DSH composition reads top-level client IDs, comments and line endings', () => {
  const expected = { rowCount: 6, clientRowIds: ['owner-one', 'owner two # literal'], managerRows: 0, idlessClientRows: 0 };
  assert.deepEqual(parseDshComposition(composition), expected);
  assert.deepEqual(parseDshComposition(composition.replaceAll('\n', '\r\n')), expected);
  assert.deepEqual(parseDshComposition([
    '- id: manager-id',
    "  name: '" + manager + "' # manager",
    '- name: ' + client,
    '  id: # empty',
    '    id: nested-id',
  ].join('\n')), { rowCount: 2, clientRowIds: [], managerRows: 1, idlessClientRows: 1 });
  for (const invalid of ['', 'not YAML', '# - id: comment\n    - id: nested']) {
    assert.deepEqual(parseDshComposition(invalid), { rowCount: 0, clientRowIds: [], managerRows: 0, idlessClientRows: 0 });
  }
});

const fake = [
  "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { createInterface } from 'node:readline';",
  'const [harness, ...args] = process.argv.slice(2);',
  "if (args.includes('--version')) { console.log('isolation-fixture'); process.exit(0); }",
  "if (args.includes('--dump-config')) {",
  "  appendFileSync('dump.jsonl', JSON.stringify({ args, cwd: process.cwd(), tokenPresent: !!process.env.AGILEDEV_TOKEN }) + '\\n');",
  "  if (existsSync('launch.json') || existsSync('../dsh.patch.yml') || !existsSync('dump.yml')) process.exit(1);",
  "  process.stdout.write(readFileSync('dump.yml'));",
  '} else {',
  "  writeFileSync('launch.json', JSON.stringify(args));",
  '  const emit = value => console.log(JSON.stringify(value));',
  "  if (args.includes('sdk')) {",
  '    for await (const line of createInterface({ input: process.stdin })) {',
  '      const request = JSON.parse(line);',
  "      if (request.method === 'session/wait') emit({ method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });",
  '      emit({ id: request.id, result: {} });',
  '    }',
  '  } else {',
  '    for await (const chunk of process.stdin) {}',
  "    if (harness === 'dsh') emit({ type: 'final', sessionId: 'fixture', reason: { kind: 'completed' } });",
  "    if (harness === 'claude-code') emit({ type: 'result', subtype: 'success', session_id: 'fixture' });",
  "    if (harness === 'codex') { emit({ type: 'thread.started', thread_id: 'fixture' }); emit({ type: 'turn.completed' }); }",
  '  }',
  '}',
].join('\n');

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-mcp-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const previousEnv = process.env;
  process.env = { ...previousEnv, AGILEDEV_CODEX_MODEL: 'fixture-codex' };
  t.after(() => { process.env = previousEnv; });
  for (const key of ['AGILEDEV_DSH_PROVIDER', 'AGILEDEV_DSH_MODEL', 'AGILEDEV_DSH_REASONING_EFFORT',
    'AGILEDEV_DSH_PATCH', 'AGILEDEV_CLAUDE_MODEL', 'AGILEDEV_CODEX_REASONING_EFFORT']) delete process.env[key];

  const script = join(root, 'fixture.mjs');
  writeFileSync(script, fake);
  const entryFor = (id: HarnessEntry['id']): HarnessEntry => ({
    id, command: process.execPath, args: [script, id], env: { AGILEDEV_TOKEN: 'fixture-probe-token' },
  });
  function adapter(entry: HarnessEntry, check: () => Promise<RunDirectoryCheck> = async () => ({ state: 'OK', missing: [] })) {
    const launcher = consultLauncherIdentity(entry);
    assert.ok(launcher);
    return new NativeAdapter(() => [entry], new Map([[entry.id, { launcher, version: 'isolation-fixture' }]]), { runDirectoryCheck: check });
  }
  function context(name: string, harness: HarnessEntry['id'], consult = false): AdapterContext {
    const directory = join(root, name);
    const cwd = join(directory, 'workspace');
    mkdirSync(cwd, { recursive: true });
    return {
      harness, cwd, directory, kind: consult ? 'consult' : undefined, prompt: 'Fixture', endpoint: 'http://127.0.0.1:1',
      token: 'fake-run-token', bridgeScript: script, onPid() {}, onProvider() {}, onOutput() {},
    };
  }
  const ownerPatch = join(root, 'owner overlay.yml');
  writeFileSync(ownerPatch, '[]');
  return { root, entryFor, adapter, context, ownerPatch, ownerArgs: ['--patch', realpathSync(ownerPatch)] };
}

function readDumpCalls(cwd: string) {
  return readFileSync(join(cwd, 'dump.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}

test('DSH inspects the selected worker or consult profile before generating its overlay', async t => {
  const f = fixture(t);
  process.env.AGILEDEV_DSH_PATCH = f.ownerPatch;
  const adapter = f.adapter(f.entryFor('dsh'));
  for (const profile of ['sdk', 'headless']) {
    const c = f.context(profile, 'dsh', profile === 'headless');
    writeFileSync(join(c.cwd, 'dump.yml'), composition);
    assert.equal((await (await adapter.start(c)).result).outcome, 'succeeded');
    const initialArgs = ['--profile', profile, ...f.ownerArgs];
    assert.deepEqual(readDumpCalls(c.cwd), [{ args: [...initialArgs, '--dump-config'], cwd: c.cwd, tokenPresent: false }]);
    const patch = join(c.directory, 'dsh.patch.yml');
    const args = JSON.parse(readFileSync(join(c.cwd, 'launch.json'), 'utf8'));
    assert.deepEqual(args, [...initialArgs, '--patch', patch, ...(profile === 'sdk' ? [] :
      ['--permission-mode', 'read-only', '--approval-policy', 'never', '--json', '-'])]);
    const generated = readFileSync(patch, 'utf8');
    assert.match(generated, /^- id: agent-default-model\n  config:\n(?:    .+\n)+- id: "owner-one"\n  disabled: true\n- id: "owner two # literal"\n  disabled: true\n- insert:\n    - id: agiledev-mcp\n/);
    assert.equal([...generated.matchAll(/disabled: true/g)].length, 2);
  }
});

test('DSH refuses failed, empty, non-config, manager and idless dumps in both profiles', async t => {
  const f = fixture(t);
  const failures = [
    [undefined, 'dump failed'],
    ['', 'dump was not a configuration'],
    ['not yaml', 'dump was not a configuration'],
    ['- id: manager\n  name: ' + manager, 'manager row present'],
    ['- name: ' + client, 'MCP row without an id'],
  ] as const;
  const adapter = f.adapter(f.entryFor('dsh'));
  for (const consult of [false, true]) {
    for (const [i, [dump, reason]] of failures.entries()) {
      const c = f.context('refused-' + consult + '-' + i, 'dsh', consult);
      if (dump !== undefined) writeFileSync(join(c.cwd, 'dump.yml'), dump);
      await assert.rejects(adapter.start(c), {
        code: 'MCP_ISOLATION_UNAVAILABLE', statusCode: 409,
        message: 'Could not keep your other MCP servers out of this DSH run (' + reason + '). The run was not started.',
      });
      assert.equal(readDumpCalls(c.cwd).length, 1);
      assert.equal(existsSync(join(c.cwd, 'launch.json')), false);
      assert.equal(existsSync(join(c.directory, 'dsh.patch.yml')), false);
    }
  }
  const oversized = f.context('oversized', 'dsh');
  writeFileSync(join(oversized.cwd, 'dump.yml'), composition + '\n# ' + 'x'.repeat(8 * 1024 * 1024));
  await assert.rejects(adapter.start(oversized), { code: 'MCP_ISOLATION_UNAVAILABLE', message: /dump failed/ });
  assert.equal(existsSync(join(oversized.cwd, 'launch.json')), false);
});

test('DSH consult rechecks the launch gate after the dump', async t => {
  const f = fixture(t);
  const c = f.context('consult-cancelled', 'dsh', true);
  writeFileSync(join(c.cwd, 'dump.yml'), composition);
  c.checkBeforeSpawn = () => {
    if (existsSync(join(c.cwd, 'dump.jsonl'))) throw new Error('fixture consult no longer needed');
  };
  await assert.rejects(f.adapter(f.entryFor('dsh')).start(c), /fixture consult no longer needed/);
  assert.equal(existsSync(join(c.cwd, 'launch.json')), false);
  assert.equal(existsSync(join(c.directory, 'dsh.patch.yml')), false);
});

test('DSH checks settings and SDK directory access before requesting a dump', async t => {
  const f = fixture(t);
  const check = t.mock.fn(async (): Promise<RunDirectoryCheck> => ({ state: 'MISSING', missing: ['WRITE_OWNER'] }));
  const adapter = f.adapter(f.entryFor('dsh'), check);
  const blocked = f.context('blocked', 'dsh');
  await assert.rejects(adapter.start(blocked), { code: 'DSH_DIRECTORY_RIGHTS_REQUIRED' });
  assert.equal(check.mock.callCount(), 1);
  process.env.AGILEDEV_DSH_PATCH = 'relative.yml';
  const invalid = f.context('invalid-settings', 'dsh');
  await assert.rejects(adapter.start(invalid), { code: 'INVALID_DSH_PATCH' });
  assert.equal(check.mock.callCount(), 1);
  for (const c of [blocked, invalid]) {
    assert.equal(existsSync(join(c.cwd, 'dump.jsonl')), false);
    assert.equal(existsSync(join(c.directory, 'dsh.patch.yml')), false);
  }
});

test('Codex worker and consult ignore user config and preserve their sandbox and AgileDev bridge', async t => {
  const f = fixture(t);
  const adapter = f.adapter(f.entryFor('codex'));
  for (const consult of [false, true]) {
    const c = f.context('codex-' + consult, 'codex', consult);
    assert.equal((await (await adapter.start(c)).result).outcome, 'succeeded');
    const args = JSON.parse(readFileSync(join(c.cwd, 'launch.json'), 'utf8')) as string[];
    const windowsArgs = process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : [];
    const prefix = ['exec', '--json', '--ignore-user-config', ...windowsArgs, '--sandbox', consult ? 'read-only' : 'workspace-write'];
    assert.deepEqual(args.slice(0, prefix.length), prefix);
    assert.equal(args.includes('windows.sandbox="elevated"'), process.platform === 'win32');
    assert.ok(args.includes('mcp_servers.agiledev.required=true'));
    assert.ok(args.includes('mcp_servers.agiledev.command=' + JSON.stringify(process.execPath)));
    assert.ok(args.includes('mcp_servers.agiledev.args=' + JSON.stringify([c.bridgeScript, 'mcp'])));
  }
});

test('Claude Code worker keeps strict mode and its AgileDev MCP file', async t => {
  const f = fixture(t);
  const c = f.context('claude', 'claude-code');
  assert.equal((await (await f.adapter(f.entryFor('claude-code')).start(c)).result).outcome, 'succeeded');
  const args = JSON.parse(readFileSync(join(c.cwd, 'launch.json'), 'utf8')) as string[];
  const strict = args.indexOf('--strict-mcp-config');
  assert.ok(strict >= 0);
  assert.deepEqual(args.slice(strict + 1, strict + 3), ['--mcp-config', resolve(c.directory, 'mcp.json')]);
  const config = JSON.parse(readFileSync(args[strict + 2]!, 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['agiledev']);
});

test('doctor reports Codex and Claude Code isolation from the documented flags', async t => {
  const f = fixture(t);
  for (const [id, flag, args] of [
    ['codex', '--ignore-user-config', ['exec', '--help']],
    ['claude-code', '--strict-mcp-config', ['--help']],
  ] as const) {
    const entry = f.entryFor(id);
    for (const [output, state, detail] of [
      [flag, 'ENFORCED', flag],
      [flag + '-suffix', 'NOT_GUARANTEED', flag + ' absent from help'],
      [undefined, 'UNKNOWN', 'help failed'],
    ]) {
      const helpRunner = t.mock.fn(async () => {
        if (output === undefined) throw new Error('fixture help failure');
        return output;
      });
      assert.deepEqual(await harnessDiagnostics(entry, { dataDir: f.root, helpRunner }), [{ id: 'MCP_ISOLATION', state, detail }]);
      assert.deepEqual(helpRunner.mock.calls[0]?.arguments, [entry, args]);
    }
  }
});

test('doctor checks both DSH profiles and reports refusals without leaking client IDs', async t => {
  const f = fixture(t);
  const entry = f.entryFor('dsh');
  const helpRunner = async () => '--dump-config';
  const diagnostics = async (runHelp = helpRunner) => (await harnessDiagnostics(entry, { dataDir: f.root, platform: 'linux', helpRunner: runHelp })).at(-1);
  process.env.AGILEDEV_DSH_PATCH = f.ownerPatch;
  assert.deepEqual(await diagnostics(async () => ''), { id: 'MCP_ISOLATION', state: 'NOT_GUARANTEED', detail: '--dump-config absent from help' });
  assert.deepEqual(await diagnostics(async () => { throw new Error('fixture help failure'); }), { id: 'MCP_ISOLATION', state: 'UNKNOWN', detail: 'help failed' });
  assert.equal(existsSync(join(f.root, 'dump.jsonl')), false);
  assert.deepEqual(await diagnostics(), { id: 'MCP_ISOLATION', state: 'UNKNOWN', detail: 'dump failed' });
  assert.equal(readDumpCalls(f.root).length, 2);
  writeFileSync(join(f.root, 'dump.yml'), composition);
  const enforced = await diagnostics();
  assert.equal(enforced?.state, 'ENFORCED');
  assert.match(enforced?.detail ?? '', /^sdk: disables 2 other MCP rows; headless: disables 2 other MCP rows\. .*outside detection\.$/);
  assert.ok(!enforced?.detail?.includes('owner-one'));
  assert.deepEqual(readDumpCalls(f.root).slice(2).sort((a, b) => a.args[1].localeCompare(b.args[1])), ['headless', 'sdk'].map(profile => ({
    args: ['--profile', profile, ...f.ownerArgs, '--dump-config'], cwd: f.root, tokenPresent: false,
  })));
  for (const [name, reason] of [[manager, 'manager row present'], [client, 'MCP row without an id']]) {
    writeFileSync(join(f.root, 'dump.yml'), '- name: ' + name);
    assert.deepEqual(await diagnostics(), { id: 'MCP_ISOLATION', state: 'NOT_GUARANTEED', detail: 'sdk: ' + reason });
  }
  const calls = readDumpCalls(f.root).length;
  process.env.AGILEDEV_DSH_PATCH = 'relative.yml';
  assert.deepEqual(await diagnostics(), { id: 'MCP_ISOLATION', state: 'UNKNOWN', detail: 'INVALID_DSH_PATCH' });
  assert.equal(readDumpCalls(f.root).length, calls);
});

