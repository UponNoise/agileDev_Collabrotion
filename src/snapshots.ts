import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Candidate, DomainError, Snapshot } from './contracts.js';
import { canonical, hash } from './store.js';
import { inside } from './paths.js';

const excluded = new Set(['.git', 'node_modules', '.agiledev']);
export function cleanGitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)));
}
export function gitBlobHash(root: string, path: string) {
  try {
    return execFileSync('git', ['hash-object', '--stdin', `--path=${path}`], { cwd: root, env: cleanGitEnv(), input: readFileSync(inside(root, path)), encoding: 'utf8', maxBuffer: 1048576, timeout: 30000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new DomainError('SNAPSHOT_NORMALIZATION_UNAVAILABLE', 'Git delivery normalization failed; repair the workspace before re-running');
  }
}
function walk(root: string, allowQa = false, prefix = ''): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (excluded.has(entry.name) || (allowQa && prefix === '' && entry.name === '.qa')) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new DomainError('ARTIFACT_POLICY', 'Symlinks cannot be sealed as delivery artifacts');
    if (entry.isDirectory()) names.push(...walk(root, allowQa, path)); else names.push(path);
  }
  return names;
}
function safeArtifact(root: string, path: string) {
  if (isAbsolute(path) || path.split(/[\\/]/).some(p => p === '..' || p === '.git' || p === 'node_modules' || p === '.agiledev' || p === '.qa' || p === '.env' || p.startsWith('.env.'))) throw new DomainError('ARTIFACT_POLICY', 'Artifact path is reserved or outside the delivery scope');
  const file = inside(root, path); const st = lstatSync(join(root, path));
  if (!st.isFile() || st.isSymbolicLink()) throw new DomainError('ARTIFACT_POLICY', 'Delivery snapshots require regular files');
  if (st.size > Number(process.env.AGILEDEV_MAX_SNAPSHOT_FILE_BYTES ?? 33554432)) throw new DomainError('SNAPSHOT_LIMIT', 'Snapshot file exceeds the configured size limit');
  return { file, st };
}
export function snapshotManifest(root: string, selected: string[], git: boolean): Snapshot['files'] {
  let names: string[]; const modes = new Map<string,string>();
  if (git) {
    const execute = (args: string[]) => {
      try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { throw new DomainError('SNAPSHOT_NORMALIZATION_UNAVAILABLE', 'Git delivery normalization failed; repair the workspace before re-running'); }
    };
    for (const entry of execute(['ls-files', '-z', '--stage', '--cached', '--', '.']).split('\0').filter(Boolean)) {
      const match = entry.match(/^(\d{6}) [a-f0-9]+ (\d)\t([\s\S]+)$/);
      if (!match || match[2] !== '0') throw new DomainError('UNMERGED_ARTIFACT', 'Resolve unmerged Git entries before delivery');
      modes.set(match[3]!, match[1]!);
    }
    names = [...modes.keys(), ...execute(['ls-files', '-z', '--others', '--exclude-standard', '--', '.']).split('\0').filter(Boolean), ...selected];
  } else names = [...walk(root), ...selected];
  names = [...new Set(names.map(p => p.replaceAll('\\','/')))].filter(p => existsSync(join(root, p))).sort();
  if (names.length > Number(process.env.AGILEDEV_MAX_SNAPSHOT_FILES ?? 10000)) throw new DomainError('SNAPSHOT_LIMIT', 'Snapshot contains too many files');
  let bytes = 0;
  return names.map(path => {
    const { file, st } = safeArtifact(root, path); bytes += st.size;
    if (bytes > Number(process.env.AGILEDEV_MAX_SNAPSHOT_BYTES ?? 268435456)) throw new DomainError('SNAPSHOT_LIMIT', 'Snapshot exceeds the configured total size limit');
    const indexedMode = modes.get(path);
    if (indexedMode && !['100644','100755'].includes(indexedMode)) throw new DomainError('ARTIFACT_POLICY', 'Submodules and symbolic links require a separate delivery adapter');
    const mode = process.platform !== 'win32' ? st.mode & 0o111 ? '100755' : '100644' : indexedMode ?? '100644';
    if (!['100644','100755'].includes(mode)) throw new DomainError('ARTIFACT_POLICY', 'Submodules and symbolic links require a separate delivery adapter');
    return { path, hash: hash(readFileSync(file)), bytes: st.size, mode };
  });
}
export function verifySnapshot(snapshot: Snapshot, root = snapshot.root, allowQa = false) {
  const expected = snapshot.files.map(f => f.path).sort(); const actual = walk(root, allowQa).sort();
  if (canonical(expected) !== canonical(actual) || hash(canonical(snapshot.files)) !== snapshot.hash) throw new DomainError('EVIDENCE_STALE', 'Snapshot file manifest changed');
  for (const file of snapshot.files) {
    const path = inside(root, file.path);
    if (statSync(path).size !== file.bytes || hash(readFileSync(path)) !== file.hash) throw new DomainError('EVIDENCE_STALE', 'Snapshot source file changed');
    if (process.platform !== 'win32' && Boolean(statSync(path).mode & 0o111) !== (file.mode === '100755')) throw new DomainError('EVIDENCE_STALE','Snapshot executable mode changed');
  }
}
export function sealSnapshot(candidate: Candidate, workspaceId: string, issueId: string, destination: string, git: boolean): Snapshot {
  if (!candidate.executionRoot) throw new DomainError('SNAPSHOT_REQUIRED', 'A managed execution directory is required to seal this candidate');
  const source = candidate.executionRoot; const id = randomUUID(); const root = resolve(destination, id, 'files');
  const rel = relative(source, root); if (!isAbsolute(rel) && !rel.startsWith('..')) throw new DomainError('SNAPSHOT_ROOT_INVALID', 'Snapshot storage must be outside producer storage');
  for (const file of candidate.files) if (hash(readFileSync(inside(source,file.path))) !== file.hash) throw new DomainError('EVIDENCE_STALE', 'Producer changed a submitted file');
  let files = snapshotManifest(source, candidate.files.map(f => f.path), git);
  if (git) files = files.map(file => ({ path: file.path, hash: file.hash, bytes: file.bytes, mode: file.mode, blob: gitBlobHash(source, file.path) }));
  mkdirSync(root,{ recursive: true,mode: 0o700 });
  for (const file of files) { const dest = join(root,file.path); mkdirSync(resolve(dest,'..'), { recursive: true, mode: 0o700 }); copyFileSync(inside(source,file.path),dest); if (process.platform !== 'win32') chmodSync(dest,file.mode === '100755' ? 0o755 : 0o644); }
  const snapshot: Snapshot = { id, workspaceId, issueId, candidateId: candidate.id, root, files, hash: hash(canonical(files)), createdAt: new Date().toISOString() };
  verifySnapshot(snapshot);
  if (canonical(snapshotManifest(source, candidate.files.map(f => f.path), git)) !== canonical(files.map(file => ({ path: file.path, hash: file.hash, bytes: file.bytes, mode: file.mode })))) throw new DomainError('EVIDENCE_STALE', 'Producer changed during snapshot capture');
  return snapshot;
}
export function copySnapshot(snapshot: Snapshot, root: string) {
  verifySnapshot(snapshot);
  if (existsSync(root)) throw new DomainError('EXECUTION_ROOT_EXISTS', 'Never reuse a QA execution directory');
  mkdirSync(root,{ recursive: true,mode: 0o700 });
  for (const file of snapshot.files) { const dest = join(root,file.path); mkdirSync(resolve(dest,'..'), { recursive: true, mode: 0o700 }); copyFileSync(inside(snapshot.root,file.path), dest); if (process.platform !== 'win32') chmodSync(dest,file.mode === '100755' ? 0o755 : 0o644); }
  verifySnapshot(snapshot, root);
}
