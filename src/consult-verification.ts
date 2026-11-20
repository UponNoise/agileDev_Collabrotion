import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { harnesses, type Harness } from './contracts.js';
import { discoverHarnesses, probeHarness, type HarnessEntry } from './harness.js';

const verificationSchema = z.strictObject({
  policy: z.literal(1),
  harness: z.enum(harnesses),
  launcher: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().min(1).max(1024),
  verifiedAt: z.number().int().positive(),
  questionId: z.string().min(1),
  runId: z.string().min(1),
  replyId: z.string().min(1)
});

type VerificationRecord = z.infer<typeof verificationSchema>;
export type ConsultVerification = Pick<VerificationRecord, 'launcher' | 'version'>;

export function consultLauncherIdentity(entry: HarnessEntry): string | null {
  try {
    const files = [entry.command, ...entry.args.filter(isAbsolute)].map(path => {
      const archive = path.match(/^(.*?\.asar)[\\/]/i)?.[1];
      const resolved = realpathSync(archive ?? path);
      const stat = statSync(resolved, { bigint: true });
      if (!stat.isFile()) throw new Error('Launcher path is not a file');
      return [resolved, String(stat.ino), String(stat.size), String(stat.mtimeNs)];
    });
    const environment = Object.entries(entry.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
    return createHash('sha256').update(JSON.stringify([entry.id, entry.command, entry.args, environment, files])).digest('hex');
  } catch {
    return null;
  }
}

export function readConsultVerification(directory: string, harness: Harness): VerificationRecord | undefined {
  try {
    const record = verificationSchema.safeParse(JSON.parse(readFileSync(join(directory, `consult-${harness}.json`), 'utf8')));
    if (record.success && record.data.harness === harness) return record.data;
  } catch { return undefined; }
}

export async function matchesConsultVerification(entry: HarnessEntry, verification: ConsultVerification): Promise<boolean> {
  if (consultLauncherIdentity(entry) !== verification.launcher) return false;
  const probe = await probeHarness(entry);
  return probe.available && probe.version === verification.version && consultLauncherIdentity(entry) === verification.launcher;
}

export async function loadConsultVerifications(directory: string, discover = discoverHarnesses) {
  const records = new Map<Harness, ConsultVerification>();
  const saved = harnesses.flatMap(harness => {
    const record = readConsultVerification(directory, harness);
    return record ? [record] : [];
  });
  if (!saved.length) return records;
  const entries = discover();
  await Promise.all(saved.map(async record => {
    const entry = entries.find(candidate => candidate.id === record.harness);
    if (entry && await matchesConsultVerification(entry, record)) records.set(record.harness, record);
  }));
  return records;
}

export function recordConsultVerification(directory: string, evidence: Omit<VerificationRecord, 'policy'>) {
  const record = verificationSchema.parse({ ...evidence, policy: 1 });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `consult-${record.harness}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
