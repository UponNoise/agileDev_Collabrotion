import { spawn } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Harness, DomainError, type RunModelSettings, type RunModelValue } from './contracts.js';
import { HarnessEntry, discoverHarnesses, harnessEnvironment } from './harness.js';
import { consultLauncherIdentity, matchesConsultVerification, type ConsultVerification } from './consult-verification.js';
import { dispatchOpen, matchesDispatchVerification, type DispatchVerification } from './dispatch-verification.js';
import { terminateTree } from './execution.js';
import { checkDshRunDirectory, type RunDirectoryCheck } from './run-directory.js';
import { collectDshMcpRows } from './mcp-isolation.js';

export interface AdapterResult { outcome: 'succeeded' | 'failed' | 'cancelled' | 'uncertain'; errorCode?: string; summary?: string }
export interface AdapterContext {
  harness: Harness; cwd: string; directory: string; prompt: string; endpoint: string; token: string; bridgeScript: string;
  kind?: 'qa' | 'consult';
  checkBeforeSpawn?(): void;
  onModelSettings?(settings: RunModelSettings): void;
  onPid(pid: number): void; onProvider(id: string): void; onOutput(text: string): void;
}
export interface RunningSession { result: Promise<AdapterResult>; interrupt(): Promise<boolean> }
export interface ExecutionAdapter {
  start(context: AdapterContext): Promise<RunningSession>;
  supportsConsult?(harness: Harness): boolean;
  supportsDispatch?(harness: Harness): boolean;
}
const settingPattern = /^[A-Za-z0-9_@][A-Za-z0-9_.:/@+\[\]-]{0,159}$/;
interface DshRoute { provider: string; model: string; reasoningEffort?: string }

function ownerSetting(name: string) {
  const value = process.env[name];
  if (value !== undefined && !settingPattern.test(value)) throw new DomainError('INVALID_MODEL_SETTING', `${name} must be a model, provider or reasoning effort identifier`);
  return value;
}

function cachedCodexSol(entry: HarnessEntry) {
  const home = entry.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try {
    const cache = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'));
    if (!Array.isArray(cache?.models)) return undefined;
    const models: ({ slug?: unknown; visibility?: unknown } | null)[] = cache.models;
    return models.flatMap(record => {
      const slug = record?.slug;
      const visibility = record?.visibility;
      return typeof slug === 'string' && slug.endsWith('-sol') && settingPattern.test(slug) &&
        (visibility === undefined || visibility === 'list') ? [slug] : [];
    }).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
  } catch { return undefined; }
}

function selectedSetting(override?: string, fallback?: string, source: 'managed-default' | 'codex-cache' = 'managed-default'): RunModelValue {
  return {
    value: override ?? fallback ?? null,
    source: override !== undefined ? 'launch' : fallback !== undefined ? source : 'harness-default',
  };
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
  if (harness === 'agy') {
    if (event.event === 'init') {
      return {
        sessionId: typeof event.conversation_id === 'string' ? event.conversation_id : undefined,
        model: typeof event.init?.model === 'string' && settingPattern.test(event.init.model) ? event.init.model : undefined,
      };
    }
    if (event.event === 'result') {
      const response = typeof event.result?.response === 'string' ? event.result.response : '';
      const error = typeof event.result?.error === 'string' ? event.result.error : '';
      return {
        sessionId: typeof event.result?.conversation_id === 'string' ? event.result.conversation_id : undefined,
        terminal: event.result?.status === 'SUCCESS' ? 'succeeded' as const : 'failed' as const,
        text: response || error || '',
      };
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
function writeDshMcpPatch(c: AdapterContext, route: DshRoute, clientRowIds: string[]) {
  const patch = join(c.directory, 'dsh.patch.yml');
  const selection = [
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(route.provider)}`,
    `    model: ${JSON.stringify(route.model)}`,
    ...(route.reasoningEffort ? [`    reasoningEffort: ${JSON.stringify(route.reasoningEffort)}`] : []),
    '',
  ].join('\n');
  const disabled = clientRowIds.map(id => `- id: ${JSON.stringify(id)}\n  disabled: true\n`).join('');
  writeFileSync(patch, `${selection}${disabled}- insert:\n    - id: agiledev-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: agiledev\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(c.bridgeScript)}, "mcp"]\n        env:\n          AGILEDEV_ENDPOINT: !!js process.env.AGILEDEV_ENDPOINT\n          AGILEDEV_TOKEN: !!js process.env.AGILEDEV_TOKEN\n`, { mode: 0o600 });
  return patch;
}
export function ownerDshPatchArgs() {
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
function dshSettings(c: AdapterContext) {
  const ownerProvider = ownerSetting('AGILEDEV_DSH_PROVIDER');
  const ownerModel = ownerSetting('AGILEDEV_DSH_MODEL');
  const ownerEffort = ownerSetting('AGILEDEV_DSH_REASONING_EFFORT');
  const extras = ownerDshPatchArgs();
  if (!!ownerProvider !== !!ownerModel) throw new DomainError('PROVIDER_CONFIGURATION_REQUIRED', 'Set AGILEDEV_DSH_PROVIDER and AGILEDEV_DSH_MODEL together');
  const provider = ownerProvider ?? 'deepseek-official';
  const model = ownerModel ?? 'deepseek-flash';
  const gemini = provider === 'google' && model === 'gemini-4-hydrogen';
  const deepseek = provider === 'deepseek-official' && model === 'deepseek-flash';
  if (gemini && !extras.length) throw new DomainError('DSH_PATCH_REQUIRED', 'Set AGILEDEV_DSH_PATCH to the Google provider overlay for Gemini Hydrogen');
  const effort = selectedSetting(ownerEffort, gemini ? 'high' : deepseek ? 'max' : undefined);
  const allowedEfforts = gemini ? ['low', 'medium', 'high'] : deepseek ? ['off', 'low', 'high', 'max'] : undefined;
  if (allowedEfforts && effort.value && !allowedEfforts.includes(effort.value)) {
    throw new DomainError('INVALID_MODEL_SETTING', `AGILEDEV_DSH_REASONING_EFFORT for the selected model must be one of ${allowedEfforts.join(', ')}`);
  }
  const route = { provider, model, reasoningEffort: effort.value ?? undefined };
  c.onModelSettings?.({ provider: selectedSetting(ownerProvider, provider), model: selectedSetting(ownerModel, model), reasoningEffort: effort });
  return { extras, route };
}
function dshPatchArgs(c: AdapterContext, profile: 'sdk' | 'headless', { extras, route }: ReturnType<typeof dshSettings>, clientRowIds: string[]) {
  return ['--profile', profile, ...extras, '--patch', writeDshMcpPatch(c, route, clientRowIds)];
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
function agySettings(c: AdapterContext) {
  const consult = c.kind === 'consult';
  const envName = consult ? 'AGILEDEV_AGY_CONSULT_MODEL' : c.kind === 'qa' ? 'AGILEDEV_AGY_QA_MODEL' : 'AGILEDEV_AGY_WORKER_MODEL';
  const fallback = consult || c.kind === 'qa' ? 'gemini-4-neon-high' : 'gemini-4-hydrogen-high';
  const override = ownerSetting(envName);
  const model = selectedSetting(override, fallback);
  const slug = model.value!;
  const effort = slug.match(/-(low|medium|high|xhigh|max)$/);
  const reasoningEffort: RunModelValue = effort ? { value: effort[1]!, source: model.source } : { value: null, source: 'harness-default' };
  return { slug, model, reasoningEffort };
}
export class NativeAdapter implements ExecutionAdapter {
  private stale = new Set<Harness>();
  private dispatchStale = new Set<Harness>();
  private readonly runDirectoryCheck: (directory: string) => Promise<RunDirectoryCheck>;
  private readonly dispatchVerification: ReadonlyMap<Harness, DispatchVerification>;
  private readonly agyExtraMcpServers?: Record<string, { command: string; args: string[] }>;
  constructor(
    private entries: () => HarnessEntry[] = discoverHarnesses,
    private verification: ReadonlyMap<Harness, ConsultVerification> = new Map(),
    options: {
      runDirectoryCheck?: (directory: string) => Promise<RunDirectoryCheck>;
      dispatchVerification?: ReadonlyMap<Harness, DispatchVerification>;
      agyExtraMcpServers?: Record<string, { command: string; args: string[] }>;
    } = {},
  ) {
    this.runDirectoryCheck = options.runDirectoryCheck ?? checkDshRunDirectory;
    this.dispatchVerification = options.dispatchVerification ?? new Map();
    this.agyExtraMcpServers = options.agyExtraMcpServers;
  }
  private verifiedFresh(harness: Harness) {
    return this.stale.has(harness) ? undefined : this.verification.get(harness);
  }
  supportsConsult(harness: Harness) {
    const verified = this.verifiedFresh(harness);
    if (!verified) return false;
    const entry = this.entries().find(candidate => candidate.id === harness);
    return !!entry && consultLauncherIdentity(entry) === verified.launcher;
  }
  supportsDispatch(harness: Harness) {
    if (harness !== 'agy') return true;
    if (this.dispatchStale.has(harness)) return false;
    const verified = this.dispatchVerification.get(harness);
    if (!verified || !dispatchOpen(verified)) return false;
    const entry = this.entries().find(candidate => candidate.id === harness);
    return !!entry && consultLauncherIdentity(entry) === verified.launcher;
  }
  async start(c: AdapterContext): Promise<RunningSession> {
    const consult = c.kind === 'consult';
    const entry = this.entries().find(e => e.id === c.harness);
    if (!entry) throw new DomainError('HARNESS_UNAVAILABLE', 'Selected harness executable was not found');
    if (c.harness === 'agy') {
      const verified = this.dispatchStale.has('agy') ? undefined : this.dispatchVerification.get('agy');
      if (!verified || !dispatchOpen(verified)) {
        throw new DomainError('HARNESS_NOT_VERIFIED', 'Antigravity has not been verified on this computer; the owner runs verify-agy first');
      }
      if (!await matchesDispatchVerification(entry, verified)) {
        this.dispatchStale.add('agy');
        throw new DomainError('HARNESS_NOT_VERIFIED', 'Antigravity has not been verified on this computer; the owner runs verify-agy first');
      }
      if (this.dispatchStale.has('agy') || this.dispatchVerification.get('agy') !== verified) {
        throw new DomainError('HARNESS_NOT_VERIFIED', 'Antigravity has not been verified on this computer; the owner runs verify-agy first');
      }
    }
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
    if (c.harness === 'agy') {
      const settings = agySettings(c);
      const workspaceMcp = join(c.cwd, '.agents', 'mcp_config.json');
      let workspaceMcpPresent = false;
      try {
        workspaceMcpPresent = !!lstatSync(workspaceMcp, { throwIfNoEntry: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') workspaceMcpPresent = true;
      }
      if (workspaceMcpPresent) {
        throw new DomainError('MCP_ISOLATION_UNAVAILABLE', 'Could not keep other MCP servers out of this Antigravity run (workspace MCP config present). The run was not started.');
      }
      mkdirSync(c.directory, { recursive: true });
      const home = resolve(c.directory, 'agy-home');
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(join(home, '.gemini', 'config'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
        mcpServers: {
          agiledev: { command: process.execPath, args: [c.bridgeScript, 'mcp'] },
          ...(this.agyExtraMcpServers ?? {}),
        },
      }), { mode: 0o600 });
      const normalizedHome = home.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '');
      const allow = ['mcp(agiledev/*)', `read_file(${normalizedHome}/.gemini/antigravity-cli/mcp)`];
      const settingsPath = join(c.directory, 'agy-settings.json');
      writeFileSync(settingsPath, JSON.stringify(consult ? {
        agentMode: '',
        toolPermission: 'request-review',
        allowNonWorkspaceAccess: false,
        trustedWorkspaces: [c.cwd],
        permissions: { allow, deny: ['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)'] },
      } : {
        toolPermission: 'proceed-in-sandbox',
        allowNonWorkspaceAccess: false,
        trustedWorkspaces: [c.cwd],
        permissions: { allow, deny: [] },
      }), { mode: 0o600 });
      c.onModelSettings?.({ model: settings.model, reasoningEffort: settings.reasoningEffort });
      const agyArgs = [
        '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--model', settings.slug, '--settings', settingsPath, '--disable-slash-commands',
        ...(consult ? [] : ['--mode', 'accept-edits', '--sandbox']),
      ];
      const agyEntry: HarnessEntry = { ...entry, env: { ...entry.env, USERPROFILE: home, HOME: home } };
      const p = processSession(agyEntry, agyArgs, c);
      const stepsPath = join(c.directory, 'agy-steps.jsonl');
      const redact = (text: string) => text.replaceAll(c.token, '[redacted]').replaceAll(encodeURIComponent(c.token), '[redacted]');
      let stepBytes = 0;
      let stepsCapped = false;
      p.setListener(event => {
        if (event.event !== 'step_update') return;
        const step = event.step_update && typeof event.step_update === 'object' ? event.step_update : event;
        if (step.step_type !== 'tool' || step.state !== 'DONE') return;
        const tool = typeof step.tool_name === 'string' ? step.tool_name : '';
        const rawParams = step.tool_info?.parameters !== undefined ? JSON.stringify(step.tool_info.parameters) : '';
        const parameters = redact(rawParams).slice(0, 500);
        const error = typeof step.tool_info?.error?.type === 'string' ? step.tool_info.error.type : null;
        const line = `${redact(JSON.stringify({ tool, parameters, error }))}\n`;
        const bytes = Buffer.byteLength(line);
        if (stepsCapped || stepBytes + bytes > 1024 * 1024) { stepsCapped = true; return; }
        stepBytes += bytes;
        appendFileSync(stepsPath, line, { mode: 0o600 });
      });
      p.child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: c.prompt } })}\n`);
      const result = p.result.then(outcome => {
        if (outcome.outcome !== 'uncertain') {
          const mcpDir = join(home, '.gemini', 'antigravity-cli', 'mcp');
          let servers: string[] = [];
          try {
            servers = readdirSync(mcpDir, { withFileTypes: true })
              .filter(dirent => dirent.isDirectory())
              .map(dirent => dirent.name)
              .sort();
          } catch {}
          writeFileSync(join(c.directory, 'agy-loaded-servers.json'), JSON.stringify({ servers }), { mode: 0o600 });
          try { rmSync(home, { recursive: true, force: true }); } catch {}
        }
        return outcome;
      });
      return { result, interrupt: p.interrupt };
    }
    mkdirSync(c.directory, { recursive: true });
    let args: string[];
    if (c.harness === 'dsh') {
      const settings = dshSettings(c);
      if (!consult) {
        const check = await this.runDirectoryCheck(c.cwd);
        if (check.state === 'MISSING') {
          const { missing } = check;
          const runDirectory = dirname(c.directory);
          const message = `DSH cannot confine commands in this run directory because this Windows account lacks ${missing.join(' and ')} there. Give the account Full control of the run directory (${runDirectory}), or keep the AgileDev data directory inside your user folder.`;
          throw new DomainError('DSH_DIRECTORY_RIGHTS_REQUIRED', message, 409, { directory: c.cwd, missing });
        }
      }
      const profile = consult ? 'headless' : 'sdk';
      const isolation = await collectDshMcpRows(entry, profile, settings.extras, c.cwd);
      if ('reason' in isolation) {
        const message = `Could not keep your other MCP servers out of this DSH run (${isolation.reason}). The run was not started.`;
        throw new DomainError('MCP_ISOLATION_UNAVAILABLE', message);
      }
      if (consult) c.checkBeforeSpawn?.();
      const patchArgs = dshPatchArgs(c, profile, settings, isolation.clientRowIds);
      if (!consult) return dshSdk(entry, c, patchArgs, settings.route);
      args = [...patchArgs, '--permission-mode', 'read-only', '--approval-policy', 'never', '--json', '-'];
    } else if (c.harness === 'codex') {
      const windowsSandbox = process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : [];
      args = ['exec', '--json', '--ignore-user-config', ...windowsSandbox, '--sandbox', consult ? 'read-only' : 'workspace-write', '--cd', c.cwd, '--skip-git-repo-check', '-c', `mcp_servers.agiledev.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.agiledev.args=${JSON.stringify([c.bridgeScript, 'mcp'])}`, '-c', 'mcp_servers.agiledev.env_vars=["AGILEDEV_TOKEN","AGILEDEV_ENDPOINT"]', '-c', 'mcp_servers.agiledev.required=true', '-c', 'mcp_servers.agiledev.default_tools_approval_mode="approve"'];
      const override = ownerSetting('AGILEDEV_CODEX_MODEL');
      const model = selectedSetting(override, override ? undefined : cachedCodexSol(entry), 'codex-cache');
      const effort = selectedSetting(ownerSetting('AGILEDEV_CODEX_REASONING_EFFORT'), model.value ? 'high' : undefined);
      if (model.value) args.push('-c', `model=${JSON.stringify(model.value)}`);
      if (effort.value) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort.value)}`);
      c.onModelSettings?.({ model, reasoningEffort: effort });
      if (consult) args.push('-c', 'approval_policy="never"');
      args.push('-');
    } else {
      const config = join(c.directory, 'mcp.json');
      writeFileSync(config, JSON.stringify({ mcpServers: { agiledev: { type: 'stdio', command: process.execPath, args: [c.bridgeScript, 'mcp'], env: { AGILEDEV_ENDPOINT: c.endpoint, AGILEDEV_TOKEN: '${AGILEDEV_TOKEN}' } } } }), { mode: 0o600 });
      args = ['--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', consult ? 'dontAsk' : 'acceptEdits', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', config, '--session-id', randomUUID(), '--allowedTools', 'mcp__agiledev__*'];
      const model = selectedSetting(ownerSetting('AGILEDEV_CLAUDE_MODEL'));
      if (model.value) args.push('--model', model.value);
      c.onModelSettings?.({ model, reasoningEffort: selectedSetting() });
      if (consult) args.push('--tools', '', '--disable-slash-commands');
    }
    const p = processSession(entry, args, c); p.child.stdin.end(c.prompt);
    return p;
  }
}
