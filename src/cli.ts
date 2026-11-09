import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalClient } from './client.js';
import { connectMcp } from './mcp.js';
import { discoverHarnesses, probeHarness } from './harness.js';
import { probeHosts } from './probe.js';
import { serve } from './daemon.js';
import { dataDirectory, ensureService, requireService, ServiceError, stopService } from './service-launcher.js';
import { verifyExecution,verifyGit } from './verify-execution.js';
import { harnesses, Harness } from './contracts.js';

const dataDir = dataDirectory();
const service = () => ensureService({ dataDir, node: process.execPath, script: resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js') });
async function commandClient() {
  const endpoint = process.env.AGILEDEV_ENDPOINT;
  const token = process.env.AGILEDEV_TOKEN;
  if (endpoint !== undefined) {
    if (!token) throw new ServiceError('AGENT_CREDENTIAL_REQUIRED', 'An explicit AGILEDEV_ENDPOINT requires an explicit AGILEDEV_TOKEN agent credential. The local owner credential is not forwarded.');
    return new LocalClient(endpoint, token);
  }
  const config = await requireService(dataDir);
  return new LocalClient(config.endpoint, token ?? config.ownerToken);
}
async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'ui') {
    const config = await service(); const pairing = await new LocalClient(config.endpoint,config.ownerToken).request('/api/ui/pairing',{});
    console.log(JSON.stringify({ url: config.endpoint,code: pairing.code,expiresAt: new Date(pairing.expiresAt).toISOString(),instruction: 'Open the local URL and enter this one-use code. Keep it private; do not add it to the URL.' },null,2)); return;
  }
  if (command === 'verify-git') { console.log(JSON.stringify(await verifyGit(args[0] ?? process.cwd()),null,2)); return; }
  if (command === 'verify-execution' || command === 'verify-qa') {
    if (!(harnesses as readonly string[]).includes(args[0] ?? '')) throw new Error('Choose codex, claude-code, or dsh for the real execution verification.');
    if (command === 'verify-qa' && !(harnesses as readonly string[]).includes(args[1] ?? '')) throw new Error('Usage: verify-qa <worker harness> <QA harness>; this starts two real model runs.');
    console.log(JSON.stringify(await verifyExecution(args[0] as Harness, resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js'),command === 'verify-qa' ? args[1] as Harness : undefined), null, 2));
    return;
  }
  if (command === 'probe-hosts') { console.log(JSON.stringify(await probeHosts(), null, 2)); return; }
  if (command === 'doctor') {
    const entries = discoverHarnesses();
    console.log(JSON.stringify({ harnesses: await Promise.all(entries.map(probeHarness)), missing: ['codex', 'claude-code', 'dsh'].filter(id => !entries.some(e => e.id === id)) }, null, 2));
    return;
  }
  if (command === 'serve') { await serve(dataDir); return; }
  if (command === 'service-start') { const { endpoint, pid, instance } = await service(); console.log(JSON.stringify({ endpoint, pid, instance })); return; }
  if (command === 'stop') { console.log(JSON.stringify({ stopped: await stopService(dataDir) })); return; }
  if (command === 'mcp') {
    const token = process.env.AGILEDEV_TOKEN;
    if (!token) throw new Error('Set AGILEDEV_TOKEN to an enrolled agent credential. The owner credential is never used automatically for MCP.');
    const endpoint = process.env.AGILEDEV_ENDPOINT ?? (await requireService(dataDir)).endpoint;
    await connectMcp(new LocalClient(endpoint, token));
    return;
  }
  if (command === 'command') {
    if (!args[0]) throw new Error('Usage: command <operation> [JSON file|-]; input defaults to stdin');
    const client = await commandClient();
    const input = JSON.parse(readFileSync(!args[1] || args[1] === '-' ? 0 : args[1], 'utf8'));
    console.log(JSON.stringify(await client.command(args[0], input), null, 2));
    return;
  }
  if (command === 'connection') {
    const token = process.env.AGILEDEV_TOKEN;
    if (!token) throw new Error('Enroll an agent and set AGILEDEV_TOKEN first.');
    const endpoint = process.env.AGILEDEV_ENDPOINT ?? (await requireService(dataDir)).endpoint;
    const client = new LocalClient(endpoint, token);
    if ((await client.request('/api/session')).actor.role === 'human') throw new Error('Connection configuration requires an agent credential.');
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
    const nodeArgs = [script, 'mcp'];
    const target = process.env.AGILEDEV_ENDPOINT ? { AGILEDEV_ENDPOINT: endpoint } : { AGILEDEV_DATA_DIR: dataDir };
    const format = args[0] ?? 'claude-code';
    if (format === 'codex') {
      console.log(`[mcp_servers.agiledev]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(nodeArgs)}\nenv_vars = ["AGILEDEV_TOKEN"]\n\n[mcp_servers.agiledev.env]\n${Object.entries(target).map(([key,value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}`);
    } else if (format === 'dsh') {
      console.log(`- insert:\n    - id: agiledev-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: agiledev\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: ${JSON.stringify(nodeArgs)}\n        env:\n          AGILEDEV_TOKEN: !!js process.env.AGILEDEV_TOKEN\n${Object.entries(target).map(([key,value]) => `          ${key}: ${JSON.stringify(value)}`).join('\n')}`);
    } else if (format === 'claude-code') {
      const connection = { type: 'stdio', command: process.execPath, args: nodeArgs, env: { ...target, AGILEDEV_TOKEN: '${AGILEDEV_TOKEN}' } };
      console.log(JSON.stringify({ mcpServers: { agiledev: connection } }, null, 2));
    } else throw new Error('Connection format must be codex, claude-code, or dsh.');
    return;
  }
  console.log('agiledev: serve | service-start | stop | ui | doctor | probe-hosts | verify-execution <harness> | verify-qa <worker harness> <QA harness> | verify-git [repository root] | command <operation> [JSON file|-] | mcp | connection [codex|claude-code|dsh]');
}
main().catch(error => { console.error(error instanceof ServiceError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
