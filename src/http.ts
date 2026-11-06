import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { Actor, DomainError } from './contracts.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';

declare module 'fastify' { interface FastifyRequest { actor: Actor } }
export function createServer(store: Store) {
  const app = Fastify({ logger: false, bodyLimit: 262144, requestTimeout: 15000 });
  const workflow = new Workflow(store);
  app.addHook('onRequest', async request => {
    const host = request.headers.host;
    if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new DomainError('HOST_DENIED', 'Only loopback hosts are accepted', 403);
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) throw new DomainError('ORIGIN_DENIED', 'Origin does not match the local service', 403);
    if (request.url === '/health') return;
    const bearer = request.headers.authorization;
    if (!bearer?.startsWith('Bearer ')) throw new DomainError('UNAUTHENTICATED', 'Bearer credential required', 401);
    request.actor = store.authenticate(bearer.slice(7));
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message, details: error.details } });
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid request' } });
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    return reply.code(status >= 400 && status < 500 ? status : 500).send({ ok: false, error: { code: status === 400 ? 'INVALID_INPUT' : 'INTERNAL_ERROR', message: 'Request could not be completed' } });
  });
  app.get('/health', () => ({ name: 'agiledev-collaboration', version: '0.1.0' }));
  app.get('/api/session', request => ({ actor: request.actor }));
  app.post('/api/connection', request => {
    if (request.actor.role === 'human') throw new DomainError('HUMAN_CREDENTIAL_DENIED', 'MCP transport metadata requires an agent credential', 403);
    const client = z.object({ name: z.string().max(200), version: z.string().max(100) }).strict().parse(request.body);
    const connection = { id: request.actor.sessionId, actorId: request.actor.id, client, initializedAt: new Date().toISOString(), verification: 'client_reported_metadata' };
    store.put('connection', connection, request.actor.workspaceIds[0]);
    return { ok: true };
  });
  app.post<{ Params: { operation: string } }>('/api/command/:operation', request => ({ ok: true, result: workflow.execute(request.actor, request.params.operation, request.body ?? {}) }));
  return app;
}
