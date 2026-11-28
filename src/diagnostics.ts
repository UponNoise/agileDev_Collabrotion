import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessEntry } from './harness.js';
import { checkDshRunDirectory } from './run-directory.js';

export type DiagnosticState = 'OK' | 'MISSING' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'KNOWN_LIMITATION';
export interface Diagnostic { id: string; state: DiagnosticState; detail?: string }

export async function harnessDiagnostics(entry: HarnessEntry, context: {
  version?: string; dataDir: string; platform?: NodeJS.Platform; check?: typeof checkDshRunDirectory;
}): Promise<Diagnostic[]> {
  if (entry.id !== 'dsh') return [];
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
  return [rights, pipedChildren];
}
