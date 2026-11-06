import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CheckProfile, CheckRun, DomainError, Issue, Run, Snapshot } from './contracts.js';
import { Store, hash } from './store.js';
import { inside } from './paths.js';
import { verifySnapshot } from './snapshots.js';
import { terminateTree } from './execution.js';

export class CheckExecutor {
  private active = new Map<string, { runId: string; stop(): Promise<boolean>; result: Promise<void> }>();
  private closing = false;
  constructor(private store: Store) {}
  recover() {
    for (const check of this.store.list<CheckRun>('check').filter(c => c.state === 'RUNNING')) { check.state = 'UNCERTAIN'; check.errorCode = 'CHECK_COORDINATOR_LOST'; this.store.put('check',check,check.workspaceId); }
  }
  tick() {
    if (this.closing) return;
    for (const check of this.store.list<CheckRun>('check').filter(c => c.state === 'QUEUED')) {
      if (this.store.list<CheckRun>('check').filter(c => ['RUNNING','UNCERTAIN'].includes(c.state)).length >= 2) break;
      const run = this.store.get<Run>('run',check.runId);
      if (run.state !== 'RUNNING') { check.state = 'FAILED'; check.errorCode = 'QA_RUN_UNAVAILABLE'; this.store.put('check',check,check.workspaceId); continue; }
      try { this.start(check,run); }
      catch (error) { check.state = 'FAILED'; check.errorCode = error instanceof DomainError ? error.code : 'CHECK_PREPARATION_FAILED'; this.store.put('check',check,check.workspaceId); }
    }
  }
  private start(check: CheckRun, run: Run) {
    const snapshot = this.store.get<Snapshot>('snapshot',check.snapshotId); const profile = this.store.get<CheckProfile>('check_profile',check.profileId);
    verifySnapshot(snapshot); verifySnapshot(snapshot,run.executionRoot!,true);
    if (profile.hash !== check.profileHash) throw new DomainError('EVIDENCE_STALE','Check profile changed');
    for (const file of check.testFiles) if (hash(readFileSync(inside(run.executionRoot!,file.path))) !== file.hash) throw new DomainError('EVIDENCE_STALE','QA test file changed before execution');
    const allowedEnv = new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','COMSPEC','PATHEXT','LANG']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key,value]) => allowedEnv.has(key.toUpperCase()) && value !== undefined)) as Record<string,string>;
    const child = spawn(profile.command,profile.args,{ cwd: run.executionRoot!, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
    check.state = 'RUNNING'; check.startedAt = new Date().toISOString(); check.command = profile.command; check.args = profile.args; check.pid = child.pid;
    this.store.put('check',check,check.workspaceId);
    let stdout = ''; let stderr = ''; let outputBytes = 0; let errorCode: string | undefined; let termination: Promise<boolean> | undefined; let closed = false;
    const stop = async () => {
      if (closed) return true;
      termination ??= child.pid ? terminateTree(child.pid) : Promise.resolve(false);
      return termination;
    };
    const collect = (data: Buffer, channel: 'stdout' | 'stderr') => {
      outputBytes += data.length;
      if (channel === 'stdout') stdout = (stdout + data.toString()).slice(-65536); else stderr = (stderr + data.toString()).slice(-65536);
      if (outputBytes > 1048576) { errorCode = 'CHECK_OUTPUT_LIMIT'; void stop(); }
    };
    child.stdout.on('data',data => collect(data,'stdout')); child.stderr.on('data',data => collect(data,'stderr'));
    child.once('error',() => { errorCode = 'CHECK_LAUNCH_FAILED'; });
    const timer = setTimeout(() => { errorCode = 'CHECK_TIMEOUT'; void stop(); },profile.timeoutMs);
    const result = new Promise<void>(done => child.once('close',async code => {
      closed = true; clearTimeout(timer);
      const stopped = termination ? await termination : true;
      if (!this.store.db.open) { done(); return; }
      try {
        verifySnapshot(snapshot); verifySnapshot(snapshot,run.executionRoot!,true);
        for (const file of check.testFiles) if (hash(readFileSync(inside(run.executionRoot!,file.path))) !== file.hash) throw new DomainError('EVIDENCE_STALE','QA test changed during execution');
        const current = this.store.get<Issue>('issue',check.issueId);
        if (current.candidate?.id !== check.candidateId || this.store.get<Run>('run',run.id).state !== 'RUNNING') errorCode ??= 'EVIDENCE_STALE';
      } catch (error) { errorCode = error instanceof DomainError ? error.code : 'EVIDENCE_STALE'; }
      check.state = !stopped ? 'UNCERTAIN' : code === 0 && !errorCode ? 'PASSED' : 'FAILED';
      check.exitCode = code; check.stdout = stdout; check.stderr = stderr; check.errorCode = errorCode; check.finishedAt = new Date().toISOString();
      this.store.put('check',check,check.workspaceId);
      const actor = this.store.get<any>('actor',check.actorId);
      this.store.event(check.workspaceId,actor,'qa_check_finished',check.id,{ state: check.state, exitCode: code, snapshotId: snapshot.id, errorCode });
      this.active.delete(check.id); done();
    }));
    this.active.set(check.id,{ runId: run.id, stop, result });
  }
  async cancelRun(runId: string) {
    let confirmed = true;
    for (const check of this.store.list<CheckRun>('check').filter(c => c.runId === runId && c.state === 'QUEUED')) { check.state = 'FAILED'; check.errorCode = 'QA_RUN_STOPPED'; this.store.put('check',check,check.workspaceId); }
    for (const [id,check] of [...this.active].filter(([,c]) => c.runId === runId)) {
      const stopped = await check.stop();
      let timer: NodeJS.Timeout | undefined;
      const settled = stopped && await Promise.race([check.result.then(() => true),new Promise<false>(done => { timer = setTimeout(() => done(false),2000); })]);
      if (timer) clearTimeout(timer);
      if (!settled) { confirmed = false; const record = this.store.get<CheckRun>('check',id); record.state = 'UNCERTAIN'; record.errorCode = 'CHECK_STOP_UNCONFIRMED'; this.store.put('check',record,record.workspaceId); }
    }
    if (this.store.list<CheckRun>('check').some(c => c.runId === runId && c.state === 'UNCERTAIN')) confirmed = false;
    return confirmed;
  }
  async close() {
    this.closing = true;
    for (const runId of new Set([...this.active.values()].map(c => c.runId))) await this.cancelRun(runId);
  }
}
