import { DomainError } from './contracts.js';

function localEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new DomainError('ENDPOINT_DENIED', 'The bridge requires a loopback HTTP service', 400);
  return url.origin;
}

async function serviceResult(response: Response) {
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new DomainError(data.error?.code ?? 'SERVICE_ERROR', data.error?.message ?? 'Service request failed', response.status, data.error?.details, data.error?.remedy);
  return data;
}

export async function postPublic(endpoint: string, path: string, body: unknown) {
  return serviceResult(await fetch(`${localEndpoint(endpoint)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) }));
}

export class LocalClient {
  readonly endpoint: string;
  constructor(endpoint: string, private token: string) {
    this.endpoint = localEndpoint(endpoint);
  }
  async request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 15000): Promise<any> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.endpoint}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    return serviceResult(response);
  }
  async command(operation: string, input: unknown, signal?: AbortSignal) {
    const timeoutMs = operation === 'message_wait' ? 55000 : 15000;
    return (await this.request(`/api/command/${encodeURIComponent(operation)}`, input, signal, timeoutMs)).result;
  }
}
