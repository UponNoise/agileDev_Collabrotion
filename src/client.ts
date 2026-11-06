import { DomainError } from './contracts.js';

export class LocalClient {
  readonly endpoint: string;
  constructor(endpoint: string, private token: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new DomainError('ENDPOINT_DENIED', 'The bridge requires a loopback HTTP service', 400);
    this.endpoint = url.origin;
  }
  async request(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.endpoint}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const data = await response.json() as any;
    if (!response.ok || data.ok === false) throw new DomainError(data.error?.code ?? 'SERVICE_ERROR', data.error?.message ?? 'Service request failed', response.status, data.error?.details);
    return data;
  }
  async command(operation: string, input: unknown) { return (await this.request(`/api/command/${encodeURIComponent(operation)}`, input)).result; }
}
