import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { Harness } from './contracts.js';

const exec = promisify(execFile);
export interface HarnessEntry { id: Harness; command: string; args: string[]; env?: Record<string, string> }
function executable(name: string): string | undefined {
  for (const path of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of process.platform === 'win32' ? ['.exe'] : ['']) {
      const candidate = join(path, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
function directories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}
export function discoverHarnesses(): HarnessEntry[] {
  const result: HarnessEntry[] = [];
  const roaming = process.env.APPDATA ?? '';
  const local = process.env.LOCALAPPDATA ?? '';
  const codexJs = join(roaming, 'npm/node_modules/@openai/codex/bin/codex.js');
  const codex = process.env.AGILEDEV_CODEX_PATH ?? executable('codex');
  if (codex && existsSync(codex)) result.push({ id: 'codex', command: codex, args: [] });
  else if (process.platform === 'win32' && existsSync(codexJs)) result.push({ id: 'codex', command: process.execPath, args: [codexJs] });
  let claude = process.env.AGILEDEV_CLAUDE_PATH ?? executable('claude');
  if (!claude && process.platform === 'win32') {
    const base = join(local, 'Claude-Data');
    for (const container of directories(base)) for (const version of directories(join(base, container, 'claude-code'))) {
      for (const build of directories(join(base, container, 'claude-code', version))) {
        const path = join(base, container, 'claude-code', version, build, 'claude.exe');
        if (!claude && existsSync(path)) claude = path;
      }
    }
  }
  if (claude && existsSync(claude)) result.push({ id: 'claude-code', command: claude, args: [] });
  const dsh = process.env.AGILEDEV_DSH_PATH ?? executable('dsh');
  const desktop = join(local, 'Programs/DeepSeek Harness/DeepSeek Harness.exe');
  const entry = join(local, 'Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
  if (dsh && existsSync(dsh)) result.push({ id: 'dsh', command: dsh, args: [] });
  else if (process.platform === 'win32' && existsSync(desktop) && existsSync(join(local, 'Programs/DeepSeek Harness/resources/app.asar'))) result.push({ id: 'dsh', command: desktop, args: ['--expose-internals', entry], env: { ELECTRON_RUN_AS_NODE: '1' } });
  return result;
}
export async function probeHarness(entry: HarnessEntry) {
  try {
    const { stdout } = await exec(entry.command, [...entry.args, '--version'], { env: { ...process.env, ...entry.env }, timeout: 10000, windowsHide: true, maxBuffer: 65536 });
    return { id: entry.id, available: true, version: stdout.trim(), executionVerified: false };
  } catch {
    return { id: entry.id, available: false, error: 'VERSION_PROBE_FAILED', executionVerified: false };
  }
}
