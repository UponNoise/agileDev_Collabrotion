import { Actor, CheckRun, Design, Issue, Run, Snapshot, Workspace } from './contracts.js';
import { Store } from './store.js';

export function workspaceView(
  store: Store,
  workspace: Workspace,
  a: Record<string, any>,
  display: (issue: Issue) => unknown
) {
  const cursor = (
    store.db
      .prepare('SELECT COALESCE(MAX(sequence),0) AS cursor FROM events WHERE workspace_id=?')
      .get(workspace.id) as { cursor: number }
  ).cursor;
  if (a.afterCursor === cursor) return { unchanged: true, cursor };
  const joins =
    "LEFT JOIN records p ON p.kind='issue' AND p.id=json_extract(i.data,'$.parentId') LEFT JOIN records d ON d.kind='design' AND d.id=COALESCE(json_extract(p.data,'$.designId'),json_extract(i.data,'$.designId'))";
  const conditions = ["i.kind='issue'", 'i.workspace_id=?'];
  const values: any[] = [workspace.id];
  if (a.search) {
    conditions.push(
      "(instr(lower(json_extract(i.data,'$.title')),lower(?))>0 OR instr(lower(json_extract(i.data,'$.key')),lower(?))>0 OR instr(lower(json_extract(p.data,'$.title')),lower(?))>0)"
    );
    values.push(a.search, a.search, a.search);
  }
  if (a.state) {
    conditions.push("json_extract(i.data,'$.state')=?");
    values.push(a.state);
  }
  if (a.view === 'reviews')
    conditions.push(
      "(json_extract(i.data,'$.state') IN ('LEAD_REVIEW','QA_TEST','USER_ACCEPTANCE') OR (json_extract(i.data,'$.parentId') IS NULL AND json_extract(d.data,'$.status')='IN_REVIEW'))"
    );
  const where = conditions.join(' AND ');
  const total = (
    store.db.prepare(`SELECT COUNT(*) AS count FROM records i ${joins} WHERE ${where}`).get(...values) as {
      count: number;
    }
  ).count;
  const rows = store.db
    .prepare(
      `SELECT i.data FROM records i ${joins} WHERE ${where} ORDER BY COALESCE(p.rowid,i.rowid),CASE WHEN json_extract(i.data,'$.parentId') IS NULL THEN 0 ELSE 1 END,i.rowid LIMIT ? OFFSET ?`
    )
    .all(...values, a.limit, a.offset) as { data: string }[];
  const counts = store.db
    .prepare(
      "SELECT json_extract(data,'$.state') AS state,COUNT(*) AS count FROM records WHERE kind='issue' AND workspace_id=? GROUP BY state"
    )
    .all(workspace.id) as { state: string; count: number }[];
  return {
    workspace,
    cursor,
    total,
    issues: rows.map((r) => display(JSON.parse(r.data))),
    nextOffset: a.offset + a.limit < total ? a.offset + a.limit : null,
    statusCounts: Object.fromEntries(counts.map((r) => [r.state, r.count])),
    actors: store.list<Actor>('actor').filter((actor) => !actor.runId && actor.workspaceIds.includes(workspace.id)),
    profiles: store.list('check_profile', workspace.id),
    connections: store.list('connection', workspace.id),
    designs: store.list<Design>('design', workspace.id).map(({ id, issueId, status }) => ({ id, issueId, status }))
  };
}
export function issueView(store: Store, issue: Issue, a: Record<string, any>) {
  const root = issue.parentId ? store.get<Issue>('issue', issue.parentId) : issue;
  const revisions = store.list<Design>('design', issue.workspaceId).filter((d) => d.issueId === root.id);
  const design = root.designId ? store.get<Design>('design', root.designId) : null;
  const source = issue.candidate?.snapshotId ? store.get<Snapshot>('snapshot', issue.candidate.snapshotId) : null;
  const snapshot = source
    ? {
        id: source.id,
        workspaceId: source.workspaceId,
        issueId: source.issueId,
        candidateId: source.candidateId,
        files: source.files,
        hash: source.hash,
        createdAt: source.createdAt
      }
    : null;
  const history = store.db
    .prepare(
      `SELECT sequence,actor_id AS actorId,operation,target_id AS targetId,data,at FROM events WHERE workspace_id=? AND sequence>? AND (target_id=? OR target_id IN (SELECT id FROM records WHERE workspace_id=? AND json_extract(data,'$.issueId')=?)) ORDER BY sequence LIMIT ?`
    )
    .all(issue.workspaceId, a.after, issue.id, issue.workspaceId, issue.id, a.limit + 1) as any[];
  const page = history
    .slice(0, a.limit)
    .map((row) => ({ ...row, data: JSON.parse(row.data), actorName: store.get<Actor>('actor', row.actorId).name }));
  const evidence = store.db
    .prepare(
      "SELECT kind,id,data FROM records WHERE workspace_id=? AND kind IN ('snapshot','review','qa_report','git_submission','git_attempt','defect','scope_decision') AND (json_extract(data,'$.issueId')=? OR (kind='scope_decision' AND json_extract(data,'$.childId')=?)) ORDER BY rowid DESC LIMIT 100"
    )
    .all(issue.workspaceId, issue.id, issue.id) as { kind: string; id: string; data: string }[];
  const checks = store.db
    .prepare(
      "SELECT data FROM records WHERE workspace_id=? AND kind='check' AND json_extract(data,'$.issueId')=? ORDER BY rowid DESC LIMIT 20"
    )
    .all(issue.workspaceId, issue.id) as { data: string }[];
  const runs = store.db
    .prepare(
      "SELECT data FROM records WHERE workspace_id=? AND kind='run' AND json_extract(data,'$.issueId')=? ORDER BY rowid DESC LIMIT 20"
    )
    .all(issue.workspaceId, issue.id) as { data: string }[];
  return {
    design,
    snapshot,
    revision: design ? revisions.findIndex((d) => d.id === design.id) + 1 : null,
    designHistory: revisions.slice(-10).reverse(),
    parent: issue.parentId ? root : null,
    history: page,
    nextAfter: history.length > a.limit ? page.at(-1)!.sequence : null,
    evidence: evidence.map(({ kind, id, data }) => {
      const v = JSON.parse(data);
      return { kind, id, state: v.state, verdict: v.verdict, createdAt: v.createdAt ?? v.at ?? v.startedAt };
    }),
    checks: checks.map((row) => JSON.parse(row.data) as CheckRun),
    runs: runs.map((row) => JSON.parse(row.data) as Run)
  };
}
export function runsView(store: Store, workspaceId: string, a: Record<string, any>) {
  const total = (
    store.db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind='run' AND workspace_id=?").get(workspaceId) as {
      count: number;
    }
  ).count;
  const rows = store.db
    .prepare("SELECT data FROM records WHERE kind='run' AND workspace_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?")
    .all(workspaceId, a.limit, a.offset) as { data: string }[];
  return {
    runs: rows.map((row) => JSON.parse(row.data)),
    total,
    nextOffset: a.offset + a.limit < total ? a.offset + a.limit : null
  };
}
