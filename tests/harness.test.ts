import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeHarness } from '../src/harness.js';
import { inside } from '../src/workflow.js';
import { declaredDshRoute, decodeNativeEvent } from '../src/adapters.js';

test('harness probes invoke an executable without a shell and distinguish failure', async () => {
  const good = await probeHarness({ id: 'codex', command: process.execPath, args: [] });
  assert.equal(good.available, true); assert.match(good.version!, /^v\d/); assert.equal(good.executionVerified, false);
  const bad = await probeHarness({ id: 'dsh', command: join(tmpdir(), 'missing-agiledev-executable'), args: [] });
  assert.equal(bad.available, false); assert.equal(bad.error, 'VERSION_PROBE_FAILED');
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

test('DSH route detection reads the declared profile default without evaluating code or choosing another route', () => {
  const profile = "- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: deepseek-official\n    model: 'deepseek-flash'\n- id: tools\n  name: tools\n";
  assert.deepEqual(declaredDshRoute(profile), { provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.equal(declaredDshRoute(profile.replace('deepseek-official', '!!js process.env.PROVIDER')), null);
  assert.equal(declaredDshRoute(profile.replace('  config:', '  disabled: true\n  config:')), null);
  assert.equal(declaredDshRoute('- id: unrelated\n  config:\n    provider: other\n    model: other'), null);
});

test('native terminal events distinguish completed work from failure and idle notifications', () => {
  assert.equal(decodeNativeEvent('codex', { type: 'turn.failed', error: { message: 'Provider rejected request' } }).terminal, 'failed');
  assert.equal(decodeNativeEvent('claude-code', { type: 'result', is_error: true, subtype: 'error_during_execution', session_id: 'fixture' }).terminal, 'failed');
  assert.equal(decodeNativeEvent('dsh', { method: 'session.status', params: { status: 'idle' } }).terminal, undefined);
  assert.equal(decodeNativeEvent('dsh', { method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }).terminal, 'succeeded');
  assert.equal(decodeNativeEvent('dsh', { method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'error' } } } } }).terminal, 'failed');
});
