import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harnessChoices } from '../web/harness-options.ts';

test('harnessChoices filters agy by dispatchHarnesses and marks unlisted current agy for re-check', () => {
  assert.deepEqual(harnessChoices(undefined), [
    { value: 'codex', label: 'Codex' },
    { value: 'dsh', label: 'DSH' },
    { value: 'claude-code', label: 'Claude Code' },
  ]);

  assert.deepEqual(harnessChoices(['codex', 'claude-code', 'dsh', 'agy']), [
    { value: 'codex', label: 'Codex' },
    { value: 'dsh', label: 'DSH' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'agy', label: 'Antigravity' },
  ]);

  assert.deepEqual(harnessChoices(['codex', 'claude-code', 'dsh']), [
    { value: 'codex', label: 'Codex' },
    { value: 'dsh', label: 'DSH' },
    { value: 'claude-code', label: 'Claude Code' },
  ]);

  assert.deepEqual(harnessChoices(['codex', 'claude-code', 'dsh'], 'agy'), [
    { value: 'codex', label: 'Codex' },
    { value: 'dsh', label: 'DSH' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'agy', label: 'Antigravity (needs check)' },
  ]);

  assert.deepEqual(harnessChoices(undefined, 'agy'), [
    { value: 'codex', label: 'Codex' },
    { value: 'dsh', label: 'DSH' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'agy', label: 'Antigravity (needs check)' },
  ]);

  assert.deepEqual(harnessChoices(['dsh'], 'codex'), [
    { value: 'codex', label: 'Codex' },
    { value: 'dsh', label: 'DSH' },
  ]);
});
