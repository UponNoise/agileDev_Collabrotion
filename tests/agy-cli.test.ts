import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runVerifyQa } from '../src/cli.js';
import { consultLauncherIdentity } from '../src/consult-verification.js';
import { agyCapabilities, recordDispatchVerification, type DispatchVerification } from '../src/dispatch-verification.js';

const exec = promisify(execFile);
const script = resolve('dist/cli.js');

test('CLI rejects verify-agy in an agent env and rejects agy on verify-consult/exchange/execution', { timeout: 15000 }, async () => {
  for (const envExtra of [
    { AGILEDEV_TOKEN: 'agent-token' },
    { AGILEDEV_ENDPOINT: 'http://127.0.0.1:43170' },
  ]) {
    await assert.rejects(
      exec(process.execPath, [script, 'verify-agy'], { env: { ...process.env, ...envExtra }, windowsHide: true, timeout: 5000 }),
      (error: any) => error.code === 1 && /outside an agent connection/.test(error.stderr),
    );
  }

  for (const args of [
    ['verify-consult', 'agy'],
    ['verify-consult-exchange', 'agy', 'codex'],
    ['verify-consult-exchange', 'codex', 'agy'],
    ['verify-execution', 'agy'],
  ]) {
    await assert.rejects(
      exec(process.execPath, [script, ...args], { windowsHide: true, timeout: 5000 }),
      (error: any) => error.code === 1 && error.stderr.includes('Use verify-agy for Antigravity'),
    );
  }
});

test('verify-qa with agy stops before any run when dispatch-agy.json is missing, stale, or not open, and passes an open adapter', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-agy-cli-'));
  const previousEnv = process.env;
  process.env = { ...previousEnv };
  t.after(() => {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const dataDir = join(root, 'data');
  process.env.AGILEDEV_AGY_PATH = process.execPath;

  const baseEnv = { ...process.env, AGILEDEV_DATA_DIR: dataDir, AGILEDEV_AGY_PATH: process.execPath };
  for (const pair of [['agy', 'codex'], ['codex', 'agy']] as const) {
    await assert.rejects(
      exec(process.execPath, [script, 'verify-qa', ...pair], { env: baseEnv, windowsHide: true, timeout: 10000 }),
      (error: any) => error.code === 1 && error.stderr.includes('Run verify-agy --record first'),
    );
  }

  const launcher = consultLauncherIdentity({ id: 'agy', command: process.execPath, args: [] })!;
  assert.ok(launcher);
  const allConfirmed = Object.fromEntries(agyCapabilities.map(c => [c, 'CONFIRMED'])) as DispatchVerification['capabilities'];

  // Not open (missing required capability)
  recordDispatchVerification(dataDir, {
    harness: 'agy', launcher, version: process.version, verifiedAt: Date.now(),
    capabilities: { ...allConfirmed, WRITE_CONFINEMENT: 'NOT_RUN' },
  });
  await assert.rejects(
    exec(process.execPath, [script, 'verify-qa', 'codex', 'agy'], { env: baseEnv, windowsHide: true, timeout: 10000 }),
    (error: any) => error.code === 1 && error.stderr.includes('Run verify-agy --record first'),
  );

  // Stale version
  recordDispatchVerification(dataDir, {
    harness: 'agy', launcher, version: 'v0.0.0-stale', verifiedAt: Date.now(), capabilities: allConfirmed,
  });
  await assert.rejects(
    exec(process.execPath, [script, 'verify-qa', 'agy', 'codex'], { env: baseEnv, windowsHide: true, timeout: 10000 }),
    (error: any) => error.code === 1 && error.stderr.includes('Run verify-agy --record first'),
  );

  // Fresh open record -> hands adapter with supportsDispatch('agy') === true to verifyExecution
  recordDispatchVerification(dataDir, {
    harness: 'agy', launcher, version: process.version, verifiedAt: Date.now(), capabilities: allConfirmed,
  });
  let received: any;
  await runVerifyQa('codex', 'agy', dataDir, script, async (worker, _script, qa, options) => {
    received = { worker, qa, options };
    return { status: 'QA_HANDOFF_VERIFIED' } as any;
  });
  assert.equal(received.worker, 'codex');
  assert.equal(received.qa, 'agy');
  assert.equal(received.options?.adapter?.supportsDispatch?.('agy'), true);
});
