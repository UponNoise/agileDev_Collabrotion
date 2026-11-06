import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './http.js';
import { Store } from './store.js';
import { LocalClient } from './client.js';
import { connectMcp } from './mcp.js';
import { discoverHarnesses, probeHarness } from './harness.js';
import { probeHosts } from './probe.js';

const dataDir = resolve(process.env.AGILEDEV_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local/share'), 'AgileDev'));
const descriptorFile = join(dataDir, 'daemon.json');
function descriptor() { return JSON.parse(readFileSync(descriptorFile, 'utf8')) as { endpoint: string; ownerToken: string; pid: number; instance: string }; }
async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'probe-hosts') { console.log(JSON.stringify(await probeHosts(), null, 2)); return; }
  if (command === 'doctor') {
    const entries = discoverHarnesses();
    console.log(JSON.stringify({ harnesses: await Promise.all(entries.map(probeHarness)), missing: ['codex', 'claude-code', 'dsh'].filter(id => !entries.some(e => e.id === id)) }, null, 2));
    return;
  }
  if (command === 'serve') {
    mkdirSync(dataDir, { recursive: true });
    const lockFile = join(dataDir, 'daemon.lock');
    if (existsSync(lockFile)) {
      const previous = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number };
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('A daemon lock is owned by a live process; use its endpoint or reconcile it before restarting.');
      unlinkSync(lockFile);
    }
    const instance = randomUUID();
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, instance }), { flag: 'wx', mode: 0o600 });
    const store = new Store(join(dataDir, 'workflow.sqlite'));
    const app = createServer(store);
    try {
      const endpoint = await app.listen({ host: '127.0.0.1', port: Number(process.env.AGILEDEV_PORT ?? 43170) });
      const old = existsSync(descriptorFile) ? descriptor() : null;
      let ownerToken = old?.ownerToken;
      try { if (!ownerToken || store.authenticate(ownerToken).role !== 'human') ownerToken = undefined; } catch { ownerToken = undefined; }
      ownerToken ??= store.bootstrap().token;
      writeFileSync(descriptorFile, JSON.stringify({ endpoint, ownerToken, pid: process.pid, instance }), { mode: 0o600 });
      console.log(JSON.stringify({ endpoint, pid: process.pid, dataDir }));
      const stop = async () => { await app.close(); store.close(); unlinkSync(lockFile); process.exit(0); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    } catch (error) { await app.close(); store.close(); unlinkSync(lockFile); throw error; }
    return;
  }
  if (command === 'mcp') {
    const endpoint = process.env.AGILEDEV_ENDPOINT ?? descriptor().endpoint;
    const token = process.env.AGILEDEV_TOKEN;
    if (!token) throw new Error('Set AGILEDEV_TOKEN to an enrolled agent credential. The owner credential is never used automatically for MCP.');
    await connectMcp(new LocalClient(endpoint, token));
    return;
  }
  if (command === 'command') {
    if (!args[0]) throw new Error('Usage: command <operation> [JSON file|-]; input defaults to stdin');
    const config = descriptor();
    const input = JSON.parse(readFileSync(!args[1] || args[1] === '-' ? 0 : args[1], 'utf8'));
    const client = new LocalClient(process.env.AGILEDEV_ENDPOINT ?? config.endpoint, process.env.AGILEDEV_TOKEN ?? config.ownerToken);
    console.log(JSON.stringify(await client.command(args[0], input), null, 2));
    return;
  }
  if (command === 'connection') {
    const token = process.env.AGILEDEV_TOKEN;
    if (!token) throw new Error('Enroll an agent and set AGILEDEV_TOKEN first.');
    const endpoint = process.env.AGILEDEV_ENDPOINT ?? descriptor().endpoint;
    const client = new LocalClient(endpoint, token);
    if ((await client.request('/api/session')).actor.role === 'human') throw new Error('Connection configuration requires an agent credential.');
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
    const nodeArgs = [script, 'mcp'];
    const format = args[0] ?? 'claude-code';
    if (format === 'codex') {
      console.log(`[mcp_servers.agiledev]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(nodeArgs)}\nenv_vars = ["AGILEDEV_TOKEN"]\n\n[mcp_servers.agiledev.env]\nAGILEDEV_ENDPOINT = ${JSON.stringify(endpoint)}`);
    } else if (format === 'dsh') {
      console.log(`- insert:\n    - id: agiledev-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: agiledev\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: ${JSON.stringify(nodeArgs)}\n        env:\n          AGILEDEV_TOKEN: !!js process.env.AGILEDEV_TOKEN\n          AGILEDEV_ENDPOINT: ${JSON.stringify(endpoint)}`);
    } else if (format === 'claude-code') {
      const connection = { type: 'stdio', command: process.execPath, args: nodeArgs, env: { AGILEDEV_ENDPOINT: endpoint, AGILEDEV_TOKEN: '${AGILEDEV_TOKEN}' } };
      console.log(JSON.stringify({ mcpServers: { agiledev: connection } }, null, 2));
    } else throw new Error('Connection format must be codex, claude-code, or dsh.');
    return;
  }
  console.log('agiledev: serve | doctor | probe-hosts | command <operation> [JSON file|-] | mcp | connection [codex|claude-code|dsh]');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
