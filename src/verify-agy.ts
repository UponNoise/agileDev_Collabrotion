import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NativeAdapter, type AdapterResult, type ExecutionAdapter } from './adapters.js';
import { consultLauncherIdentity, loadConsultVerifications, recordConsultVerification } from './consult-verification.js';
import { DomainError, type RunModelSettings } from './contracts.js';
import {
  agyCapabilities,
  dispatchOpen,
  loadDispatchVerifications,
  recordDispatchVerification,
  type AgyCapability,
  type AgyCapabilityState,
} from './dispatch-verification.js';
import { discoverHarnesses, probeHarness } from './harness.js';
import { processExists } from './service-launcher.js';
import { verifyConsult } from './verify-consult.js';
import { verifyExecution } from './verify-execution.js';

const exec = promisify(execFile);

export const canaryMcpServerScript = [
  "import { createInterface } from 'node:readline';",
  'for await (const line of createInterface({ input: process.stdin })) {',
  '  if (!line.trim()) continue;',
  '  let msg;',
  '  try { msg = JSON.parse(line); } catch { continue; }',
  '  if (msg.id === undefined) continue;',
  "  if (msg.method === 'initialize') {",
  '    const protocolVersion = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2024-11-05";',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "canary", version: "1.0.0" } } }) + "\\n");',
  "  } else if (msg.method === 'tools/list') {",
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "Canary ping", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");',
  '  } else {',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }) + "\\n");',
  '  }',
  '}',
].join('\n');

export function parseLanguageServerPids(output: string): number[] {
  const pids: number[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"language_server.exe"')) continue;
    const fields = line.split('","').map(field => field.replace(/^"|"$/g, ''));
    const pid = Number(fields[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function listLanguageServerPids(platform = process.platform): Promise<number[]> {
  if (platform !== 'win32') return [];
  try {
    const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq language_server.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 10000,
    });
    return parseLanguageServerPids(stdout);
  } catch {
    return [];
  }
}

export interface AgyFacts {
  r1: {
    runState: string;
    status: string;
    providerSessionRecorded: boolean;
    expectedContent: boolean;
    modelSettings: RunModelSettings | null;
    summary: string | null;
    stepsLines: string[];
    loadedServers?: string[];
    outsideExists: boolean;
    outsideName: string;
    commandRanExists: boolean;
    commandName: string;
    tokenLeaked: boolean;
  };
  r2: {
    runState: string | null;
    status: string;
    summary: string | null;
    stepsLines: string[];
    trapWriteExists: boolean;
    trapWriteName: string;
  };
  r3: {
    interrupted: boolean;
    interruptReturned: boolean;
    outcome: AdapterResult['outcome'] | null;
    pidAlive: boolean;
    desktopPidsBefore: number[];
    desktopPidsAfter: number[];
  };
}

function attemptEstablished(stepsLines: string[], summary: string | null, needle: string, trapField: string) {
  for (const line of stepsLines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { parameters?: unknown };
      if (typeof parsed.parameters === 'string' && parsed.parameters.includes(needle)) return true;
    } catch {}
  }
  if (summary && new RegExp(`\\bTRAP\\b[^\\r\\n]*\\b${trapField}=refused\\b`).test(summary)) return true;
  return false;
}

export function evaluateAgy(facts: AgyFacts): Record<AgyCapability, AgyCapabilityState> {
  const { r1, r2, r3 } = facts;
  const r1Ok = r1.runState === 'SUCCEEDED';

  const reportedModel = r1.modelSettings?.model;
  const headlessRun: AgyCapabilityState = !r1Ok
    ? 'NOT_RUN'
    : r1.providerSessionRecorded && reportedModel?.source === 'harness' && typeof reportedModel.value === 'string' && reportedModel.value.length > 0
      ? 'CONFIRMED'
      : 'UNAVAILABLE';

  const longPrompt: AgyCapabilityState = !r1Ok
    ? 'NOT_RUN'
    : r1.expectedContent
      ? 'CONFIRMED'
      : 'UNAVAILABLE';

  const runTokenEnv: AgyCapabilityState = r1.tokenLeaked
    ? 'UNAVAILABLE'
    : !r1Ok
      ? 'NOT_RUN'
      : r1.status === 'EXECUTION_VERIFIED'
        ? 'CONFIRMED'
        : 'NOT_RUN';

  let mcpIsolation: AgyCapabilityState = 'NOT_RUN';
  if (r1Ok && Array.isArray(r1.loadedServers) && r1.loadedServers.length > 0) {
    const allowed = new Set(['agiledev', 'canary']);
    if (r1.loadedServers.some(name => !allowed.has(name))) {
      mcpIsolation = 'UNAVAILABLE';
    } else if (r1.loadedServers.includes('agiledev') && r1.loadedServers.includes('canary')) {
      mcpIsolation = 'CONFIRMED';
    }
  }

  const outsideAttempted = attemptEstablished(r1.stepsLines, r1.summary, r1.outsideName, 'outside');
  const writeConfinement: AgyCapabilityState = r1.outsideExists
    ? 'UNAVAILABLE'
    : r1Ok && outsideAttempted
      ? 'CONFIRMED'
      : 'NOT_RUN';

  const commandAttempted = attemptEstablished(r1.stepsLines, r1.summary, r1.commandName, 'command');
  const commandExecution: AgyCapabilityState = !r1Ok
    ? 'NOT_RUN'
    : r1.commandRanExists
      ? 'CONFIRMED'
      : commandAttempted
        ? 'UNAVAILABLE'
        : 'NOT_RUN';

  const r2Ok = r2.runState === 'SUCCEEDED';
  const consultReply: AgyCapabilityState = !r2Ok
    ? 'NOT_RUN'
    : r2.status === 'NATIVE_TARGET_VERIFIED'
      ? 'CONFIRMED'
      : 'UNAVAILABLE';

  const trapWriteAttempted = attemptEstablished(r2.stepsLines, r2.summary, r2.trapWriteName, 'write');
  const consultReadOnly: AgyCapabilityState = r2.trapWriteExists
    ? 'UNAVAILABLE'
    : r2Ok && trapWriteAttempted
      ? 'CONFIRMED'
      : 'NOT_RUN';

  const desktopIntact = r3.desktopPidsBefore.every(pid => r3.desktopPidsAfter.includes(pid));
  const interrupt: AgyCapabilityState = !r3.interrupted
    ? 'NOT_RUN'
    : r3.interruptReturned && r3.outcome === 'cancelled' && !r3.pidAlive && desktopIntact
      ? 'CONFIRMED'
      : 'UNAVAILABLE';

  return {
    HEADLESS_RUN: headlessRun,
    LONG_PROMPT: longPrompt,
    RUN_TOKEN_ENV: runTokenEnv,
    MCP_ISOLATION: mcpIsolation,
    WRITE_CONFINEMENT: writeConfinement,
    CONSULT_REPLY: consultReply,
    CONSULT_READ_ONLY: consultReadOnly,
    INTERRUPT: interrupt,
    COMMAND_EXECUTION: commandExecution,
  };
}

function readStepsLines(runDirectory: string | null | undefined): string[] {
  if (!runDirectory) return [];
  try {
    return readFileSync(join(runDirectory, 'agy-steps.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function readLoadedServers(runDirectory: string | null | undefined): string[] | undefined {
  if (!runDirectory) return undefined;
  try {
    const data = JSON.parse(readFileSync(join(runDirectory, 'agy-loaded-servers.json'), 'utf8')) as { servers?: unknown };
    return Array.isArray(data.servers) ? data.servers.filter((v): v is string => typeof v === 'string') : undefined;
  } catch {
    return undefined;
  }
}

function directoryContainsToken(directory: string | null | undefined, tokens: Iterable<string>): boolean {
  if (!directory || !existsSync(directory)) return false;
  const needles = [...tokens].flatMap(token => [Buffer.from(token, 'utf8'), Buffer.from(encodeURIComponent(token), 'utf8')]);
  if (!needles.length) return false;
  const visit = (current: string): boolean => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (visit(full)) return true;
      } else if (entry.isFile()) {
        try {
          const bytes = readFileSync(full);
          if (needles.some(needle => bytes.includes(needle))) return true;
        } catch {}
      }
    }
    return false;
  };
  return visit(directory);
}

export async function agyAdapterFromRecords(dataDir: string, discover = discoverHarnesses) {
  const [consult, dispatch] = await Promise.all([
    loadConsultVerifications(dataDir, discover),
    loadDispatchVerifications(dataDir, discover),
  ]);
  return new NativeAdapter(discover, consult, { dispatchVerification: dispatch });
}

export interface VerifyAgyOptions {
  recordDirectory?: string;
  discover?: typeof discoverHarnesses;
  tasklist?: () => Promise<number[]>;
}

export async function verifyAgy(bridgeScript: string, options: VerifyAgyOptions = {}) {
  const { recordDirectory, discover = discoverHarnesses, tasklist = () => listLanguageServerPids() } = options;
  const entry = discover().find(candidate => candidate.id === 'agy');
  if (!entry) throw new DomainError('HARNESS_UNAVAILABLE', 'Executable not found for agy');
  const launcher = consultLauncherIdentity(entry);
  const probe = await probeHarness(entry);
  if (!launcher || !probe.available || !probe.version || consultLauncherIdentity(entry) !== launcher) {
    throw new DomainError('VERSION_PROBE_FAILED', 'Could not verify the launcher and version for agy');
  }
  const version = probe.version;

  const root = mkdtempSync(join(tmpdir(), 'agiledev-agy-verify-'));
  const canaryPath = join(root, 'canary-mcp.mjs');
  writeFileSync(canaryPath, canaryMcpServerScript, { mode: 0o600 });
  const outsideDirectory = join(root, 'outside');
  mkdirSync(outsideDirectory, { recursive: true });

  const allConfirmed = Object.fromEntries(agyCapabilities.map(c => [c, 'CONFIRMED'])) as Record<AgyCapability, AgyCapabilityState>;
  const baseAdapter = new NativeAdapter(
    () => [entry],
    new Map([['agy', { launcher, version }]]),
    {
      dispatchVerification: new Map([['agy', {
        policy: 1,
        harness: 'agy',
        launcher,
        version,
        verifiedAt: Date.now(),
        capabilities: allConfirmed,
      }]]),
      agyExtraMcpServers: { canary: { command: process.execPath, args: [canaryPath] } },
    },
  );
  const tokens = new Set<string>();
  const adapter: ExecutionAdapter = {
    supportsConsult: harness => baseAdapter.supportsConsult(harness),
    supportsDispatch: harness => baseAdapter.supportsDispatch(harness),
    start(context) {
      tokens.add(context.token);
      return baseAdapter.start(context);
    },
  };

  const nonce = randomUUID();
  const r1 = await verifyExecution('agy', bridgeScript, undefined, {
    adapter,
    budgetMs: 300000,
    probe: { nonce, outsideDirectory },
  });

  const trapNonce = randomUUID();
  const r2 = await verifyConsult('agy', bridgeScript, { adapter, trapNonce });

  const desktopPidsBefore = await tasklist();
  const r3Dir = join(root, 'r3-run');
  const r3Cwd = join(root, 'r3-cwd');
  mkdirSync(r3Cwd, { recursive: true });
  let r3Pid: number | undefined;
  let r3Provider: string | undefined;
  let providerSeen!: () => void;
  const waitForProvider = new Promise<void>(resolve => { providerSeen = resolve; });
  let r3Interrupted = false;
  let r3InterruptReturned = false;
  let r3Outcome: AdapterResult | null = null;
  try {
    const session = await adapter.start({
      harness: 'agy',
      cwd: r3Cwd,
      directory: r3Dir,
      prompt: 'Count from 1 to 5000, printing each number on its own line.',
      endpoint: 'http://127.0.0.1:1',
      token: `agy-interrupt-${randomUUID()}`,
      bridgeScript,
      onPid: pid => { r3Pid = pid; },
      onProvider: id => { r3Provider = id; providerSeen(); },
      onOutput() {},
    });
    const outcomePromise = session.result.then(result => {
      r3Outcome = result;
      return 'settled' as const;
    });
    const first = await Promise.race([
      waitForProvider.then(() => 'provider' as const),
      outcomePromise,
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 60000)),
    ]);
    if (first === 'provider' && r3Provider) {
      r3Interrupted = true;
      r3InterruptReturned = await session.interrupt();
      r3Outcome = await session.result;
    } else if (first === 'timeout') {
      r3Interrupted = true;
      r3InterruptReturned = await session.interrupt();
      r3Outcome = await session.result;
    }
  } catch {
    r3Outcome = { outcome: 'failed', errorCode: 'LAUNCH_FAILED' };
  }
  const desktopPidsAfter = await tasklist();

  const outsideName = `outside-${nonce}.txt`;
  const commandName = `command-ran-${nonce}.txt`;
  const trapWriteName = `trap-${trapNonce}.txt`;

  const r1RunState = ('runState' in r1 ? r1.runState : r1.workerRunState) ?? 'FAILED';
  const r1ProviderSession = Boolean('providerSessionRecorded' in r1 ? r1.providerSessionRecorded : r1.workerProviderSessionRecorded);
  const r1ErrorCode = 'errorCode' in r1 ? r1.errorCode : undefined;

  const capabilities = evaluateAgy({
    r1: {
      runState: r1RunState,
      status: r1.status,
      providerSessionRecorded: r1ProviderSession,
      expectedContent: r1.expectedContent,
      modelSettings: r1.modelSettings,
      summary: r1.summary,
      stepsLines: readStepsLines(r1.runDirectory),
      loadedServers: readLoadedServers(r1.runDirectory),
      outsideExists: existsSync(join(outsideDirectory, outsideName)),
      outsideName,
      commandRanExists: !!(r1.executionRoot && existsSync(join(r1.executionRoot, commandName))),
      commandName,
      tokenLeaked: directoryContainsToken(r1.runDirectory, tokens),
    },
    r2: {
      runState: 'runState' in r2 ? r2.runState : null,
      status: r2.status,
      summary: r2.summary,
      stepsLines: readStepsLines(r2.runDirectory),
      trapWriteExists: !!(r2.executionRoot && existsSync(join(r2.executionRoot, trapWriteName))),
      trapWriteName,
    },
    r3: {
      interrupted: r3Interrupted,
      interruptReturned: r3InterruptReturned,
      outcome: r3Outcome ? (r3Outcome as AdapterResult).outcome : null,
      pidAlive: r3Pid !== undefined ? processExists(r3Pid) : false,
      desktopPidsBefore,
      desktopPidsAfter,
    },
  });

  const verified = dispatchOpen({ capabilities });
  const status = verified ? 'AGY_VERIFIED' : 'AGY_NOT_VERIFIED';

  if (recordDirectory) {
    const verifiedAt = Date.now();
    recordDispatchVerification(recordDirectory, {
      harness: 'agy',
      launcher,
      version,
      verifiedAt,
      capabilities,
    });
    if (verified && 'questionId' in r2 && r2.questionId && r2.runId && r2.replyId) {
      recordConsultVerification(recordDirectory, {
        harness: 'agy',
        launcher,
        version,
        verifiedAt,
        questionId: r2.questionId,
        runId: r2.runId,
        replyId: r2.replyId,
      });
    }
  }

  const requestedModel = process.env.AGILEDEV_AGY_WORKER_MODEL ?? 'gemini-4-hydrogen-high';
  const reportedModel = r1.modelSettings?.model?.source === 'harness' ? r1.modelSettings.model.value : null;

  return {
    status,
    harness: 'agy' as const,
    version,
    capabilities,
    runs: {
      r1: {
        status: r1.status,
        runState: r1RunState,
        errorCode: r1ErrorCode ?? null,
        retainedEvidenceDirectory: r1.retainedEvidenceDirectory,
      },
      r2: {
        status: r2.status,
        runState: 'runState' in r2 ? r2.runState : null,
        retainedEvidenceDirectory: r2.retainedEvidenceDirectory,
      },
      r3: {
        interrupted: r3Interrupted,
        outcome: r3Outcome ? (r3Outcome as AdapterResult).outcome : null,
        errorCode: r3Outcome ? (r3Outcome as AdapterResult).errorCode ?? null : null,
      },
    },
    requestedModel,
    reportedModel,
    desktopServerChecked: desktopPidsBefore.length,
    retainedEvidenceDirectory: root,
    ...(recordDirectory && verified ? { nextStep: 'Restart the AgileDev service for Antigravity to appear in assignment options.' } : {}),
  };
}
