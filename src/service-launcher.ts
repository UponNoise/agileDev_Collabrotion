import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface ServiceDescriptor { endpoint: string; ownerToken: string; pid: number; instance: string }
export interface LaunchOptions { dataDir: string; node: string; script: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
export class ServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function dataDirectory(env = process.env) {
  return resolve(env.AGILEDEV_DATA_DIR ?? join(env.LOCALAPPDATA ?? join(homedir(), '.local/share'), 'AgileDev'));
}
export function processExists(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new ServiceError('INVALID_SERVICE_METADATA', 'Invalid service process identity.');
  try { process.kill(pid, 0); return true; }
  catch (error: any) { if (error.code === 'ESRCH') return false; throw new ServiceError('SERVICE_PROCESS_UNCERTAIN', 'The recorded service process cannot be verified.'); }
}
export function readDescriptor(directory: string): ServiceDescriptor | null {
  const path = join(directory, 'daemon.json');
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const endpoint = new URL(value.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !/^[0-9a-f-]{36}$/i.test(value.instance) || !/^[A-Za-z0-9_-]{43}$/.test(value.ownerToken)) throw new Error();
    return { endpoint: endpoint.origin, ownerToken: value.ownerToken, pid: value.pid, instance: value.instance };
  } catch { throw new ServiceError('INVALID_SERVICE_METADATA', 'The local service descriptor needs inspection; it was not replaced.'); }
}
function readLock(directory: string): { pid: number; instance: string } | null {
  const path = join(directory, 'daemon.lock');
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.instance !== 'string') throw new Error();
    return value;
  } catch { throw new ServiceError('INVALID_SERVICE_LOCK', 'The service lock needs inspection; no replacement was started.'); }
}
export async function serviceAvailable(descriptor: ServiceDescriptor, directory: string) {
  if (!processExists(descriptor.pid)) return false;
  const lock = readLock(directory);
  if (!lock || lock.pid !== descriptor.pid || lock.instance !== descriptor.instance) return false;
  let response: Response;
  try { response = await fetch(`${descriptor.endpoint}/health`, { redirect: 'error', signal: AbortSignal.timeout(1000) }); }
  catch { return false; }
  let health: any;
  try { health = await response.json(); }
  catch { throw new ServiceError('SERVICE_IDENTITY_MISMATCH', 'The endpoint did not return a valid service identity.'); }
  if (!response.ok || health.name !== 'agiledev-collaboration' || health.instance !== descriptor.instance || health.pid !== descriptor.pid) throw new ServiceError('SERVICE_IDENTITY_MISMATCH', 'The endpoint does not match the recorded service instance.');
  if (health.version !== '0.1.0') throw new ServiceError('SERVICE_VERSION_MISMATCH', 'Stop the existing service before switching application versions.');
  return true;
}
export async function requireService(directory: string): Promise<ServiceDescriptor> {
  const descriptor = readDescriptor(directory);
  if (descriptor && await serviceAvailable(descriptor, directory)) return descriptor;
  const lock = readLock(directory);
  if ((lock && processExists(lock.pid)) || (descriptor && processExists(descriptor.pid))) throw new ServiceError('SERVICE_UNAVAILABLE', 'The recorded service process is unavailable. Inspect its lock, port, and runtime before an explicit owner restart.');
  throw new ServiceError('SERVICE_OWNER_START_REQUIRED', 'Open the AgileDev desktop app or run "agiledev service-start" with the same AGILEDEV_DATA_DIR, then reconnect. Agent connections do not start or restart the shared service.');
}
export async function ensureService(options: LaunchOptions): Promise<ServiceDescriptor> {
  const deadline = Date.now() + (options.timeoutMs ?? 20000);
  let launched = false;
  let spawnFailed = false;
  do {
    const descriptor = readDescriptor(options.dataDir);
    if (descriptor && await serviceAvailable(descriptor, options.dataDir)) return descriptor;
    const lock = readLock(options.dataDir);
    const live = (lock && processExists(lock.pid)) || (descriptor && processExists(descriptor.pid));
    if (!live && !launched) {
      const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), AGILEDEV_DATA_DIR: options.dataDir };
      for (const key of ['AGILEDEV_TOKEN', 'AGILEDEV_ENDPOINT', 'ELECTRON_RUN_AS_NODE']) delete env[key];
      const child = spawn(options.node, [options.script, 'serve'], { env, detached: true, windowsHide: true, stdio: 'ignore' });
      child.once('error', () => { spawnFailed = true; });
      child.unref(); launched = true;
    }
    if (spawnFailed) throw new ServiceError('SERVICE_START_FAILED', 'The service runtime could not be started.');
    await delay(100);
  } while (Date.now() < deadline);
  throw new ServiceError('SERVICE_UNAVAILABLE', 'The service did not become available. Inspect its lock, port, and runtime before retrying.');
}
export async function stopService(directory: string, timeoutMs = 25000) {
  const descriptor = readDescriptor(directory);
  if (!descriptor || !processExists(descriptor.pid)) return false;
  if (!await serviceAvailable(descriptor, directory)) throw new ServiceError('SERVICE_UNAVAILABLE', 'The recorded service cannot be stopped through its verified endpoint.');
  const response = await fetch(`${descriptor.endpoint}/api/service/stop`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${descriptor.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ instance: descriptor.instance }) });
  if (!response.ok) throw new ServiceError('SERVICE_STOP_DENIED', 'The service rejected the stop request.');
  const deadline = Date.now() + timeoutMs;
  while (processExists(descriptor.pid) && Date.now() < deadline) await delay(100);
  if (processExists(descriptor.pid)) throw new ServiceError('SERVICE_STOP_UNCERTAIN', 'Shutdown has not been confirmed; no process was force-killed.');
  return true;
}
