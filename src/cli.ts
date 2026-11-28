import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { joinInput } from './join.js';
import { LocalClient, postPublic } from './client.js';
import { connectMcp } from './mcp.js';
import { discoverHarnesses, probeHarness } from './harness.js';
import { harnessDiagnostics } from './diagnostics.js';
import { probeHosts } from './probe.js';
import { resetStoppedOwner, serve } from './daemon.js';
import { dataDirectory, ensureService, requireService, ServiceError, stopService } from './service-launcher.js';
import { verifyExecution,verifyGit } from './verify-execution.js';
import { verifyConsult, verifyConsultExchange } from './verify-consult.js';
import { agyAdapterFromRecords, verifyAgy } from './verify-agy.js';
import { consultLauncherIdentity, readConsultVerification } from './consult-verification.js';
import { DomainError, harnesses, Harness } from './contracts.js';

export async function runVerifyQa(
  worker: Harness,
  qa: Harness,
  dataDir: string,
  script: string,
  execute = verifyExecution,
) {
  if (worker === 'agy' || qa === 'agy') {
    const adapter = await agyAdapterFromRecords(dataDir);
    if (!adapter.supportsDispatch('agy')) throw new Error('Run verify-agy --record first');
    return execute(worker, script, qa, { adapter });
  }
  return execute(worker, script, qa);
}

const dataDir = dataDirectory();
const service = () => ensureService({ dataDir, node: process.execPath, script: resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js') });
const agentCredentialRequired = 'Set AGILEDEV_TOKEN to an enrolled agent credential. The command line has no owner identity; owner decisions are made in the desktop app. 请把 AGILEDEV_TOKEN 设为已登记的智能体凭据。命令行没有所有者身份，所有者的决定要在桌面应用里做。';
async function commandClient() {
  const endpoint = process.env.AGILEDEV_ENDPOINT ?? (await requireService(dataDir)).endpoint;
  const token = process.env.AGILEDEV_TOKEN;
  if (!token) throw new ServiceError('AGENT_CREDENTIAL_REQUIRED', agentCredentialRequired);
  return new LocalClient(endpoint, token);
}
async function joinSession(args: string[]) {
  const separator = args.indexOf('--');
  const usage = 'Usage: join --name <text> --role <lead|pm|worker|qa> --harness <codex|claude-code|dsh|other> [--workspace <id>] -- <command> [args...]';
  if (separator < 0 || !args[separator + 1]) throw new ServiceError('INVALID_INPUT', usage);
  let values;
  try { ({ values } = parseArgs({ args: args.slice(0, separator), options: {
    name: { type: 'string' }, role: { type: 'string' }, harness: { type: 'string' }, workspace: { type: 'string' },
  } })); }
  catch { throw new ServiceError('INVALID_INPUT', usage); }
  const parsed = joinInput.safeParse({ name: values.name, role: values.role, harness: values.harness, workspaceId: values.workspace });
  if (!parsed.success) throw new ServiceError('INVALID_INPUT', usage);
  const endpoint = process.env.AGILEDEV_ENDPOINT ?? (await requireService(dataDir)).endpoint;
  const pending = await postPublic(endpoint, '/api/join', parsed.data);
  console.error(`${pending.requestId.slice(0, 8)} expires ${pending.expiresAt}; waiting for the owner in the desktop app`);
  const proof = { requestId: pending.requestId, secret: pending.secret };
  let result = pending;
  while (result.state === 'PENDING') {
    await delay(result.pollAfterMs);
    result = await postPublic(endpoint, '/api/join/poll', proof);
  }
  if (result.state !== 'APPROVED') {
    const message = { REFUSED: 'The owner refused the request.', EXPIRED: 'The request expired; apply again.', CLAIMED: 'The credential was already claimed.' }[result.state as string];
    throw new ServiceError(`JOIN_REQUEST_${result.state}`, message ?? 'Join request did not grant access.');
  }
  console.error(JSON.stringify(result.firstSteps));
  const [childCommand, ...childArgs] = args.slice(separator + 1);
  const ignoreInterrupt = () => {};
  process.on('SIGINT', ignoreInterrupt);
  let exitCode = 1;
  try {
    exitCode = await new Promise<number>(resolveExit => {
      const child = spawn(childCommand!, childArgs, { stdio: 'inherit', env: { ...process.env, AGILEDEV_ENDPOINT: endpoint, AGILEDEV_TOKEN: result.token } });
      child.once('error', () => {
        console.error('JOIN_COMMAND_FAILED: The command could not be started.');
        resolveExit(1);
      });
      child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } catch {
    console.error('JOIN_COMMAND_FAILED: The command could not be started.');
  } finally {
    try { await new LocalClient(endpoint, result.token).request('/api/join/retire', {}); }
    catch (error) { console.error(error instanceof DomainError ? error.code : 'SERVICE_UNAVAILABLE'); }
    process.off('SIGINT', ignoreInterrupt);
  }
  process.exitCode = exitCode;
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'ui') {
    const config = await service();
    if (!config.ownerToken) throw new ServiceError('OWNER_CREDENTIAL_PROTECTED', 'The desktop app holds the owner credential. Open the app, then Settings, General, "Open in a browser". 所有者凭据由桌面应用保管。请打开应用，到“设置 → 通用 → 在浏览器中打开”。');
    const pairing = await new LocalClient(config.endpoint,config.ownerToken).request('/api/ui/pairing',{});
    console.log(JSON.stringify({ url: config.endpoint,code: pairing.code,expiresAt: new Date(pairing.expiresAt).toISOString(),instruction: 'Open the local URL and enter this one-use code. Keep it private; do not add it to the URL.' },null,2)); return;
  }
  if (command === 'join') { await joinSession(args); return; }
  if (command === 'owner-reset') {
    resetStoppedOwner(dataDir);
    console.log(JSON.stringify({ reset: true }));
    return;
  }
  if (command === 'verify-git') { console.log(JSON.stringify(await verifyGit(args[0] ?? process.cwd()),null,2)); return; }
  if (command === 'verify-agy') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--record')) {
      throw new Error('Usage: verify-agy [--record]; starts up to three real Antigravity runs in disposable directories.');
    }
    if (process.env.AGILEDEV_TOKEN || process.env.AGILEDEV_ENDPOINT) {
      throw new Error('Run Antigravity verification locally outside an agent connection.');
    }
    const result = await verifyAgy(resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js'), {
      recordDirectory: args[0] === '--record' ? dataDir : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'AGY_VERIFIED') process.exitCode = 1;
    return;
  }
  if (command === 'verify-consult') {
    if (args[0] === 'agy') throw new Error('Use verify-agy for Antigravity');
    if (!(harnesses as readonly string[]).includes(args[0] ?? '') || args.length > 2 || (args.length === 2 && args[1] !== '--record')) {
      throw new Error('Usage: verify-consult <codex|claude-code|dsh> [--record]; starts one real model run in a disposable workspace.');
    }
    const record = args[1] === '--record';
    if (record && (process.env.AGILEDEV_TOKEN || process.env.AGILEDEV_ENDPOINT)) {
      throw new Error('Recording consult verification requires a local command outside an agent connection.');
    }
    const result = await verifyConsult(args[0] as Harness, resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js'), {
      recordDirectory: record ? dataDir : undefined
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'NATIVE_TARGET_VERIFIED') process.exitCode = 1;
    return;
  }
  if (command === 'verify-consult-exchange') {
    const [source, target] = args;
    if (source === 'agy' || target === 'agy') throw new Error('Use verify-agy for Antigravity');
    if (args.length !== 2 || !harnesses.includes(source as Harness) || !harnesses.includes(target as Harness) || source === target) {
      throw new Error('Usage: verify-consult-exchange <source harness> <different target harness>; starts up to two real model runs in a disposable workspace.');
    }
    if (process.env.AGILEDEV_TOKEN || process.env.AGILEDEV_ENDPOINT) {
      throw new Error('Run consult exchange verification locally outside an agent connection.');
    }
    const result = await verifyConsultExchange(source as Harness, target as Harness, resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js'));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'NATIVE_EXCHANGE_VERIFIED') process.exitCode = 1;
    return;
  }
  if (command === 'verify-execution') {
    if (args[0] === 'agy') throw new Error('Use verify-agy for Antigravity');
    if (!['codex', 'claude-code', 'dsh'].includes(args[0] ?? '')) throw new Error('Choose codex, claude-code, or dsh for the real execution verification.');
    console.log(JSON.stringify(await verifyExecution(args[0] as Harness, resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js')), null, 2));
    return;
  }
  if (command === 'verify-qa') {
    if (!(harnesses as readonly string[]).includes(args[0] ?? '') || !(harnesses as readonly string[]).includes(args[1] ?? '')) {
      throw new Error('Usage: verify-qa <worker harness> <QA harness>; this starts two real model runs.');
    }
    console.log(JSON.stringify(await runVerifyQa(args[0] as Harness, args[1] as Harness, dataDir, resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js')), null, 2));
    return;
  }
  if (command === 'probe-hosts') { console.log(JSON.stringify(await probeHosts(), null, 2)); return; }
  if (command === 'doctor') {
    const entries = discoverHarnesses();
    const status = await Promise.all(entries.map(async entry => {
      const probe = await probeHarness(entry);
      const record = readConsultVerification(dataDir, entry.id);
      return {
        ...probe,
        freshConsultVerified: !!record && probe.available && record.version === probe.version && record.launcher === consultLauncherIdentity(entry),
        diagnostics: probe.available ? await harnessDiagnostics(entry, { version: probe.version, dataDir }) : [],
      };
    }));
    console.log(JSON.stringify({ harnesses: status, missing: harnesses.filter(id => !entries.some(e => e.id === id)) }, null, 2));
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
    const text = readFileSync(!args[1] || args[1] === '-' ? 0 : args[1], 'utf8');
    const input = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    try {
      console.log(JSON.stringify(await client.command(args[0], input), null, 2));
    } catch (error) {
      if (error instanceof DomainError && error.remedy !== undefined) {
        console.error(JSON.stringify({ error: { code: error.code, message: error.message, details: error.details ?? null, remedy: error.remedy } }));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
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
  console.log('agiledev: serve | service-start | stop | ui | owner-reset | join | doctor | probe-hosts | verify-agy [--record] | verify-consult <harness> [--record] | verify-consult-exchange <source harness> <target harness> | verify-execution <harness> | verify-qa <worker harness> <QA harness> | verify-git [repository root] | command <operation> [JSON file|-] | mcp | connection [codex|claude-code|dsh]');
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof ServiceError || error instanceof DomainError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
}
