import { execFile } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DomainError, Snapshot, Workspace } from './contracts.js';
import { canonical, hash } from './store.js';
import { inside } from './paths.js';
import { cleanGitEnv, copySnapshot, verifySnapshot } from './snapshots.js';

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

export interface ReworkStart { snapshot: Snapshot; baseSha?: string }
const reworkUnavailable = () => new DomainError('REWORK_BASE_UNAVAILABLE', 'The previous delivery could not be restored; dispatch again from the workspace', 409, undefined, { operation: 'work_dispatch', input: { start: 'workspace' } });
const git = async (cwd: string, args: string[], timeout = 60000) => (await exec('git', args, { cwd, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, env: cleanGitEnv() })).stdout;

async function restoreGitWorktree(source: string, root: string, subdirectory: string, rework: ReworkStart) {
  const sha = rework.baseSha!;
  await git(source, ['cat-file', '-e', `${sha}^{commit}`], 10000);
  await git(source, ['worktree', 'add', '--detach', root, sha], 30000);
  const base = await realpath(join(root, subdirectory));
  const keep = new Set(rework.snapshot.files.map(f => f.path));
  for (const path of (await git(base, ['ls-files', '-z', '--', '.'])).split('\0').filter(Boolean)) {
    if (!keep.has(path)) await rm(join(base, path), { force: true });
  }
  for (const file of rework.snapshot.files) {
    const target = join(base, file.path);
    const current = existsSync(target) ? hash(await readFile(target)) : null;
    if (current === file.hash) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(inside(rework.snapshot.root, file.path), target);
  }
  await git(base, ['add', '-A', '-f', '--', '.']);
  const staged = new Map<string, string>();
  for (const entry of (await git(base, ['ls-files', '-z', '--stage', '--', '.'])).split('\0').filter(Boolean)) {
    const match = entry.match(/^(\d{6}) [a-f0-9]+ \d\t([\s\S]+)$/);
    if (match) staged.set(match[2]!, match[1]!);
  }
  for (const file of rework.snapshot.files) {
    if (staged.get(file.path) !== file.mode) await git(base, ['update-index', `--chmod=${file.mode === '100755' ? '+x' : '-x'}`, '--', file.path]);
  }
  const tracked = (await git(base, ['ls-files', '-z', '--', '.'])).split('\0').filter(Boolean).sort();
  if (canonical(tracked) !== canonical([...keep].sort())) throw new Error('Restored tree differs from the snapshot');
  return base;
}

export async function prepareExecution(workspace: Workspace, runId: string, runDirectory: string, rework?: ReworkStart): Promise<ExecutionDirectory> {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new DomainError('RUN_ID_INVALID', 'Execution storage requires an immutable UUID run identifier');
  const source = await realpath(workspace.root);
  const directory = resolve(runDirectory, runId);
  const rel = relative(source, directory);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new DomainError('EXECUTION_ROOT_INVALID', 'Run storage must be outside the source workspace');
  await mkdir(directory, { recursive: true });
  const root = join(directory, 'workspace');
  if (existsSync(root)) throw new DomainError('EXECUTION_ROOT_EXISTS', 'Never reuse a previous execution directory');
  if (rework) {
    try {
      verifySnapshot(rework.snapshot);
      if (!workspace.commonDir) {
        copySnapshot(rework.snapshot, root);
        return { root: await realpath(root), mode: 'copy' };
      }
      if (!rework.baseSha) throw new Error('Base commit is not recorded');
      const top = await git(source, ['rev-parse', '--show-toplevel'], 10000);
      const subdirectory = relative(await realpath(top.trim()), source);
      return { root: await restoreGitWorktree(source, root, subdirectory, rework), baseSha: rework.baseSha, mode: 'git-worktree' };
    } catch {
      if (workspace.commonDir && existsSync(root)) {
        try { await git(source, ['worktree', 'remove', '--force', root], 30000); } catch {}
      }
      try { await rm(root, { recursive: true, force: true }); } catch {}
      if (workspace.commonDir) { try { await git(source, ['worktree', 'prune'], 30000); } catch {} }
      throw reworkUnavailable();
    }
  }
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
