import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Actor, DomainError, Issue, Workspace } from './contracts.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    if ((this.db.pragma('user_version', { simple: true }) as number) > 1) {
      this.db.close();
      throw new DomainError('SCHEMA_TOO_NEW', 'This installation requires a newer application version');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 3000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, workspace_id TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_workspace ON records(kind,workspace_id);
      CREATE TABLE IF NOT EXISTS credentials (hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (actor_id TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor_id,key));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, operation TEXT NOT NULL, target_id TEXT, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_workspace ON events(workspace_id,sequence);
      PRAGMA user_version = 1;
    `);
  }
  get<T>(kind: string, id: string): T {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id) as { data: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', `${kind} not found`, 404);
    return JSON.parse(row.data) as T;
  }
  list<T>(kind: string, workspaceId?: string): T[] {
    const rows = workspaceId === undefined
      ? this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind)
      : this.db.prepare('SELECT data FROM records WHERE kind=? AND workspace_id=? ORDER BY rowid').all(kind, workspaceId);
    return (rows as { data: string }[]).map(r => JSON.parse(r.data) as T);
  }
  put<T extends { id: string }>(kind: string, value: T, workspaceId: string | null = null) {
    this.db.prepare('INSERT INTO records(kind,id,workspace_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, value.id, workspaceId, JSON.stringify(value));
  }
  token(actor: Actor): string {
    const token = randomBytes(32).toString('base64url');
    this.put('actor', actor);
    this.db.prepare('INSERT INTO credentials(hash,actor_id) VALUES(?,?)').run(hash(token), actor.id);
    return token;
  }
  bootstrap() {
    const actor: Actor = { id: randomUUID(), role: 'human', name: 'Local owner', workspaceIds: [], sessionId: randomUUID() };
    return { actor, token: this.token(actor) };
  }
  authenticate(token: string): Actor {
    const row = this.db.prepare('SELECT actor_id FROM credentials WHERE hash=?').get(hash(token)) as { actor_id: string } | undefined;
    if (!row) throw new DomainError('UNAUTHENTICATED', 'A valid scoped credential is required', 401);
    return this.get<Actor>('actor', row.actor_id);
  }
  workspace(actor: Actor, id: string): Workspace {
    if (actor.role !== 'human' && !actor.workspaceIds.includes(id)) throw new DomainError('SCOPE_DENIED', 'Workspace is outside credential scope', 403);
    return this.get<Workspace>('workspace', id);
  }
  issue(actor: Actor, workspaceId: string, id: string): Issue {
    this.workspace(actor, workspaceId);
    const issue = this.get<Issue>('issue', id);
    if (issue.workspaceId !== workspaceId) throw new DomainError('SCOPE_DENIED', 'Issue belongs to another workspace', 403);
    if (actor.role === 'worker' && issue.assignee !== actor.id && !this.list<Issue>('issue', workspaceId).some(child => child.parentId === issue.id && child.assignee === actor.id)) throw new DomainError('SCOPE_DENIED', 'Worker can only access assigned issues and their parent context', 403);
    return issue;
  }
  event(workspaceId: string, actor: Actor, operation: string, targetId: string | null, data: unknown) {
    this.db.prepare('INSERT INTO events(workspace_id,actor_id,operation,target_id,data,at) VALUES(?,?,?,?,?,?)').run(workspaceId, actor.id, operation, targetId, JSON.stringify(data), new Date().toISOString());
  }
  close() { this.db.close(); }
}
