import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { Actor, DomainError } from './contracts.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { WebSessions,browserCookie } from './web-session.js';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare module 'fastify' { interface FastifyRequest { actor: Actor; browserSession?: string } }
export function createServer(store: Store, lifecycle?: { instance: string; stop(): Promise<void> }) {
  const app = Fastify({ logger: false, bodyLimit: 262144, requestTimeout: 15000 });
  const workflow = new Workflow(store);
  const sessions = new WebSessions(store);
  app.addHook('onRequest', async (request,reply) => {
    reply.headers({ 'cache-control': 'no-store','referrer-policy': 'no-referrer','x-content-type-options': 'nosniff','x-frame-options': 'DENY','content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    const host = request.headers.host;
    if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new DomainError('HOST_DENIED', 'Only loopback hosts are accepted', 403);
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) throw new DomainError('ORIGIN_DENIED', 'Origin does not match the local service', 403);
    const path = request.url.split('?')[0]!;
    if (path === '/health' || (path === '/api/ui/status' && request.method === 'GET') || ((request.method === 'GET' || request.method === 'HEAD') && (path === '/' || path === '/favicon.ico' || path.startsWith('/assets/') || /^\/w\/[^/]+\/issues\/[^/]+$/.test(path)))) return;
    if (path === '/api/ui/login' && request.method === 'POST') {
      if (origin !== `http://${host}`) throw new DomainError('ORIGIN_DENIED','Pairing requires the local page Origin',403);
      return;
    }
    const bearer = request.headers.authorization;
    if (bearer?.startsWith('Bearer ')) { request.actor = store.authenticate(bearer.slice(7)); return; }
    const cookie = sessions.cookie(request.headers.cookie);
    if (!cookie) throw new DomainError('UNAUTHENTICATED','Pair the browser or supply a scoped API credential',401);
    request.actor = sessions.authenticate(cookie); request.browserSession = cookie;
    if (!['GET','HEAD'].includes(request.method)) {
      if (origin !== `http://${host}`) throw new DomainError('ORIGIN_DENIED','Browser changes require the local page Origin',403);
      sessions.checkCsrf(cookie,request.headers['x-csrf-token'] as string | undefined);
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message, details: error.details } });
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid request' } });
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    return reply.code(status >= 400 && status < 500 ? status : 500).send({ ok: false, error: { code: status === 400 ? 'INVALID_INPUT' : 'INTERNAL_ERROR', message: 'Request could not be completed' } });
  });
  app.get('/health', () => ({ name: 'agiledev-collaboration', version: '0.1.0', ...(lifecycle ? { instance: lifecycle.instance, pid: process.pid } : {}) }));
  app.post('/api/service/stop', (request, reply) => {
    if (!lifecycle || request.actor.role !== 'human' || request.browserSession) throw new DomainError('ROLE_DENIED', 'Service shutdown requires the local owner process', 403);
    const input = z.object({ instance: z.string().uuid() }).strict().parse(request.body);
    if (input.instance !== lifecycle.instance) throw new DomainError('SERVICE_IDENTITY_MISMATCH', 'Service instance changed', 409);
    reply.raw.once('finish', () => { void lifecycle.stop(); });
    return { ok: true };
  });
  app.get('/api/session', request => ({ actor: request.actor,...(request.browserSession ? { csrf: sessions.csrf(request.browserSession) } : {}) }));
  app.get('/api/ui/status',request => {
    const cookie = sessions.cookie(request.headers.cookie);
    if (cookie) { try { return { authenticated: true,actor: sessions.authenticate(cookie),csrf: sessions.csrf(cookie) }; } catch {} }
    return { authenticated: false };
  });
  app.post('/api/ui/pairing',request => {
    if (request.browserSession) throw new DomainError('ROLE_DENIED','Create pairing codes from the local owner CLI',403);
    return { ok: true,...sessions.createPairing(request.actor) };
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
    const connection = { id: request.actor.sessionId, actorId: request.actor.id, client, initializedAt: new Date().toISOString(), verification: 'client_reported_metadata' };
    store.put('connection', connection, request.actor.workspaceIds[0]);
    if (request.actor.workspaceIds[0]) store.event(request.actor.workspaceIds[0],request.actor,'connection_initialized',connection.id,{ client });
    return { ok: true };
  });
  app.post<{ Params: { operation: string } }>('/api/command/:operation', request => ({ ok: true, result: workflow.execute(request.actor, request.params.operation, request.body ?? {}) }));
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)),'../dist/web');
  if (existsSync(resolve(webRoot,'index.html'))) {
    app.register(fastifyStatic,{ root: webRoot,prefix: '/',index: false,cacheControl: false,dotfiles: 'deny',allowedPath: path => path === 'index.html' || path === '/index.html' || /^\/?assets\/[A-Za-z0-9_-]+\.(js|css|woff2)$/.test(path) });
    app.get('/',(_request,reply) => reply.sendFile('index.html'));
    app.get('/w/:workspaceId/issues/:issueId',(_request,reply) => reply.sendFile('index.html'));
  }
  app.get('/favicon.ico',(_request,reply) => reply.code(204).send());
  return app;
}
