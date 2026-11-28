import { spawn } from 'node:child_process';
import { DomainError } from './contracts.js';
import { harnessEnvironment, type HarnessEntry } from './harness.js';
import type { Diagnostic } from './diagnostics.js';

type DshProfile = 'sdk' | 'headless';

function scalar(raw: string) {
  const value = raw.trim();
  const quoted = /^(?:"((?:\\.|[^"\\])*)"|'((?:''|[^'])*)')/.exec(value);
  return quoted ? (quoted[1] ?? quoted[2]!) : value.replace(/(?:^|\s+)#.*$/, '').trim();
}

export function parseDshComposition(dump: string) {
  const rows: { id?: string; name?: string }[] = [];
  let row: (typeof rows)[number] | undefined;
  for (const line of dump.split(/\r?\n/)) {
    if (line.startsWith('- ')) {
      row = {};
      rows.push(row);
    }
    const key = /^(?:- +| {2})(id|name) *:(?:\s|$)(.*)$/.exec(line);
    if (row && key) row[key[1] as 'id' | 'name'] = scalar(key[2]!);
  }
  const clientRowIds = new Set<string>();
  let managerRows = 0;
  let idlessClientRows = 0;
  for (const { id, name } of rows) {
    if (name === '@deepseek-ai/dsh-mcp-manager') managerRows++;
    if (name !== '@deepseek-ai/dsh-mcp-client') continue;
    if (!id) idlessClientRows++;
    else if (id !== 'agiledev-mcp') clientRowIds.add(id);
  }
  return { rowCount: rows.length, clientRowIds: [...clientRowIds], managerRows, idlessClientRows };
}

type ProbeFailure = 'dump failed' | 'dump timed out';
type ProbeResult = { stdout: string; stderr: string } | { reason: ProbeFailure };

function runProbe(entry: HarnessEntry, args: string[], cwd: string | undefined, timeout: number, limit: number): Promise<ProbeResult> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(entry.command, [...entry.args, ...args], {
        cwd, env: harnessEnvironment(entry.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ reason: 'dump failed' });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let stopReason: ProbeFailure | undefined;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (reason: ProbeFailure) => {
      if (stopReason) return;
      stopReason = reason;
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      stop('dump timed out');
      finish({ reason: stopReason ?? 'dump timed out' });
    }, timeout);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (settled || stopReason) return;
      bytes += chunk.length;
      if (bytes > limit) stop('dump failed');
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', () => finish({ reason: stopReason ?? 'dump failed' }));
    child.once('close', code => {
      if (settled) return;
      finish(code === 0 && !stopReason
        ? { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
        : { reason: stopReason ?? 'dump failed' });
    });
  });
}

export async function collectDshMcpRows(entry: HarnessEntry, profile: DshProfile, ownerArgs: string[], cwd: string) {
  const dump = await runProbe(entry, ['--profile', profile, ...ownerArgs, '--dump-config'], cwd, 30_000, 8 * 1024 * 1024);
  if ('reason' in dump) return dump;
  const rows = parseDshComposition(dump.stdout);
  if (!rows.rowCount) return { reason: 'dump was not a configuration' } as const;
  if (rows.managerRows) return { reason: 'manager row present' } as const;
  if (rows.idlessClientRows) return { reason: 'MCP row without an id' } as const;
  return { clientRowIds: rows.clientRowIds };
}

type HelpRunner = (entry: HarnessEntry, args: string[]) => Promise<string>;

const runHelp: HelpRunner = async (entry, args) => {
  const output = await runProbe(entry, args, undefined, 10_000, 1024 * 1024);
  if ('reason' in output) throw new Error('Help probe failed');
  return output.stdout + '\n' + output.stderr;
};

export async function isolationDiagnostic(entry: HarnessEntry, context: {
  dataDir: string; ownerDshPatchArgs(): string[]; helpRunner?: HelpRunner;
}): Promise<Diagnostic> {
  const id = 'MCP_ISOLATION';
  const flag = entry.id === 'codex' ? '--ignore-user-config' : entry.id === 'claude-code' ? '--strict-mcp-config' : '--dump-config';
  const args = entry.id === 'codex' ? ['exec', '--help'] : ['--help'];
  const { dataDir, helpRunner = runHelp } = context;
  let help: string;
  try { help = await helpRunner(entry, args); }
  catch { return { id, state: 'UNKNOWN', detail: 'help failed' }; }
  if (!help.match(/--[a-z][\w-]*/g)?.includes(flag)) return { id, state: 'NOT_GUARANTEED', detail: flag + ' absent from help' };
  if (entry.id !== 'dsh') return { id, state: 'ENFORCED', detail: flag };

  let ownerArgs: string[];
  try { ownerArgs = context.ownerDshPatchArgs(); }
  catch (error) { return { id, state: 'UNKNOWN', detail: error instanceof DomainError ? error.code : 'owner patch check failed' }; }
  const profiles = ['sdk', 'headless'] as const;
  const results = await Promise.all(profiles.map(async profile => ({
    profile, result: await collectDshMcpRows(entry, profile, ownerArgs, dataDir),
  })));
  const counts: string[] = [];
  let unknownReason: string | undefined;
  for (const { profile, result } of results) {
    if ('reason' in result) {
      if (result.reason === 'manager row present' || result.reason === 'MCP row without an id') {
        return { id, state: 'NOT_GUARANTEED', detail: profile + ': ' + result.reason };
      }
      unknownReason ??= result.reason;
    } else {
      counts.push(profile + ': disables ' + result.clientRowIds.length + ' other MCP rows');
    }
  }
  if (unknownReason) return { id, state: 'UNKNOWN', detail: unknownReason };
  return {
    id, state: 'ENFORCED',
    detail: counts.join('; ') + '. Detection covers top-level client and manager rows. Servers registered by other plugins, rows nested in groups, and differently named wrappers are outside detection.',
  };
}
