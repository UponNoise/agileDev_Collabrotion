import { DomainError, type Actor, type AgentRole, type Run } from './contracts.js';
import type { Store } from './store.js';

export function isDisabled(store: Store, id: string) {
  return !!store.db.prepare("SELECT 1 FROM records WHERE kind='actor' AND id=? AND json_extract(data, '$.disabledAt') IS NOT NULL").get(id);
}

function inWorkspace(actor: Actor, workspaceId: string) {
  return actor.role !== 'human' && !actor.runId && !actor.principalId && actor.workspaceIds.includes(workspaceId);
}

export function agentView(store: Store, workspaceId: string, actor: Actor) {
  const enrolled = store.db.prepare("SELECT at FROM events WHERE workspace_id=? AND operation='actor_enroll' AND target_id=? ORDER BY sequence LIMIT 1").get(workspaceId, actor.id) as { at: string } | undefined;
  const last = store.db.prepare(`SELECT json_extract(data, '$.initializedAt') AS at FROM records
    WHERE kind='connection' AND json_extract(data, '$.actorId')=? ORDER BY at DESC LIMIT 1`).get(actor.id) as { at: string } | undefined;
  return {
    id: actor.id, name: actor.name, role: actor.role, harness: actor.harness ?? null,
    status: actor.disabledAt ? 'DISABLED' : 'ACTIVE', joinedVia: actor.joinedVia ?? null,
    joinedAt: actor.joinedAt ?? enrolled?.at ?? null, lastConnectedAt: last?.at ?? null, disabledAt: actor.disabledAt ?? null,
  };
}

export function listAgents(store: Store, workspaceId: string, input: { agentRole?: AgentRole; includeDisabled: boolean; limit: number; offset: number }) {
  const { agentRole, includeDisabled, limit, offset } = input;
  const agents = store.list<Actor>('actor').filter(actor =>
    inWorkspace(actor, workspaceId) && (includeDisabled || !actor.disabledAt) && (!agentRole || actor.role === agentRole));
  return { agents: agents.slice(offset, offset + limit).map(actor => agentView(store, workspaceId, actor)),
    total: agents.length, nextOffset: offset + limit < agents.length ? offset + limit : null };
}

export function requestRunStop(store: Store, actor: Actor, run: Run, reason: string, now: number) {
  if (run.state === 'UNCERTAIN') throw new DomainError('RUN_UNCERTAIN', 'Reconcile external execution before issuing a new stop request');
  if (run.state === 'QUEUED') {
    run.state = 'CANCELLED';
    run.finishedAt = new Date(now).toISOString();
  } else run.state = 'STOPPING';
  run.stopReason = reason;
  run.version = (run.version ?? 1) + 1;
  store.put('run', run, run.workspaceId);
  store.event(run.workspaceId, actor, 'run_interrupt', run.id, { state: run.state, reason });
  return run;
}

export function disableAgent(store: Store, caller: Actor, workspaceId: string, actorId: string,
  event: 'agent_disable' | 'agent_retire', now: number, reason?: string) {
  return store.db.transaction(() => {
    const actor = store.get<Actor>('actor', actorId);
    if (!inWorkspace(actor, workspaceId)) throw new DomainError('SCOPE_DENIED', 'Select a logical agent in this workspace', 403);
    if (actor.disabledAt) return { actor };
    actor.disabledAt = new Date(now).toISOString();
    store.put('actor', actor);
    store.revokeActor(actor.id);
    for (const identity of store.list<Actor>('actor')) if (identity.principalId === actor.id) store.revokeActor(identity.id);
    const runsStopped = store.list<Run>('run').filter(run => run.actorId === actor.id && ['QUEUED', 'STARTING', 'RUNNING'].includes(run.state))
      .map(run => requestRunStop(store, caller, run, reason ?? (event === 'agent_retire' ? 'Agent session ended' : 'Agent disabled'), now).id);
    store.event(workspaceId, caller, event, actor.id, { role: actor.role, name: actor.name,
      ...(event === 'agent_disable' ? { reason } : {}), runsStopped });
    return { actor };
  }).immediate();
}
