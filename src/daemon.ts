import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './http.js';
import { Store } from './store.js';
import { Coordinator } from './runner.js';
import { GitVerifier } from './git-verifier.js';
import { processExists, readDescriptor, ServiceError } from './service-launcher.js';

export async function serve(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const lockFile = join(dataDir, 'daemon.lock');
  const descriptorFile = join(dataDir, 'daemon.json');
  const instance = randomUUID();
  const control = new Database(join(dataDir, 'daemon-control.sqlite'));
  control.pragma('busy_timeout = 3000');
  control.exec('CREATE TABLE IF NOT EXISTS daemon (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, instance TEXT NOT NULL)');
  try {
    control.transaction(() => {
      const held = control.prepare('SELECT pid FROM daemon WHERE id=1').get() as { pid: number } | undefined;
      const legacy = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number } : null;
      if ((held && processExists(held.pid)) || (legacy && processExists(legacy.pid))) throw new ServiceError('SERVICE_LOCKED', 'A live process owns the service lock. Attach to it or reconcile it before restarting.');
      control.prepare('INSERT OR REPLACE INTO daemon(id,pid,instance) VALUES(1,?,?)').run(process.pid, instance);
      const temporary = `${lockFile}.${instance}.tmp`;
      writeFileSync(temporary, JSON.stringify({ pid: process.pid, instance }), { mode: 0o600 });
      renameSync(temporary, lockFile);
    }).immediate();
  } catch (error) { control.close(); throw error; }
  let store: Store | undefined;
  let coordinator: Coordinator | undefined;
  let verifier: GitVerifier | undefined;
  let stopping = false;
  const release = () => {
    control.transaction(() => {
      if (existsSync(lockFile) && JSON.parse(readFileSync(lockFile, 'utf8')).instance === instance) unlinkSync(lockFile);
      control.prepare('DELETE FROM daemon WHERE id=1 AND instance=?').run(instance);
    }).immediate();
    control.close();
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await coordinator?.close(); await verifier?.close(); await app.close(); store?.close(); release();
    process.exit(0);
  };
  let app: ReturnType<typeof createServer>;
  try { store = new Store(join(dataDir, 'workflow.sqlite')); app = createServer(store, { instance, stop }); }
  catch (error) { store?.close(); release(); throw error; }
  try {
    const endpoint = await app.listen({ host: '127.0.0.1', port: Number(process.env.AGILEDEV_PORT ?? 43170) });
    const old = readDescriptor(dataDir);
    let ownerToken = old?.ownerToken;
    try { if (!ownerToken || store!.authenticate(ownerToken).role !== 'human') ownerToken = undefined; } catch { ownerToken = undefined; }
    ownerToken ??= store!.bootstrap().token;
    const temporary = `${descriptorFile}.${instance}.tmp`;
    writeFileSync(temporary, JSON.stringify({ endpoint, ownerToken, pid: process.pid, instance }), { mode: 0o600 });
    renameSync(temporary, descriptorFile);
    verifier = new GitVerifier(store!); verifier.start();
    if (process.env.AGILEDEV_RUNNER_ENABLED !== '0') {
      coordinator = new Coordinator(store!, { endpoint, directory: join(dataDir, 'runs'), bridgeScript: resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js'), concurrency: Number(process.env.AGILEDEV_CONCURRENCY ?? 2), maxRunMs: Number(process.env.AGILEDEV_MAX_RUN_MS ?? 1800000) });
      await coordinator.start();
    }
    console.log(JSON.stringify({ endpoint, pid: process.pid, dataDir }));
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  } catch (error) { await coordinator?.close(); await verifier?.close(); await app.close(); store?.close(); release(); throw error; }
}
