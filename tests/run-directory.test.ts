import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { NativeAdapter, type AdapterContext } from '../src/adapters.js';
import { consultLauncherIdentity } from '../src/consult-verification.js';
import { DomainError } from '../src/contracts.js';
import { harnessDiagnostics } from '../src/diagnostics.js';
import type { HarnessEntry } from '../src/harness.js';
import { checkDshRunDirectory, readWindowsDirectoryRights, type DirectoryRights, type RunDirectoryCheck } from '../src/run-directory.js';

test('DSH directory checks distinguish granted, denied and unknown rights', async () => {
  const check = (writeDac: DirectoryRights['writeDac'], writeOwner: DirectoryRights['writeOwner']) =>
    checkDshRunDirectory('test-directory', async () => ({ writeDac, writeOwner }), 'win32');
  assert.deepEqual(await check('GRANTED', 'GRANTED'), { state: 'OK', missing: [] });
  assert.deepEqual(await check('GRANTED', 'DENIED'), { state: 'MISSING', missing: ['WRITE_OWNER'] });
  assert.deepEqual(await check('DENIED', 'DENIED'), { state: 'MISSING', missing: ['WRITE_DAC', 'WRITE_OWNER'] });
  assert.deepEqual(await check('DENIED', 'UNKNOWN'), { state: 'MISSING', missing: ['WRITE_DAC'] });
  assert.deepEqual(await check('UNKNOWN', 'GRANTED'), { state: 'UNKNOWN', missing: [] });
  const read = async () => { throw new Error('reader unavailable'); };
  assert.deepEqual(await checkDshRunDirectory('test-directory', read, 'win32'), { state: 'UNKNOWN', missing: [] });
  const linuxReader = test.mock.fn(read);
  assert.deepEqual(await checkDshRunDirectory('test-directory', linuxReader, 'linux'), { state: 'NOT_APPLICABLE', missing: [] });
  assert.equal(linuxReader.mock.callCount(), 0);
});

test('the native adapter gates only DSH SDK launches before generating the patch', { timeout: 10000 }, async t => {
  const runs = mkdtempSync(join(tmpdir(), 'agiledev-directory-adapter-'));
  t.after(() => rmSync(runs, { recursive: true, force: true }));
  const previousEnv = process.env;
  process.env = { ...previousEnv };
  t.after(() => { process.env = previousEnv; });
  for (const key of ['AGILEDEV_DSH_PROVIDER', 'AGILEDEV_DSH_MODEL', 'AGILEDEV_DSH_REASONING_EFFORT', 'AGILEDEV_DSH_PATCH',
    'AGILEDEV_CODEX_MODEL', 'AGILEDEV_CODEX_REASONING_EFFORT']) delete process.env[key];

  const script = join(runs, 'fixture.mjs');
  writeFileSync(script, [
    "import { writeFileSync } from 'node:fs';",
    "import { createInterface } from 'node:readline';",
    'const [harness, ...args] = process.argv.slice(2);',
    "if (args.includes('--version')) { console.log('fixture-version'); process.exit(0); }",
    "writeFileSync('started', '');",
    'const emit = value => console.log(JSON.stringify(value));',
    "if (args.includes('sdk')) {",
    '  for await (const line of createInterface({ input: process.stdin })) {',
    '    const request = JSON.parse(line);',
    "    if (request.method === 'session/wait') emit({ method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });",
    "    emit({ jsonrpc: '2.0', id: request.id, result: {} });",
    '  }',
    '} else {',
    '  for await (const chunk of process.stdin) {}',
    "  if (harness === 'dsh') emit({ type: 'final', sessionId: 'fixture', reason: { kind: 'completed' } });",
    "  else { emit({ type: 'thread.started', thread_id: 'fixture' }); emit({ type: 'turn.completed' }); }",
    '}',
  ].join('\n'));
  const dsh: HarnessEntry = { id: 'dsh', command: process.execPath, args: [script, 'dsh'] };
  const codex: HarnessEntry = { id: 'codex', command: process.execPath, args: [script, 'codex'], env: { CODEX_HOME: runs } };
  const launcher = consultLauncherIdentity(dsh);
  assert.ok(launcher);

  let settingsReported = false;
  let result: RunDirectoryCheck = { state: 'MISSING', missing: ['WRITE_OWNER'] };
  const check = t.mock.fn(async (directory: string) => {
    assert.ok(settingsReported);
    assert.equal(existsSync(join(directory, '..', 'dsh.patch.yml')), false);
    return result;
  });
  const adapter = new NativeAdapter(() => [dsh, codex], new Map([['dsh', { launcher, version: 'fixture-version' }]]), { runDirectoryCheck: check });
  const context = (name: string): AdapterContext => {
    const directory = join(runs, name);
    const cwd = join(directory, 'workspace');
    mkdirSync(cwd, { recursive: true });
    settingsReported = false;
    return {
      harness: 'dsh', cwd, directory, prompt: 'Fixture', endpoint: 'http://127.0.0.1:1', token: 'fixture',
      bridgeScript: join(runs, 'unused.mjs'), onPid() {}, onProvider() {}, onOutput() {},
      onModelSettings() { settingsReported = true; },
    };
  };

  const blocked = context('blocked');
  await assert.rejects(adapter.start(blocked), error => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, 'DSH_DIRECTORY_RIGHTS_REQUIRED');
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, 'DSH cannot confine commands in this run directory because this Windows account lacks WRITE_OWNER there. ' +
      'Give the account Full control of the run directory (' + runs + '), or keep the AgileDev data directory inside your user folder.');
    assert.deepEqual(error.details, { directory: blocked.cwd, missing: ['WRITE_OWNER'] });
    return true;
  });
  assert.equal(check.mock.callCount(), 1);
  assert.deepEqual(check.mock.calls[0]?.arguments, [blocked.cwd]);
  assert.equal(existsSync(join(blocked.cwd, 'started')), false);
  assert.equal(existsSync(join(blocked.directory, 'dsh.patch.yml')), false);

  process.env.AGILEDEV_DSH_REASONING_EFFORT = 'invalid';
  await assert.rejects(adapter.start(context('invalid-model')), { code: 'INVALID_MODEL_SETTING' });
  assert.equal(check.mock.callCount(), 1);
  delete process.env.AGILEDEV_DSH_REASONING_EFFORT;

  for (const state of ['OK', 'UNKNOWN', 'NOT_APPLICABLE'] as const) {
    result = { state, missing: [] };
    const launch = context(state);
    assert.equal((await (await adapter.start(launch)).result).outcome, 'succeeded');
    assert.equal(existsSync(join(launch.cwd, 'started')), true);
    assert.equal(existsSync(join(launch.directory, 'dsh.patch.yml')), true);
  }
  assert.equal(check.mock.callCount(), 4);
  result = { state: 'MISSING', missing: ['WRITE_OWNER'] };
  const consult = { ...context('consult'), kind: 'consult' as const };
  assert.equal((await (await adapter.start(consult)).result).outcome, 'succeeded');
  assert.equal(existsSync(join(consult.cwd, 'started')), true);
  const codexRun = { ...context('codex'), harness: 'codex' as const };
  assert.equal((await (await adapter.start(codexRun)).result).outcome, 'succeeded');
  assert.equal(existsSync(join(codexRun.cwd, 'started')), true);
  assert.equal(check.mock.callCount(), 4);
});

test('the Windows rights reader grants both rights in a fresh temp directory', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), "agiledev-'directory rights-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(await readWindowsDirectoryRights(directory), { writeDac: 'GRANTED', writeOwner: 'GRANTED' });
});

test('the Windows rights reader reports unknown for a missing path', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agiledev-missing-rights-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(await readWindowsDirectoryRights(join(directory, 'missing')), { writeDac: 'UNKNOWN', writeOwner: 'UNKNOWN' });
});

test('the Windows rights reader treats invalid handles as access failures', {
  skip: process.platform !== 'win32' || process.env.USERNAME?.endsWith('$'), timeout: 15000,
}, async () => {
  assert.equal((await readWindowsDirectoryRights(process.env.SystemRoot ?? 'C:\\Windows')).writeOwner, 'DENIED');
});

test('DSH diagnostics show the rights result, inherited directory and documented limitation', async t => {
  const dsh: HarnessEntry = { id: 'dsh', command: process.execPath, args: [] };
  const dataDir = mkdtempSync(join(tmpdir(), 'agiledev-directory-doctor-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let result: RunDirectoryCheck = { state: 'UNKNOWN', missing: [] };
  const check = t.mock.fn(async (..._args: Parameters<typeof checkDshRunDirectory>) => result);
  const diagnostics = (version?: string, directory = dataDir) =>
    harnessDiagnostics(dsh, { dataDir: directory, platform: 'win32', version, check });

  const inherited = { id: 'RUN_DIRECTORY_RIGHTS', state: 'UNKNOWN', detail: 'inherited from ' + dataDir + '; runs directory not created yet' };
  assert.deepEqual((await diagnostics())[0], inherited);
  assert.deepEqual((await diagnostics(undefined, join(dataDir, 'missing', 'child')))[0], inherited);
  assert.deepEqual(check.mock.calls.map(call => call.arguments), [[dataDir, undefined, 'win32'], [dataDir, undefined, 'win32']]);

  const runs = join(dataDir, 'runs');
  mkdirSync(runs);
  const [unknown, documented] = await diagnostics('0.2.2-rc.5');
  assert.deepEqual(unknown, { id: 'RUN_DIRECTORY_RIGHTS', state: 'UNKNOWN' });
  assert.equal(documented?.id, 'PIPED_CHILD_PROCESSES');
  assert.equal(documented?.state, 'KNOWN_LIMITATION');
  assert.match(documented?.detail ?? '', /child processes with piped output/);
  assert.deepEqual(check.mock.calls.at(-1)?.arguments, [runs, undefined, 'win32']);
  assert.equal((await diagnostics('0.3.0'))[1]?.state, 'UNKNOWN');
  assert.equal((await diagnostics())[1]?.state, 'UNKNOWN');

  result = { state: 'MISSING', missing: ['WRITE_OWNER'] };
  assert.deepEqual((await diagnostics())[0], { id: 'RUN_DIRECTORY_RIGHTS', state: 'MISSING', detail: 'missing WRITE_OWNER' });
  result = { state: 'OK', missing: [] };
  assert.deepEqual((await diagnostics())[0], { id: 'RUN_DIRECTORY_RIGHTS', state: 'OK', detail: runs });

  const linux = await harnessDiagnostics(dsh, { dataDir, platform: 'linux', version: '0.2.2-rc.5' });
  assert.deepEqual(linux[0], { id: 'RUN_DIRECTORY_RIGHTS', state: 'NOT_APPLICABLE', detail: 'platform linux' });
  assert.equal(linux[1]?.state, 'NOT_APPLICABLE');
  for (const id of ['codex', 'claude-code'] as const) {
    assert.deepEqual(await harnessDiagnostics({ ...dsh, id }, { dataDir, check }), []);
  }
});

test('doctor includes diagnostics on every discovered harness', { timeout: 25000 }, t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agiledev-directory-doctor-cli-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'runs'));
  const output = execFileSync(process.execPath, [resolve('dist/cli.js'), 'doctor'], {
    env: {
      ...process.env, AGILEDEV_DATA_DIR: dataDir, AGILEDEV_DSH_PATH: process.execPath, AGILEDEV_CODEX_PATH: process.execPath,
      APPDATA: dataDir, LOCALAPPDATA: dataDir, PATH: '',
    },
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  const report = JSON.parse(output);
  for (const entry of report.harnesses) assert.ok(Array.isArray(entry.diagnostics));
  const dsh = report.harnesses.find((entry: HarnessEntry) => entry.id === 'dsh');
  assert.ok(dsh?.available);
  const windows = process.platform === 'win32';
  assert.deepEqual(dsh.diagnostics.map(({ id, state }: { id: string; state: string }) => ({ id, state })), [
    { id: 'RUN_DIRECTORY_RIGHTS', state: windows ? 'OK' : 'NOT_APPLICABLE' },
    { id: 'PIPED_CHILD_PROCESSES', state: windows ? 'UNKNOWN' : 'NOT_APPLICABLE' },
  ]);
});
