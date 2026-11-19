import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Harness, DomainError } from './contracts.js';
import { HarnessEntry, discoverHarnesses } from './harness.js';
import { terminateTree } from './execution.js';

export interface AdapterResult { outcome: 'succeeded' | 'failed' | 'cancelled' | 'uncertain'; errorCode?: string; summary?: string }
export interface AdapterContext {
  harness: Harness; cwd: string; directory: string; prompt: string; endpoint: string; token: string; bridgeScript: string;
  kind?: 'consult';
  onPid(pid: number): void; onProvider(id: string): void; onOutput(text: string): void;
}
export interface RunningSession { result: Promise<AdapterResult>; interrupt(): Promise<boolean> }
export interface ExecutionAdapter {
  start(context: AdapterContext): Promise<RunningSession>;
  supportsConsult?(harness: Harness): boolean;
}
export function declaredDshRoute(profile: string): { provider: string; model: string } | null {
  const lines = profile.split(/\r?\n/); const start = lines.findIndex(line => line === '- id: agent-default-model');
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && line.startsWith('- id: ')); if (end < 0) end = lines.length;
  const section = lines.slice(start, end).join('\n');
  const scalar = (name: string) => {
    const raw = section.match(new RegExp(`^    ${name}: (.+)$`, 'm'))?.[1]?.trim();
    if (!raw) return null;
    const value = raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) : raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
    return typeof value === 'string' && /^[A-Za-z0-9_.:/@-]+$/.test(value) ? value : null;
  };
  if (/^  disabled: true$/m.test(section)) return null;
  const provider = scalar('provider'); const model = scalar('model');
  return provider && model ? { provider, model } : null;
}
export function decodeNativeEvent(harness: Harness, event: any) {
  if (harness === 'codex') {
    if (event.type === 'thread.started') return { sessionId: event.thread_id as string };
    if (event.type === 'turn.completed') return { terminal: 'succeeded' as const };
    if (event.type === 'turn.failed') return { terminal: 'failed' as const, text: String(event.error?.message ?? 'Codex turn failed') };
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') return { text: String(event.item.text ?? '') };
  }
  if (harness === 'claude-code') {
    if (event.type === 'system' && event.subtype === 'init') return { sessionId: event.session_id as string };
    if (event.type === 'result') return { sessionId: event.session_id as string, terminal: event.is_error || event.subtype !== 'success' ? 'failed' as const : 'succeeded' as const, text: String(event.result ?? event.errors?.join('\n') ?? '') };
  }
  if (harness === 'dsh') {
    if (event.type === 'session') return { sessionId: event.sessionId as string };
    if (event.type === 'final') return {
      sessionId: event.sessionId as string, terminal: event.reason?.kind === 'completed' ? 'succeeded' as const : 'failed' as const,
      text: typeof event.text === 'string' ? event.text : ''
    };
    if (event.method === 'session.event') {
      const item = event.params?.event;
      if (item?.type === 'turn/end') return { terminal: item.data?.reason?.kind === 'completed' ? 'succeeded' as const : 'failed' as const };
      if (item?.type === 'assistant/message' && Array.isArray(item.data?.message?.content)) return { text: item.data.message.content.filter((block: any) => block.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('') as string };
    }
  }
  return {};
}
function processSession(entry: HarnessEntry, args: string[], context: AdapterContext) {
  const env = { ...harnessEnvironment(entry.env), AGILEDEV_ENDPOINT: context.endpoint, AGILEDEV_TOKEN: context.token };
  const child = spawn(entry.command, [...entry.args, ...args], { cwd: context.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  child.once('spawn', () => { if (child.pid) context.onPid(child.pid); });
  child.stdin.on('error', () => {});
  const redact = (text: string) => text.replaceAll(context.token, '[redacted]').replaceAll(encodeURIComponent(context.token), '[redacted]');
  child.stderr.on('data', data => context.onOutput(redact(String(data)).slice(0,4000)));
  let interrupted = false; let treeStopped = false; let terminal: 'succeeded' | 'failed' | undefined;
  let failureOnStop: string | undefined;
  let termination: Promise<boolean> | undefined;
  let sessionId: string | undefined; let summary = ''; let malformed = false;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let listener: ((event: any) => void) | undefined;
  lines.on('line', line => {
    if (line.length > 1024 * 1024) { malformed = true; return; }
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    const decoded = decodeNativeEvent(entry.id, event);
    if (decoded.sessionId && typeof decoded.sessionId === 'string') {
      if (context.kind === 'consult' && sessionId && sessionId !== decoded.sessionId) { malformed = true; return; }
      sessionId = decoded.sessionId;
      context.onProvider(sessionId);
    }
    if (decoded.terminal) terminal = decoded.terminal;
    if (decoded.text) { summary = redact(decoded.text).slice(-16000); context.onOutput(summary); }
    listener?.(event);
  });
  let settle!: (result: AdapterResult) => void;
  let settled = false;
  const result = new Promise<AdapterResult>(done => { settle = value => { if (!settled) { settled = true; done(value); } }; });
  child.once('error', () => settle({ outcome: 'failed', errorCode: 'LAUNCH_FAILED' }));
  child.once('close', async code => {
    lines.close();
    if (termination) treeStopped = await termination;
    if (interrupted) settle({ outcome: treeStopped ? failureOnStop ? 'failed' : 'cancelled' : 'uncertain', errorCode: treeStopped ? failureOnStop ?? 'INTERRUPTED' : 'STOP_UNCONFIRMED', summary });
    else settle({ outcome: code === 0 && terminal === 'succeeded' && sessionId && !malformed ? 'succeeded' : 'failed', errorCode: code === 0 && terminal === 'succeeded' && sessionId && !malformed ? undefined : 'PROVIDER_FAILED', summary });
  });
  const interrupt = async (failureCode?: string) => {
    if (settled) return true;
    interrupted = true;
    failureOnStop = failureCode;
    termination = child.pid ? terminateTree(child.pid) : Promise.resolve(false);
    treeStopped = await termination;
    if (!treeStopped) settle({ outcome: 'uncertain', errorCode: 'STOP_UNCONFIRMED', summary });
    return treeStopped;
  };
  return { child, result, interrupt, setListener: (fn: (event: any) => void) => { listener = fn; }, complete: settle, setSession: (id: string) => { sessionId = id; context.onProvider(id); }, setTerminal: (state: 'succeeded' | 'failed') => { terminal = state; } };
}
function harnessEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({ ...process.env,...extra }).filter(([key]) => key.toUpperCase() !== 'AGILEDEV_GITHUB_TOKEN'));
}
function writeDshMcpPatch(c: AdapterContext) {
  const patch = join(c.directory, 'dsh.patch.yml');
  writeFileSync(patch, `- insert:\n    - id: agiledev-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: agiledev\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(c.bridgeScript)}, "mcp"]\n        env:\n          AGILEDEV_ENDPOINT: !!js process.env.AGILEDEV_ENDPOINT\n          AGILEDEV_TOKEN: !!js process.env.AGILEDEV_TOKEN\n`, { mode: 0o600 });
  return patch;
}
async function dshSdk(entry: HarnessEntry, c: AdapterContext): Promise<RunningSession> {
  let provider = process.env.AGILEDEV_DSH_PROVIDER; let model = process.env.AGILEDEV_DSH_MODEL;
  if (!provider && !model) {
    const { stdout } = await promisify(execFile)(entry.command, [...entry.args, '--profile', 'sdk', '--dump-config'], { cwd: c.cwd, env: harnessEnvironment(entry.env), windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const declared = declaredDshRoute(stdout); provider = declared?.provider; model = declared?.model;
  }
  if (!provider || !model) throw new DomainError('PROVIDER_CONFIGURATION_REQUIRED', 'SDK profile has no readable static default route. Set both AGILEDEV_DSH_PROVIDER and AGILEDEV_DSH_MODEL; no substitute route is selected.');
  const patch = writeDshMcpPatch(c);
  const p = processSession(entry, ['--profile', 'sdk', '--patch', patch], c);
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let sequence = 0;
  const send = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('DSH request timed out; execution must be reconciled')); }, method === 'session/wait' ? 3600000 : 30000);
    pending.set(id, { resolve, reject, timer }); p.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  p.setListener(event => {
    if (event.method && event.id !== undefined) {
      const response = event.method === 'approval/request' ? { outcome: 'rejected' } : { cancelled: true };
      p.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: event.id, result: response })}\n`);
    }
    const req = pending.get(event.id);
    if (req) { clearTimeout(req.timer); pending.delete(event.id); if (event.error) req.reject(new Error('DSH rejected the runtime request')); else req.resolve(event.result); }
  });
  const sessionId = randomUUID();
  void (async () => {
    try {
      await send('initialize', { cwd: c.cwd, provider, model, approvalRequests: true, capabilities: { userQuestions: true } });
      await send('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: c.prompt }] });
      p.setSession(sessionId);
      await send('session/wait', { sessionId });
      await send('shutdown', {});
      p.child.stdin.end();
    } catch {
      await p.interrupt('DSH_SESSION_FAILED');
    }
  })();
  void p.result.then(() => { for (const req of pending.values()) { clearTimeout(req.timer); req.reject(new Error('DSH session ended')); } pending.clear(); });
  return p;
}
export class NativeAdapter implements ExecutionAdapter {
  constructor(
    private entries: () => HarnessEntry[] = discoverHarnesses,
    private verifiedFresh: ReadonlySet<Harness> = new Set()
  ) {}
  supportsConsult(harness: Harness) {
    return this.verifiedFresh.has(harness) && this.entries().some(entry => entry.id === harness);
  }
  async start(c: AdapterContext): Promise<RunningSession> {
    const consult = c.kind === 'consult';
    if (consult && !this.verifiedFresh.has(c.harness)) throw new DomainError('HARNESS_UNAVAILABLE', 'Native fresh consult support has not been verified');
    const entry = this.entries().find(e => e.id === c.harness);
    if (!entry) throw new DomainError('HARNESS_UNAVAILABLE', 'Selected harness executable was not found');
    mkdirSync(c.directory, { recursive: true });
    if (c.harness === 'dsh' && !consult) return dshSdk(entry, c);
    let args: string[];
    if (c.harness === 'dsh') {
      args = ['--profile', 'headless', '--patch', writeDshMcpPatch(c), '--permission-mode', 'read-only', '--approval-policy', 'never', '--json', '-'];
    } else if (c.harness === 'codex') {
      args = ['exec', '--json', '--sandbox', consult ? 'read-only' : 'workspace-write', '--cd', c.cwd, '--skip-git-repo-check', '-c', `mcp_servers.agiledev.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.agiledev.args=${JSON.stringify([c.bridgeScript, 'mcp'])}`, '-c', 'mcp_servers.agiledev.env_vars=["AGILEDEV_TOKEN","AGILEDEV_ENDPOINT"]', '-c', 'mcp_servers.agiledev.required=true', '-c', 'mcp_servers.agiledev.default_tools_approval_mode="approve"'];
      if (consult) args.push('-c', 'approval_policy="never"');
      args.push('-');
    } else {
      const config = join(c.directory, 'mcp.json');
      writeFileSync(config, JSON.stringify({ mcpServers: { agiledev: { type: 'stdio', command: process.execPath, args: [c.bridgeScript, 'mcp'], env: { AGILEDEV_ENDPOINT: c.endpoint, AGILEDEV_TOKEN: '${AGILEDEV_TOKEN}' } } } }), { mode: 0o600 });
      args = ['--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', consult ? 'dontAsk' : 'acceptEdits', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', config, '--session-id', randomUUID(), '--allowedTools', 'mcp__agiledev__*'];
      if (consult) args.push('--tools', '', '--disable-slash-commands');
    }
    const p = processSession(entry, args, c); p.child.stdin.end(c.prompt);
    return p;
  }
}
