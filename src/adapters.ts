import { execFile, spawn } from 'node:child_process';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Harness, DomainError, type RunModelSettings } from './contracts.js';
import { HarnessEntry, discoverHarnesses, harnessEnvironment } from './harness.js';
import { consultLauncherIdentity, matchesConsultVerification, type ConsultVerification } from './consult-verification.js';
import { terminateTree } from './execution.js';

export interface AdapterResult { outcome: 'succeeded' | 'failed' | 'cancelled' | 'uncertain'; errorCode?: string; summary?: string }
export interface AdapterContext {
  harness: Harness; cwd: string; directory: string; prompt: string; endpoint: string; token: string; bridgeScript: string;
  kind?: 'consult';
  checkBeforeSpawn?(): void;
  onModelSettings?(settings: RunModelSettings): void;
  onPid(pid: number): void; onProvider(id: string): void; onOutput(text: string): void;
}
export interface RunningSession { result: Promise<AdapterResult>; interrupt(): Promise<boolean> }
export interface ExecutionAdapter {
  start(context: AdapterContext): Promise<RunningSession>;
  supportsConsult?(harness: Harness): boolean;
}
const settingPattern = /^[A-Za-z0-9_@][A-Za-z0-9_.:/@+\[\]-]{0,159}$/;
interface DshRoute { provider: string; model: string; reasoningEffort?: string }

function ownerSetting(name: string) {
  const value = process.env[name];
  if (value !== undefined && !settingPattern.test(value)) throw new DomainError('INVALID_MODEL_SETTING', `${name} must be a model, provider or reasoning effort identifier`);
  return value;
}

export function declaredDshRoute(profile: string): DshRoute | null {
  const lines = profile.split(/\r?\n/); const start = lines.findIndex(line => line === '- id: agent-default-model');
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && line.startsWith('- id: ')); if (end < 0) end = lines.length;
  const section = lines.slice(start, end).join('\n');
  const scalar = (name: string) => {
    const raw = section.match(new RegExp(`^    ${name}: (.+)$`, 'm'))?.[1]?.trim();
    if (!raw) return null;
    try {
      const value = raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) : raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
      return typeof value === 'string' && settingPattern.test(value) ? value : null;
    } catch { return null; }
  };
  if (/^  disabled: true$/m.test(section)) return null;
  const provider = scalar('provider'); const model = scalar('model');
  const reasoningEffort = scalar('reasoningEffort');
  return provider && model ? { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } : null;
}
export function decodeNativeEvent(harness: Harness, event: any) {
  if (harness === 'codex') {
    if (event.type === 'thread.started') return { sessionId: event.thread_id as string };
    if (event.type === 'turn.completed') return { terminal: 'succeeded' as const };
    if (event.type === 'turn.failed') return { terminal: 'failed' as const, text: String(event.error?.message ?? 'Codex turn failed') };
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') return { text: String(event.item.text ?? '') };
  }
  if (harness === 'claude-code') {
    if (event.type === 'system' && event.subtype === 'init') return { sessionId: event.session_id as string, model: typeof event.model === 'string' && settingPattern.test(event.model) ? event.model : undefined };
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
    if (decoded.model && decoded.sessionId && decoded.model !== context.token) context.onModelSettings?.({ model: { value: decoded.model, source: 'harness' } });
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
function writeDshMcpPatch(c: AdapterContext, route?: DshRoute) {
  const patch = join(c.directory, 'dsh.patch.yml');
  const selection = route ? [
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(route.provider)}`,
    `    model: ${JSON.stringify(route.model)}`,
    ...(route.reasoningEffort ? [`    reasoningEffort: ${JSON.stringify(route.reasoningEffort)}`] : []),
    '',
  ].join('\n') : '';
  writeFileSync(patch, `${selection}- insert:\n    - id: agiledev-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: agiledev\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(c.bridgeScript)}, "mcp"]\n        env:\n          AGILEDEV_ENDPOINT: !!js process.env.AGILEDEV_ENDPOINT\n          AGILEDEV_TOKEN: !!js process.env.AGILEDEV_TOKEN\n`, { mode: 0o600 });
  return patch;
}
function ownerDshPatchArgs() {
  const path = process.env.AGILEDEV_DSH_PATCH;
  if (path === undefined) return [];
  if (isAbsolute(path)) {
    try {
      const resolved = realpathSync(path);
      if (statSync(resolved).isFile()) return ['--patch', resolved];
    } catch {}
  }
  throw new DomainError('INVALID_DSH_PATCH', 'AGILEDEV_DSH_PATCH must name an accessible absolute patch file');
}
async function dshLaunch(entry: HarnessEntry, c: AdapterContext, profile: 'sdk' | 'headless') {
  const provider = ownerSetting('AGILEDEV_DSH_PROVIDER');
  const model = ownerSetting('AGILEDEV_DSH_MODEL');
  const effort = ownerSetting('AGILEDEV_DSH_REASONING_EFFORT');
  const extras = ownerDshPatchArgs();
  if (!!provider !== !!model) throw new DomainError('PROVIDER_CONFIGURATION_REQUIRED', 'Set AGILEDEV_DSH_PROVIDER and AGILEDEV_DSH_MODEL together');
  const args = ['--profile', profile, ...extras];
  let route = provider && model ? { provider, model, reasoningEffort: effort } : null;
  if (!route && (profile === 'sdk' || effort || extras.length)) {
    const { stdout } = await promisify(execFile)(entry.command, [...entry.args, ...args, '--dump-config'], { cwd: c.cwd, env: harnessEnvironment(entry.env), windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const declared = declaredDshRoute(stdout);
    if (declared) route = { ...declared, reasoningEffort: effort ?? declared.reasoningEffort };
  }
  if (!route && (profile === 'sdk' || effort)) throw new DomainError('PROVIDER_CONFIGURATION_REQUIRED', 'The DSH profile has no readable static default route. Set AGILEDEV_DSH_PROVIDER and AGILEDEV_DSH_MODEL.');
  const override = provider || effort ? route ?? undefined : undefined;
  return { args: [...args, '--patch', writeDshMcpPatch(c, override)], route, source: profile === 'sdk' || override ? 'launch' as const : 'profile' as const };
}
async function dshSdk(entry: HarnessEntry, c: AdapterContext, args: string[], route: DshRoute): Promise<RunningSession> {
  const p = processSession(entry, args, c);
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
      await send('initialize', { cwd: c.cwd, ...route, approvalRequests: true, capabilities: { userQuestions: true } });
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
  private stale = new Set<Harness>();
  constructor(
    private entries: () => HarnessEntry[] = discoverHarnesses,
    private verification: ReadonlyMap<Harness, ConsultVerification> = new Map()
  ) {}
  private verifiedFresh(harness: Harness) {
    return this.stale.has(harness) ? undefined : this.verification.get(harness);
  }
  supportsConsult(harness: Harness) {
    const verified = this.verifiedFresh(harness);
    if (!verified) return false;
    const entry = this.entries().find(candidate => candidate.id === harness);
    return !!entry && consultLauncherIdentity(entry) === verified.launcher;
  }
  async start(c: AdapterContext): Promise<RunningSession> {
    const consult = c.kind === 'consult';
    const entry = this.entries().find(e => e.id === c.harness);
    if (!entry) throw new DomainError('HARNESS_UNAVAILABLE', 'Selected harness executable was not found');
    if (consult) {
      const verified = this.verifiedFresh(c.harness);
      if (!verified) {
        throw new DomainError('HARNESS_UNAVAILABLE', 'Native fresh consult support has not been verified for this launcher');
      }
      if (!await matchesConsultVerification(entry, verified)) {
        this.stale.add(c.harness);
        throw new DomainError('HARNESS_UNAVAILABLE', 'The verified native consult launcher or CLI version changed');
      }
      if (this.verifiedFresh(c.harness) !== verified) throw new DomainError('HARNESS_UNAVAILABLE', 'The native consult verification changed before launch');
      c.checkBeforeSpawn?.();
    }
    mkdirSync(c.directory, { recursive: true });
    let args: string[];
    if (c.harness === 'dsh') {
      const launch = await dshLaunch(entry, c, consult ? 'headless' : 'sdk');
      c.checkBeforeSpawn?.();
      if (launch.route) {
        const { provider, model, reasoningEffort } = launch.route;
        c.onModelSettings?.({
          provider: { value: provider, source: launch.source },
          model: { value: model, source: launch.source },
          ...(reasoningEffort ? { reasoningEffort: { value: reasoningEffort, source: launch.source } } : {}),
        });
        if (!consult) return dshSdk(entry, c, launch.args, launch.route);
      }
      args = [...launch.args, '--permission-mode', 'read-only', '--approval-policy', 'never', '--json', '-'];
    } else if (c.harness === 'codex') {
      args = ['exec', '--json', '--sandbox', consult ? 'read-only' : 'workspace-write', '--cd', c.cwd, '--skip-git-repo-check', '-c', `mcp_servers.agiledev.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.agiledev.args=${JSON.stringify([c.bridgeScript, 'mcp'])}`, '-c', 'mcp_servers.agiledev.env_vars=["AGILEDEV_TOKEN","AGILEDEV_ENDPOINT"]', '-c', 'mcp_servers.agiledev.required=true', '-c', 'mcp_servers.agiledev.default_tools_approval_mode="approve"'];
      const model = ownerSetting('AGILEDEV_CODEX_MODEL');
      const effort = ownerSetting('AGILEDEV_CODEX_REASONING_EFFORT');
      if (model) args.push('-c', `model=${JSON.stringify(model)}`);
      if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
      if (model || effort) c.onModelSettings?.({
        ...(model ? { model: { value: model, source: 'launch' } } : {}),
        ...(effort ? { reasoningEffort: { value: effort, source: 'launch' } } : {}),
      });
      if (consult) args.push('-c', 'approval_policy="never"');
      args.push('-');
    } else {
      const config = join(c.directory, 'mcp.json');
      writeFileSync(config, JSON.stringify({ mcpServers: { agiledev: { type: 'stdio', command: process.execPath, args: [c.bridgeScript, 'mcp'], env: { AGILEDEV_ENDPOINT: c.endpoint, AGILEDEV_TOKEN: '${AGILEDEV_TOKEN}' } } } }), { mode: 0o600 });
      args = ['--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', consult ? 'dontAsk' : 'acceptEdits', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', config, '--session-id', randomUUID(), '--allowedTools', 'mcp__agiledev__*'];
      const model = ownerSetting('AGILEDEV_CLAUDE_MODEL');
      if (model) {
        args.push('--model', model);
        c.onModelSettings?.({ model: { value: model, source: 'launch' } });
      }
      if (consult) args.push('--tools', '', '--disable-slash-commands');
    }
    const p = processSession(entry, args, c); p.child.stdin.end(c.prompt);
    return p;
  }
}
