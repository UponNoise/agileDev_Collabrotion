import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { agentRoles, DomainError, joinHarnesses, type Actor, type AgentRole, type Channel, type JoinHarness, type Workspace } from './contracts.js';
import { hash, type Store } from './store.js';

export const joinInput = z.object({
  workspaceId: z.string().min(1).max(150).optional(), name: z.string().min(1).max(120),
  role: z.enum(agentRoles), harness: z.enum(joinHarnesses),
}).strict();
export const pollInput = z.object({ requestId: z.string(), secret: z.string() }).strict();

type JoinState = 'PENDING' | 'APPROVED' | 'REFUSED' | 'CLAIMED' | 'EXPIRED';
interface JoinRequest {
  id: string; workspaceId: string; name: string; role: AgentRole; harness: JoinHarness;
  state: JoinState; version: number; secretHash: string; createdAt: string; expiresAt: string;
  decidedAt?: string; decidedBy?: string; decidedChannel?: Channel; claimBy?: string;
  claimedAt?: string; actorId?: string;
}
const windowMs = 600_000;
const pollAfterMs = 2000;
const iso = (time: number) => new Date(time).toISOString();
const retryAfter = (until: number, now: number) => ({ retryAfterSeconds: Math.ceil((until - now) / 1000) });

export function effectiveJoinState(request: JoinRequest, now: number): JoinState {
  if (request.state === 'PENDING' && now >= Date.parse(request.expiresAt)) return 'EXPIRED';
  if (request.state === 'APPROVED' && now >= Date.parse(request.claimBy!)) return 'EXPIRED';
  return request.state;
}

export function pendingJoinRequests(store: Store, workspaceId: string, now: number) {
  return store.list<JoinRequest>('join_request', workspaceId).filter(request => effectiveJoinState(request, now) === 'PENDING');
}

export function decideJoinRequest(store: Store, actor: Actor, input: {
  workspaceId: string; requestId: string; expectedVersion: number; decision: 'APPROVE' | 'REFUSE';
}, now: number) {
  const request = store.get<JoinRequest>('join_request', input.requestId);
  if (request.workspaceId !== input.workspaceId) throw new DomainError('NOT_FOUND', 'Join request not found', 404);
  if (request.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Reload the join request before deciding', 409, { currentVersion: request.version });
  if (effectiveJoinState(request, now) === 'EXPIRED') throw new DomainError('JOIN_REQUEST_EXPIRED', 'The request has expired; the agent must apply again', 409);
  if (request.state !== 'PENDING') throw new DomainError('INVALID_TRANSITION', 'The join request is no longer pending');
  request.state = input.decision === 'APPROVE' ? 'APPROVED' : 'REFUSED';
  if (request.state === 'APPROVED') request.claimBy = iso(now + windowMs);
  request.decidedAt = iso(now);
  request.decidedBy = actor.id;
  request.decidedChannel = actor.channel;
  request.version++;
  store.put('join_request', request, request.workspaceId);
  const { name, role, harness, secretHash, ...rest } = request;
  store.event(request.workspaceId, actor, 'join_request_decide', request.id, { decision: input.decision, role, name, harness }, now);
  return { request: { ...rest, name, role, harness } };
}

export class JoinRequests {
  private creations: number[] = [];
  constructor(private store: Store, private now = Date.now) {}

  create(input: z.infer<typeof joinInput>) {
    const now = this.now();
    const { name, role, harness } = input;
    let workspaceId = input.workspaceId;
    if (workspaceId !== undefined) this.store.get<Workspace>('workspace', workspaceId);
    else {
      const workspaces = this.store.list<Workspace>('workspace').map(({ id, name }) => ({ id, name }));
      if (!workspaces.length) throw new DomainError('NO_WORKSPACE', 'Ask the owner to register a workspace', 409);
      if (workspaces.length > 1) throw new DomainError('WORKSPACE_REQUIRED', 'Pass the workspaceId you want to join', 409, { workspaces });
      workspaceId = workspaces[0]!.id;
    }
    const result = this.store.db.transaction(() => {
      const requests = this.store.list<JoinRequest>('join_request');
      const pending = requests.filter(request => effectiveJoinState(request, now) === 'PENDING');
      if (pending.some(request => request.workspaceId === workspaceId && request.name === name && request.role === role && request.harness === harness))
        throw new DomainError('JOIN_REQUEST_PENDING', 'Wait for the owner to decide the existing request', 409);
      let refusedAt = -Infinity;
      for (const request of requests) {
        if (request.state === 'REFUSED' && request.workspaceId === workspaceId && request.name === name && request.role === role)
          refusedAt = Math.max(refusedAt, Date.parse(request.decidedAt!));
      }
      if (refusedAt + windowMs > now) throw new DomainError('JOIN_REQUEST_REFUSED_RECENTLY', 'Wait retryAfterSeconds before applying again', 429, retryAfter(refusedAt + windowMs, now));
      if (pending.length >= 5) throw new DomainError('JOIN_REQUESTS_PENDING_LIMIT', 'Wait for a pending request to be decided or expire', 429);
      this.creations = this.creations.filter(at => at > now - windowMs);
      if (this.creations.length >= 10) throw new DomainError('JOIN_RATE_LIMIT', 'Wait retryAfterSeconds before applying again', 429, retryAfter(this.creations[0]! + windowMs, now));
      const secret = randomBytes(32).toString('base64url');
      const request: JoinRequest = {
        id: randomUUID(), workspaceId, name, role, harness, state: 'PENDING', version: 1,
        secretHash: hash(secret), createdAt: iso(now), expiresAt: iso(now + windowMs),
      };
      this.store.put('join_request', request, workspaceId);
      this.store.event(workspaceId, { id: request.id, channel: 'applicant' }, 'agent_join_requested', request.id, { name, role, harness }, now);
      return { ok: true, requestId: request.id, secret, state: 'PENDING' as const, expiresAt: request.expiresAt, pollAfterMs };
    }).immediate();
    this.creations.push(now);
    return result;
  }

  poll<T>(input: z.infer<typeof pollInput>, buildFirstSteps: (actor: Actor & { role: AgentRole }, workspace: Workspace) => T) {
    const now = this.now();
    return this.store.db.transaction(() => {
      const row = this.store.db.prepare("SELECT data FROM records WHERE kind='join_request' AND id=?").get(input.requestId) as { data: string } | undefined;
      const request = row && JSON.parse(row.data) as JoinRequest;
      if (!request || !timingSafeEqual(Buffer.from(request.secretHash, 'hex'), Buffer.from(hash(input.secret), 'hex')))
        throw new DomainError('JOIN_REQUEST_NOT_FOUND', 'Apply again if you no longer have the original request and secret', 404);
      const state = effectiveJoinState(request, now);
      if (state === 'EXPIRED' && request.state !== state) {
        request.state = state;
        request.version++;
        this.store.put('join_request', request, request.workspaceId);
      }
      if (state === 'PENDING') return { ok: true, state, expiresAt: request.expiresAt, pollAfterMs };
      if (state !== 'APPROVED') return { ok: true, state };
      const { workspaceId, role, name, harness } = request;
      const actor: Actor & { role: AgentRole } = {
        id: randomUUID(), role, name, workspaceIds: [workspaceId], sessionId: randomUUID(), harness,
        joinedVia: 'join_request', joinedAt: iso(now),
      };
      const token = this.store.token(actor);
      Object.assign(request, { state: 'CLAIMED', claimedAt: iso(now), actorId: actor.id, version: request.version + 1 });
      this.store.put('join_request', request, workspaceId);
      this.store.event(workspaceId, { id: request.decidedBy!, channel: 'confirmed' }, 'actor_enroll', actor.id, {
        role, name, harness, requestId: request.id, via: 'join_request', decidedChannel: request.decidedChannel,
      }, now);
      const firstSteps = buildFirstSteps(actor, this.store.get<Workspace>('workspace', workspaceId));
      return { ok: true, state, actor: { id: actor.id, name, role, harness, workspaceId }, token, firstSteps };
    }).immediate();
  }
}
