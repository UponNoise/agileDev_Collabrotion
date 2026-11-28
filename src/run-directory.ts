import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { harnessEnvironment } from './harness.js';

export type RightState = 'GRANTED' | 'DENIED' | 'UNKNOWN';
export interface DirectoryRights { writeDac: RightState; writeOwner: RightState }
export type DirectoryRightsReader = (directory: string) => Promise<DirectoryRights>;
export interface RunDirectoryCheck {
  state: 'OK' | 'MISSING' | 'UNKNOWN' | 'NOT_APPLICABLE';
  missing: ('WRITE_DAC' | 'WRITE_OWNER')[];
}

const rightsScript = `
Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AgileDevDirectoryRights {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Probe(string path, uint access) {
        IntPtr handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return Marshal.GetLastWin32Error();
        CloseHandle(handle);
        return 0;
    }
}
'@
$writeDac = [AgileDevDirectoryRights]::Probe($env:AGILEDEV_RIGHTS_PATH, 0x00040000)
$writeOwner = [AgileDevDirectoryRights]::Probe($env:AGILEDEV_RIGHTS_PATH, 0x00080000)
'{{"writeDac":{0},"writeOwner":{1}}}' -f $writeDac, $writeOwner
`;

function rightState(code: number): RightState {
  if (code === 0) return 'GRANTED';
  if (code === 5) return 'DENIED';
  return 'UNKNOWN';
}

export async function readWindowsDirectoryRights(directory: string): Promise<DirectoryRights> {
  try {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = await new Promise<string | undefined>(resolve => {
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', rightsScript], {
        env: harnessEnvironment({ AGILEDEV_RIGHTS_PATH: directory }), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      const timer = setTimeout(() => {
        resolve(undefined);
        child.kill();
      }, 10000);
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.once('error', () => { clearTimeout(timer); resolve(undefined); });
      child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? stdout : undefined); });
    });
    if (output !== undefined) {
      const codes = JSON.parse(output);
      if (Number.isInteger(codes?.writeDac) && Number.isInteger(codes?.writeOwner)) {
        return { writeDac: rightState(codes.writeDac), writeOwner: rightState(codes.writeOwner) };
      }
    }
  } catch {}
  return { writeDac: 'UNKNOWN', writeOwner: 'UNKNOWN' };
}

export async function checkDshRunDirectory(
  directory: string, read: DirectoryRightsReader = readWindowsDirectoryRights, platform = process.platform,
): Promise<RunDirectoryCheck> {
  if (platform !== 'win32') return { state: 'NOT_APPLICABLE', missing: [] };
  try {
    const { writeDac, writeOwner } = await read(directory);
    const missing: RunDirectoryCheck['missing'] = [];
    if (writeDac === 'DENIED') missing.push('WRITE_DAC');
    if (writeOwner === 'DENIED') missing.push('WRITE_OWNER');
    if (missing.length) return { state: 'MISSING', missing };
    if (writeDac === 'GRANTED' && writeOwner === 'GRANTED') return { state: 'OK', missing };
  } catch {}
  return { state: 'UNKNOWN', missing: [] };
}
