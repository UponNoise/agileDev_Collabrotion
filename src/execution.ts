import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, realpath } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DomainError, Workspace } from './contracts.js';

const exec = promisify(execFile);
export interface ExecutionDirectory { root: string; baseSha?: string; mode: 'git-worktree' | 'copy' }

export function resolveExecutionDependencies(path?: string) {
  if (path === undefined) return undefined;
  if (isAbsolute(path)) {
    try {
      const resolved = realpathSync(path);
      if (statSync(resolved).isDirectory()) return resolved;
    } catch {}
  }
  throw new DomainError('INVALID_EXECUTION_DEPENDENCIES', 'AGILEDEV_EXECUTION_DEPENDENCIES must name an accessible absolute dependency directory');
}

export function linkExecutionDependencies(root: string, source: string) {
  const preparedRoot = realpathSync(root);
  const link = join(preparedRoot, 'node_modules');
  try {
    if (!statSync(source).isDirectory()) throw new Error();
    symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DomainError('DEPENDENCY_LINK_CONFLICT', 'The prepared root already contains node_modules');
    throw new DomainError('DEPENDENCY_LINK_FAILED', 'Could not link the configured dependencies into the prepared root');
  }
  return () => {
    try {
      if (realpathSync(preparedRoot) !== preparedRoot) throw new Error();
      const entry = lstatSync(link, { throwIfNoEntry: false });
      if (!entry) return;
      if (!entry.isSymbolicLink()) throw new Error();
      unlinkSync(link);
    } catch {
      throw new DomainError('DEPENDENCY_LINK_CLEANUP_FAILED', 'Could not safely unlink node_modules from the retained execution root');
    }
  };
}

export async function prepareExecution(workspace: Workspace, runId: string, runDirectory: string): Promise<ExecutionDirectory> {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new DomainError('RUN_ID_INVALID', 'Execution storage requires an immutable UUID run identifier');
  const source = await realpath(workspace.root);
  const directory = resolve(runDirectory, runId);
  const rel = relative(source, directory);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new DomainError('EXECUTION_ROOT_INVALID', 'Run storage must be outside the source workspace');
  await mkdir(directory, { recursive: true });
  const root = join(directory, 'workspace');
  if (existsSync(root)) throw new DomainError('EXECUTION_ROOT_EXISTS', 'Never reuse a previous execution directory');
  if (workspace.commonDir) {
    const status = await exec('git', ['status', '--porcelain', '--untracked-files=normal', '--', '.'], { cwd: source, windowsHide: true, timeout: 10000 });
    if (status.stdout.trim()) throw new DomainError('WORKSPACE_DIRTY', 'Commit or preserve source changes before preparing an isolated Git snapshot');
    const top = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: source, windowsHide: true, timeout: 10000 });
    const subdirectory = relative(await realpath(top.stdout.trim()), source);
    const { stdout } = await exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: source, windowsHide: true, timeout: 10000 });
    const baseSha = stdout.trim();
    await exec('git', ['worktree', 'add', '--detach', root, baseSha], { cwd: source, windowsHide: true, timeout: 30000 });
    return { root: await realpath(join(root, subdirectory)), baseSha, mode: 'git-worktree' };
  }
  const excluded = new Set(['.git', '.agiledev', 'node_modules', '.env']);
  await cp(source, root, { recursive: true, filter: async path => {
    const name = basename(path);
    if (excluded.has(name) || name.startsWith('.env.')) return false;
    return !(await lstat(path)).isSymbolicLink();
  } });
  return { root: await realpath(root), mode: 'copy' };
}

export async function terminateTree(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } else process.kill(-pid, 'SIGKILL');
    return true;
  } catch { return false; }
}
