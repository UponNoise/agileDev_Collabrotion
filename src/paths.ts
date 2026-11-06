import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DomainError } from './contracts.js';

export function inside(root: string, path: string): string {
  const resolved = realpathSync(resolve(root, path)); const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new DomainError('PATH_DENIED', 'Path escapes the workspace', 403);
  return resolved;
}
