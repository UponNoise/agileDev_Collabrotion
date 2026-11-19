import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { probeHarness } from '../src/harness.js';
import { inside } from '../src/workflow.js';
import { declaredDshRoute, decodeNativeEvent, NativeAdapter } from '../src/adapters.js';
import type { Harness } from '../src/contracts.js';

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

test('fresh consult adapters preserve capability gates and parse all three native transports', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-consult-adapter-'));
  try {
    const script = join(root, 'fixture.mjs');
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      'const [harness, ...args] = process.argv.slice(2);',
      'let prompt = ""; for await (const chunk of process.stdin) prompt += String(chunk);',
      'writeFileSync("fixture-invocation.json", JSON.stringify({ args, prompt }));',
      "const emit = value => console.log(JSON.stringify(value));",
      "if (harness === 'codex') { emit({ type: 'thread.started', thread_id: 'controlled-provider' }); emit({ type: 'turn.completed' }); }",
      "if (harness === 'claude-code') { emit({ type: 'system', subtype: 'init', session_id: 'controlled-provider' }); emit({ type: 'result', subtype: 'success', session_id: 'controlled-provider' }); }",
      "if (harness === 'dsh') { emit({ type: 'session', sessionId: 'controlled-provider' }); emit({ type: 'final', sessionId: prompt === 'mismatch' ? 'different-provider' : 'controlled-provider', reason: { kind: 'completed' }, text: 'fixture' }); }"
    ].join('\n'));
    for (const harness of ['codex', 'claude-code', 'dsh'] as const) {
      const entries = () => [{ id: harness, command: process.execPath, args: [script, harness] }];
      const providers: string[] = [];
      const context = {
        harness, kind: 'consult' as const, cwd: root, directory: join(root, harness),
        prompt: 'Controlled consult prompt', endpoint: 'http://127.0.0.1:1', token: 'fixture-no-secret',
        bridgeScript: join(root, 'unused-mcp-fixture.mjs'), onPid() {}, onProvider(id: string) { providers.push(id); }, onOutput() {}
      };
      const unverified = new NativeAdapter(entries);
      assert.equal(unverified.supportsConsult(harness), false);
      await assert.rejects(unverified.start(context), (error: any) => error.code === 'HARNESS_UNAVAILABLE');
      const tested = new NativeAdapter(entries, new Set<Harness>([harness]));
      assert.equal(tested.supportsConsult(harness), true);
      const session = await tested.start(context);
      assert.equal((await session.result).outcome, 'succeeded');
      assert.deepEqual([...new Set(providers)], ['controlled-provider']);
      const { args, prompt } = JSON.parse(readFileSync(join(root, 'fixture-invocation.json'), 'utf8')) as { args: string[]; prompt: string };
      assert.equal(prompt, context.prompt);
      if (harness === 'codex') {
        assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
        assert.ok(args.includes('approval_policy="never"'));
      } else if (harness === 'claude-code') {
        assert.equal(args[args.indexOf('--tools') + 1], '');
        assert.ok(args.includes('--strict-mcp-config'));
      } else {
        assert.equal(args[args.indexOf('--profile') + 1], 'headless');
        assert.equal(args[args.indexOf('--permission-mode') + 1], 'read-only');
        assert.equal(args[args.indexOf('--approval-policy') + 1], 'never');
        const mismatch = await tested.start({ ...context, prompt: 'mismatch' });
        assert.equal((await mismatch.result).outcome, 'failed');
      }
    }
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('agiledev-consult-adapter-'));
    rmSync(root, { recursive: true, force: true });
  }
});
