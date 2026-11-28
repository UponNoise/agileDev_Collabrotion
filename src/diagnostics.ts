import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessEntry } from './harness.js';
import { checkDshRunDirectory } from './run-directory.js';
import { ownerDshPatchArgs } from './adapters.js';
import { isolationDiagnostic } from './mcp-isolation.js';
import { consultLauncherIdentity } from './consult-verification.js';
import { agyCapabilities, dispatchOpen, matchesDispatchVerification, readDispatchVerification } from './dispatch-verification.js';

export type DiagnosticState = 'OK' | 'MISSING' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'KNOWN_LIMITATION' | 'ENFORCED' | 'NOT_GUARANTEED' | 'CONFIRMED' | 'UNAVAILABLE';
export interface Diagnostic { id: string; state: DiagnosticState; detail?: string }

async function agyDiagnostics(entry: HarnessEntry, context: { version?: string; dataDir: string }): Promise<Diagnostic[]> {
  const record = readDispatchVerification(context.dataDir, 'agy');
  const fresh = !!record
    && record.launcher === consultLauncherIdentity(entry)
    && (context.version !== undefined ? record.version === context.version : await matchesDispatchVerification(entry, record));
  const detail = record ? 'STALE' : 'NOT_VERIFIED';
  const dispatch: Diagnostic = !fresh
    ? { id: 'DISPATCH', state: 'UNKNOWN', detail }
    : { id: 'DISPATCH', state: dispatchOpen(record) ? 'CONFIRMED' : 'UNAVAILABLE' };
  const capabilities: Diagnostic[] = agyCapabilities.map(name => {
    if (!fresh) return { id: `CAPABILITY_${name}`, state: 'UNKNOWN' };
    const recorded = record.capabilities[name];
    return { id: `CAPABILITY_${name}`, state: recorded === 'NOT_RUN' ? 'UNKNOWN' : recorded };
  });
  let isolation: Diagnostic;
  if (!fresh) isolation = { id: 'MCP_ISOLATION', state: 'UNKNOWN', detail };
  else if (record.capabilities.MCP_ISOLATION === 'CONFIRMED') isolation = { id: 'MCP_ISOLATION', state: 'ENFORCED' };
  else if (record.capabilities.MCP_ISOLATION === 'NOT_RUN') isolation = { id: 'MCP_ISOLATION', state: 'UNKNOWN', detail: 'private home only; loaded servers not observable' };
  else isolation = { id: 'MCP_ISOLATION', state: 'NOT_GUARANTEED' };
  return [dispatch, ...capabilities, isolation];
}

export async function harnessDiagnostics(entry: HarnessEntry, context: {
  version?: string; dataDir: string; platform?: NodeJS.Platform; check?: typeof checkDshRunDirectory;
  helpRunner?: Parameters<typeof isolationDiagnostic>[1]['helpRunner'];
}): Promise<Diagnostic[]> {
  if (entry.id === 'agy') return agyDiagnostics(entry, context);
  const isolation = await isolationDiagnostic(entry, { ...context, ownerDshPatchArgs });
  if (entry.id !== 'dsh') return [isolation];
  const { dataDir, version, platform = process.platform, check = checkDshRunDirectory } = context;
  const runs = join(dataDir, 'runs');
  let directory = runs;
  while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
  const { state, missing } = await check(directory, undefined, platform);
  const rights: Diagnostic = { id: 'RUN_DIRECTORY_RIGHTS', state };
  if (directory !== runs) rights.detail = `inherited from ${directory}; runs directory not created yet`;
  else if (state === 'MISSING') rights.detail = `missing ${missing.join(' and ')}`;
  else if (state === 'OK') rights.detail = directory;
  else if (state === 'NOT_APPLICABLE') rights.detail = `platform ${platform}`;
  const pipedChildren: Diagnostic = {
    id: 'PIPED_CHILD_PROCESSES',
    state: platform !== 'win32' ? 'NOT_APPLICABLE' : /^0\.2\./.test(version ?? '') ? 'KNOWN_LIMITATION' : 'UNKNOWN',
    detail: 'DSH documents that its Windows sandbox refuses commands that start child processes with piped output, for example test runners that spawn workers. AgileDev does not detect this per run and does not change the sandbox mode; test evidence comes from the checks the service runs itself.',
  };
  return [rights, pipedChildren, isolation];
}
