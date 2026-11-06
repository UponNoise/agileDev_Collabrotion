import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { discoverHarnesses, HarnessEntry, probeHarness } from './harness.js';
import { hash, Store } from './store.js';
import { Workflow } from './workflow.js';
import { createServer } from './http.js';

const exec = promisify(execFile);
async function codexProbe(entry: HarnessEntry, home: string, root: string, token: string, endpoint: string, script: string) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), `[mcp_servers.agiledev]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}, "mcp"]\nenv_vars = ["AGILEDEV_TOKEN", "AGILEDEV_ENDPOINT"]\nstartup_timeout_sec = 15\n`);
  const child = spawn(entry.command, [...entry.args, 'app-server', '--stdio'], { cwd: root, env: { ...process.env, ...entry.env, CODEX_HOME: home, AGILEDEV_TOKEN: token, AGILEDEV_ENDPOINT: endpoint }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let seq = 0;
  let stderr = '';
  child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-3000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'No interactive approval in a no-inference connectivity probe' } })}\n`);
      return;
    }
    const waiting = pending.get(message.id);
    if (waiting) { clearTimeout(waiting.timer); pending.delete(message.id); if (message.error) waiting.reject(new Error(`${message.error.code}: ${message.error.message}`)); else waiting.resolve(message.result); }
  });
  child.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
  child.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('App Server exited before responding')); } pending.clear(); });
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((done, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`App Server timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve: done, reject, timer }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'agiledev-connectivity-probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const started = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
    const result = await rpc('mcpServer/tool/call', { threadId: started.thread.id, server: 'agiledev', tool: 'workspace_list', arguments: {} });
    if (result.isError || !result.structuredContent?.workspaces?.length) throw new Error('Host did not return shared workspace data');
    const workspaceId = result.structuredContent.workspaces[0].id;
    const created = await rpc('mcpServer/tool/call', { threadId: started.thread.id, server: 'agiledev', tool: 'issue_create', arguments: { workspaceId, title: 'Native host round trip', description: 'Verify the actual host writes to the shared service', idempotencyKey: 'codex-host-roundtrip' } });
    const issueId = created.structuredContent?.issue?.id;
    if (created.isError || !issueId) throw new Error('Host could not create a shared issue');
    const read = await rpc('mcpServer/tool/call', { threadId: started.thread.id, server: 'agiledev', tool: 'issue_get', arguments: { workspaceId, issueId } });
    if (read.isError || read.structuredContent?.issue?.id !== issueId) throw new Error('Host could not read its shared issue');
    return { id: entry.id, status: 'HOST_TOOL_CALL_VERIFIED', tools: ['workspace_list', 'issue_create', 'issue_get'], issueRoundTripVerified: true, workspaceCount: result.structuredContent.workspaces.length, inferenceStarted: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Probe failed';
    return { id: entry.id, status: 'PROBE_FAILED', error: message.replaceAll(token, '[redacted]'), diagnostic: stderr.replaceAll(token, '[redacted]').replaceAll(home, '<temporary-config>').replaceAll(root, '<temporary-workspace>'), inferenceStarted: false };
  } finally {
    lines.close(); child.stdin.end();
    if (child.exitCode === null) {
      const stopped = new Promise<void>(done => child.once('exit', () => done()));
      child.kill(); await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2000))]);
    }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Probe closed')); } pending.clear();
  }
}
async function claudeProbe(entry: HarnessEntry, home: string, root: string, token: string, endpoint: string, script: string) {
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, ...entry.env, CLAUDE_CONFIG_DIR: home, AGILEDEV_TOKEN: token, AGILEDEV_ENDPOINT: endpoint };
  const connection = { type: 'stdio', command: process.execPath, args: [script, 'mcp'], env: { AGILEDEV_TOKEN: '${AGILEDEV_TOKEN}', AGILEDEV_ENDPOINT: '${AGILEDEV_ENDPOINT}' } };
  await exec(entry.command, [...entry.args, 'mcp', 'add-json', '--scope', 'user', 'agiledev', JSON.stringify(connection)], { cwd: root, env, windowsHide: true, timeout: 15000, maxBuffer: 65536 });
  const { stdout } = await exec(entry.command, [...entry.args, 'mcp', 'list'], { cwd: root, env, windowsHide: true, timeout: 25000, maxBuffer: 65536 });
  if (!/agiledev[\s\S]*Connected/i.test(stdout)) return { id: entry.id, status: 'PROBE_FAILED', error: 'Host did not confirm an MCP connection', inferenceStarted: false };
  return { id: entry.id, status: 'HOST_MCP_CONNECTION_VERIFIED', inferenceStarted: false };
}
async function dshProbe(entry: HarnessEntry, home: string, root: string, token: string, endpoint: string, script: string, seen: () => boolean) {
  mkdirSync(home, { recursive: true });
  const patch = join(home, 'agiledev.patch.yml');
  writeFileSync(patch, `- insert:\n    - id: agiledev-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: agiledev\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(script)}, "mcp"]\n        env:\n          AGILEDEV_TOKEN: !!js process.env.AGILEDEV_TOKEN\n          AGILEDEV_ENDPOINT: !!js process.env.AGILEDEV_ENDPOINT\n`);
  const child = spawn(entry.command, [...entry.args, '--profile', 'sdk', '--patch', patch], { cwd: root, env: { ...process.env, ...entry.env, DSH_HOME: home, AGILEDEV_TOKEN: token, AGILEDEV_ENDPOINT: endpoint }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; let failed = false;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
  child.stdout.resume();
  child.on('error', () => { failed = true; });
  try {
    const deadline = Date.now() + 20000;
    while (!seen() && !failed && child.exitCode === null && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    if (seen()) return { id: entry.id, status: 'HOST_MCP_CONNECTION_VERIFIED', inferenceStarted: false };
    return { id: entry.id, status: 'PROBE_FAILED', error: 'DSH did not finish MCP initialization within the probe window', diagnostic: stderr.replaceAll(token, '[redacted]').replaceAll(home, '<temporary-config>').replaceAll(root, '<temporary-workspace>'), inferenceStarted: false };
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      const stopped = new Promise<void>(done => child.once('exit', () => done()));
      child.kill(); await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2000))]);
    }
  }
}
export async function probeHosts() {
  const protectedFiles = [join(homedir(), '.claude.json'), join(homedir(), '.claude/settings.json'), join(homedir(), '.codex/config.toml')];
  const fingerprint = () => protectedFiles.map(path => existsSync(path) ? hash(readFileSync(path)) : null);
  const before = fingerprint();
  const root = mkdtempSync(join(tmpdir(), 'agiledev-host-probe-'));
  const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  const store = new Store(join(root, 'workflow.sqlite'));
  const flow = new Workflow(store); const owner = store.bootstrap();
  const workspace = (flow.execute(owner.actor, 'workspace_register', { root: workspaceRoot, name: 'Host connectivity probe', prefix: 'PR', idempotencyKey: 'workspace' }) as any).workspace;
  const server = createServer(store); const endpoint = await server.listen({ host: '127.0.0.1', port: 0 });
  const script = resolve(fileURLToPath(new URL('../dist/cli.js', import.meta.url)));
  const results = [];
  try {
    for (const entry of discoverHarnesses()) {
      const version = await probeHarness(entry);
      if (!version.available) { results.push(version); continue; }
      const enrollment = flow.execute(owner.actor, 'actor_enroll', { workspaceId: workspace.id, role: 'lead', name: `${entry.id} probe`, idempotencyKey: `enroll-${entry.id}` }) as any;
      try {
        const result = entry.id === 'codex'
          ? await codexProbe(entry, join(root, 'codex'), workspaceRoot, enrollment.token, endpoint, script)
          : entry.id === 'claude-code'
            ? await claudeProbe(entry, join(root, 'claude'), workspaceRoot, enrollment.token, endpoint, script)
            : await dshProbe(entry, join(root, 'dsh'), workspaceRoot, enrollment.token, endpoint, script, () => store.list<any>('connection', workspace.id).some(c => c.actorId === enrollment.actor.id));
        results.push({ ...version, ...result });
      } catch { results.push({ ...version, status: 'PROBE_FAILED', error: 'Host connectivity probe failed; credentials were not printed', inferenceStarted: false }); }
    }
    return { results, checkedGlobalConfigurationChanged: JSON.stringify(before) !== JSON.stringify(fingerprint()), limitations: ['No model turn or worker execution was started.', 'Connection health does not prove task execution, independent QA, or embedded UI support.', 'Global configuration check covers Claude and Codex user settings only.'] };
  } finally { await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
}
