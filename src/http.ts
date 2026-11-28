import { timingSafeEqual } from 'node:crypto';
import { firstSteps } from './agent-profiles.js';
import { disableAgent } from './identities.js';
import { JoinRequests, joinInput, pollInput } from './join.js';
import { claimOwner, isOwnerClaimed } from './owner.js';
import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { Actor, DomainError, type Harness } from './contracts.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import type { ConsultAvailability } from './consult.js';
import { WebSessions,browserCookie } from './web-session.js';
import { commandFailure } from './issue-brief.js';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare module 'fastify' { interface FastifyRequest { actor: Actor; browserSession?: string } }
export function createServer(
  store: Store,
  lifecycle?: { instance: string; stopToken: string; stop(): Promise<void>; ownerClaimed?(): void },
  options: { now?: () => number; consultAvailable?: ConsultAvailability; dispatchAvailable?: (harness: Harness) => boolean } = {}
) {
  const app = Fastify({ logger: false, bodyLimit: 262144, requestTimeout: 15000 });
  const shutdown = new AbortController();
  app.addHook('preClose', async () => { shutdown.abort(); });
  const now = options.now ?? Date.now;
  const workflow = new Workflow(store, now, options.consultAvailable, options.dispatchAvailable);
  const sessions = new WebSessions(store, now);
  const joins = new JoinRequests(store, now);
  const bearerActor = (token: string, path: string, method: string): Actor => {
    const actor = store.authenticate(token);
    const claimed = actor.role === 'human' && isOwnerClaimed(store);
    if (claimed && !((method === 'POST' && ['/api/ui/pairing', '/api/owner/claim'].includes(path)) ||
      (method === 'GET' && path === '/api/session')))
      throw new DomainError('HUMAN_SESSION_REQUIRED', 'Human decisions are made in the desktop app', 403);
    return { ...actor, channel: actor.role === 'human' ? (claimed ? 'desktop' : 'owner_credential') : actor.runId ? 'run' : 'agent' };
  };
  app.addHook('onRequest', async (request,reply) => {
    reply.headers({ 'cache-control': 'no-store','referrer-policy': 'no-referrer','x-content-type-options': 'nosniff','x-frame-options': 'DENY','content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    const host = request.headers.host;
    if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new DomainError('HOST_DENIED', 'Only loopback hosts are accepted', 403);
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) throw new DomainError('ORIGIN_DENIED', 'Origin does not match the local service', 403);
    const path = request.url.split('?')[0]!;
    if (path === '/health' || (path === '/api/ui/status' && request.method === 'GET') || ((request.method === 'GET' || request.method === 'HEAD') && (path === '/' || path === '/favicon.ico' || path.startsWith('/assets/') || /^\/w\/[^/]+\/issues\/[^/]+$/.test(path)))) return;
    if (request.method === 'POST' && (path === '/api/join' || path === '/api/join/poll')) return;
    if (path === '/api/ui/login' && request.method === 'POST') {
      if (origin !== `http://${host}`) throw new DomainError('ORIGIN_DENIED','Pairing requires the local page Origin',403);
      return;
    }
    const bearer = request.headers.authorization;
    if (path === '/api/service/stop' && request.method === 'POST') {
      const expected = lifecycle && Buffer.from(`Bearer ${lifecycle.stopToken}`);
      const supplied = Buffer.from(bearer ?? '');
      if (!expected || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new DomainError('UNAUTHENTICATED', 'A valid service stop token is required', 401);
      return;
    }
    if (bearer?.startsWith('Bearer ')) {
      request.actor = bearerActor(bearer.slice(7), path, request.method);
      return;
    }
    const cookie = sessions.cookie(request.headers.cookie);
    if (!cookie) throw new DomainError('UNAUTHENTICATED','Pair the browser or supply a scoped API credential',401);
    request.actor = sessions.authenticate(cookie); request.browserSession = cookie;
    if (!['GET','HEAD'].includes(request.method)) {
      if (origin !== `http://${host}`) throw new DomainError('ORIGIN_DENIED','Browser changes require the local page Origin',403);
      sessions.checkCsrf(cookie,request.headers['x-csrf-token'] as string | undefined);
    }
  });
  app.addHook('preHandler', (request, _reply, done) => {
    // A credential may have been revoked while the body was arriving.
    if (request.actor && request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.browserSession) request.actor = sessions.authenticate(request.browserSession);
      else request.actor = bearerActor(request.headers.authorization!.slice(7), request.url.split('?')[0]!, request.method);
    }
    done();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ ok: false, error: commandFailure(error.code, error.message, error.details) });
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: commandFailure('INVALID_INPUT', 'Invalid request') });
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    return reply.code(status >= 400 && status < 500 ? status : 500).send({ ok: false, error: commandFailure(status === 400 ? 'INVALID_INPUT' : 'INTERNAL_ERROR', 'Request could not be completed') });
  });
  app.get('/health', () => ({ name: 'agiledev-collaboration', version: '0.1.0', ...(lifecycle ? { instance: lifecycle.instance, pid: process.pid } : {}) }));
  app.post('/api/service/stop', (request, reply) => {
    if (!lifecycle) throw new DomainError('UNAUTHENTICATED', 'A valid service stop token is required', 401);
    const input = z.object({ instance: z.string().uuid() }).strict().parse(request.body);
    if (input.instance !== lifecycle.instance) throw new DomainError('SERVICE_IDENTITY_MISMATCH', 'Service instance changed', 409);
    reply.raw.once('finish', () => { void lifecycle.stop(); });
    return { ok: true };
  });
  app.post('/api/owner/claim', request => {
    if (request.browserSession || request.actor.role !== 'human' || request.actor.principalId)
      throw new DomainError('ROLE_DENIED', 'Owner takeover requires the owner credential', 403);
    const { credentialHash } = z.object({ credentialHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    const result = claimOwner(store, request.actor, credentialHash, now());
    lifecycle?.ownerClaimed?.();
    return result;
  });
  app.post('/api/join', { bodyLimit: 1024 }, (request, reply) =>
    reply.code(201).send(joins.create(joinInput.parse(request.body))));
  app.post('/api/join/poll', request => {
    const endpoint = `http://${request.headers.host}`;
    const connect = { endpoint, mcp: { command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp'], env: ['AGILEDEV_ENDPOINT', 'AGILEDEV_TOKEN'] } };
    const result = joins.poll(pollInput.parse(request.body), (actor, workspace) => firstSteps(workflow, actor, workspace, connect));
    return result.state === 'APPROVED' ? { ...result, endpoint } : result;
  });
  app.post('/api/join/retire', request => {
    const actor = request.actor;
    if (actor.role === 'human' || actor.runId || actor.principalId || actor.joinedVia !== 'join_request' || !actor.workspaceIds[0])
      throw new DomainError('ROLE_DENIED', 'Only a joined agent can retire its own identity', 403);
    z.object({}).strict().parse(request.body);
    disableAgent(store, actor, actor.workspaceIds[0], actor.id, 'agent_retire', now());
    return { ok: true };
  });
  app.get('/api/session', request => ({ actor: request.actor,
    ...(workflow.consultRun(request.actor) ? { profile: 'consult' } : {}),
    ...(request.browserSession ? { csrf: sessions.csrf(request.browserSession) } : {}) }));
  app.get('/api/ui/status',request => {
    const ownerClaimed = isOwnerClaimed(store);
    const cookie = sessions.cookie(request.headers.cookie);
    if (cookie) { try { return { authenticated: true,ownerClaimed,actor: sessions.authenticate(cookie),csrf: sessions.csrf(cookie) }; } catch {} }
    return { authenticated: false, ownerClaimed };
  });
  app.post('/api/ui/pairing',request => {
    const actor = request.actor;
    if (actor.role !== 'human' || (request.browserSession ? actor.channel !== 'desktop' : !!actor.principalId))
      throw new DomainError('ROLE_DENIED', 'Pairing codes require the desktop session or the owner credential', 403);
    const kind = request.browserSession ? 'browser' : actor.channel === 'desktop' ? 'desktop' : 'owner_credential';
    return { ok: true, ...sessions.createPairing(actor, kind) };
  });
  app.post('/api/ui/login',(request,reply) => {
    const input = z.object({ code: z.string().min(1).max(100) }).strict().parse(request.body);
    const session = sessions.pair(input.code.trim());
    reply.header('set-cookie',`${browserCookie}=${session.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    return { ok: true,actor: session.actor,csrf: session.csrf,expiresAt: session.expiresAt };
  });
  app.post('/api/ui/logout',(request,reply) => {
    if (!request.browserSession) throw new DomainError('ROLE_DENIED','Logout requires the browser session',403);
    sessions.revoke(request.browserSession);
    reply.header('set-cookie',`${browserCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });
  app.post('/api/connection', request => {
    if (request.actor.role === 'human') throw new DomainError('HUMAN_CREDENTIAL_DENIED', 'MCP transport metadata requires an agent credential', 403);
    const client = z.object({ name: z.string().max(200), version: z.string().max(100) }).strict().parse(request.body);
    if (workflow.consultRun(request.actor)) return { ok: true };
    const connection = { id: request.actor.sessionId, actorId: request.actor.id, client, initializedAt: new Date(now()).toISOString(), verification: 'client_reported_metadata' };
    store.put('connection', connection, request.actor.workspaceIds[0]);
    if (request.actor.workspaceIds[0]) store.event(request.actor.workspaceIds[0],request.actor,'connection_initialized',connection.id,{ client });
    return { ok: true };
  });
  app.post<{ Params: { operation: string } }>('/api/command/:operation', async (request, reply) => {
    const { operation } = request.params;
    if (operation !== 'message_wait') return { ok: true, result: workflow.execute(request.actor, operation, request.body ?? {}) };
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    reply.raw.once('close', disconnect);
    try {
      const signal = AbortSignal.any([controller.signal, shutdown.signal]);
      return { ok: true, result: await workflow.execute(request.actor, operation, request.body ?? {}, signal) };
    } finally {
      reply.raw.off('close', disconnect);
    }
  });
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)),'../dist/web');
  if (existsSync(resolve(webRoot,'index.html'))) {
    app.register(fastifyStatic,{ root: webRoot,prefix: '/',index: false,cacheControl: false,dotfiles: 'deny',allowedPath: path => path === 'index.html' || path === '/index.html' || /^\/?assets\/[A-Za-z0-9_-]+\.(js|css|woff2)$/.test(path) });
    app.get('/',(_request,reply) => reply.sendFile('index.html'));
    app.get('/w/:workspaceId/issues/:issueId',(_request,reply) => reply.sendFile('index.html'));
  }
  app.get('/favicon.ico',(_request,reply) => reply.code(204).send());
  return app;
}
