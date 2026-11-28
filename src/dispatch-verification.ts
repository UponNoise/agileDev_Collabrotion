import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { consultLauncherIdentity } from './consult-verification.js';
import { harnesses, type Harness } from './contracts.js';
import { discoverHarnesses, probeHarness, type HarnessEntry } from './harness.js';

export const agyCapabilities = [
  'HEADLESS_RUN',
  'LONG_PROMPT',
  'RUN_TOKEN_ENV',
  'MCP_ISOLATION',
  'WRITE_CONFINEMENT',
  'CONSULT_REPLY',
  'CONSULT_READ_ONLY',
  'INTERRUPT',
  'COMMAND_EXECUTION',
] as const;

export type AgyCapability = typeof agyCapabilities[number];

export const requiredAgyCapabilities: readonly AgyCapability[] = [
  'HEADLESS_RUN',
  'LONG_PROMPT',
  'RUN_TOKEN_ENV',
  'MCP_ISOLATION',
  'WRITE_CONFINEMENT',
  'CONSULT_REPLY',
  'CONSULT_READ_ONLY',
  'INTERRUPT',
];

const capabilityState = z.enum(['CONFIRMED', 'UNAVAILABLE', 'NOT_RUN']);
export type AgyCapabilityState = z.infer<typeof capabilityState>;

const verificationSchema = z.strictObject({
  policy: z.literal(1),
  harness: z.enum(harnesses),
  launcher: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().min(1).max(1024),
  verifiedAt: z.number().int().positive(),
  capabilities: z.strictObject({
    HEADLESS_RUN: capabilityState,
    LONG_PROMPT: capabilityState,
    RUN_TOKEN_ENV: capabilityState,
    MCP_ISOLATION: capabilityState,
    WRITE_CONFINEMENT: capabilityState,
    CONSULT_REPLY: capabilityState,
    CONSULT_READ_ONLY: capabilityState,
    INTERRUPT: capabilityState,
    COMMAND_EXECUTION: capabilityState,
  }),
});

export type DispatchVerification = z.infer<typeof verificationSchema>;

export function dispatchOpen(record: Pick<DispatchVerification, 'capabilities'>): boolean {
  return requiredAgyCapabilities.every(capability => record.capabilities[capability] === 'CONFIRMED');
}

export function readDispatchVerification(directory: string, harness: Harness): DispatchVerification | undefined {
  try {
    const record = verificationSchema.safeParse(JSON.parse(readFileSync(join(directory, `dispatch-${harness}.json`), 'utf8')));
    if (record.success && record.data.harness === harness) return record.data;
  } catch { return undefined; }
}

export async function matchesDispatchVerification(
  entry: HarnessEntry,
  verification: Pick<DispatchVerification, 'launcher' | 'version'>,
): Promise<boolean> {
  if (consultLauncherIdentity(entry) !== verification.launcher) return false;
  const probe = await probeHarness(entry);
  return probe.available && probe.version === verification.version && consultLauncherIdentity(entry) === verification.launcher;
}

export async function loadDispatchVerifications(directory: string, discover = discoverHarnesses) {
  const records = new Map<Harness, DispatchVerification>();
  const saved = harnesses.flatMap(harness => {
    const record = readDispatchVerification(directory, harness);
    return record ? [record] : [];
  });
  if (!saved.length) return records;
  const entries = discover();
  await Promise.all(saved.map(async record => {
    const entry = entries.find(candidate => candidate.id === record.harness);
    if (entry && await matchesDispatchVerification(entry, record)) records.set(record.harness, record);
  }));
  return records;
}

export function recordDispatchVerification(directory: string, evidence: Omit<DispatchVerification, 'policy'>) {
  const record = verificationSchema.parse({ ...evidence, policy: 1 });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `dispatch-${record.harness}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
