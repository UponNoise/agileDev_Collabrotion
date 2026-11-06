import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Actor, Harness, Issue, Run } from './contracts.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { createServer } from './http.js';
import { Coordinator } from './runner.js';

export async function verifyExecution(harness: Harness, bridgeScript: string) {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-native-execution-'));
  const source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'README.md'), 'Disposable AgileDev execution fixture.\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init'); git('add', '.'); git('-c', 'user.name=AgileDev verification', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initialize disposable execution fixture');
  const store = new Store(join(root, 'workflow.sqlite')); const flow = new Workflow(store); const owner = store.bootstrap();
  const call = (actor: Actor, operation: string, input: object) => flow.execute(actor, operation, { idempotencyKey: randomUUID(), ...input }) as any;
  const workspace = call(owner.actor, 'workspace_register', { root: source, name: 'Native execution verification', prefix: 'NAT' }).workspace;
  const run = (operation: string, input: object) => call(owner.actor, operation, { workspaceId: workspace.id, ...input });
  const parent = run('issue_create', { title: 'Native execution fixture', description: 'Verify the selected native harness executes in an isolated directory and submits actual files', criteria: ['FILE-1'] }).issue;
  const change = (operation: string, issueId: string, input: object = {}) => run(operation, { issueId, expectedVersion: store.get<Issue>('issue', issueId).version, ...input });
  change('design_set', parent.id, { content: 'Create delivery.txt containing exactly agiledev-native-ok followed by a newline. Do not change README.md. Submit delivery.txt through the workflow tool. This is a disposable integration fixture, not a user delivery acceptance.', criteria: ['FILE-1'] });
  change('design_submit', parent.id); change('design_decide', parent.id, { designId: store.get<Issue>('issue', parent.id).designId, decision: 'APPROVED', reason: 'Automated integration fixture setup; not approval of a real product requirement' });
  const task = run('issue_create', { parentId: parent.id, expectedParentVersion: store.get<Issue>('issue', parent.id).version, title: '[Test] Execution: write delivery.txt -> authenticated submission', description: 'Write delivery.txt containing exactly agiledev-native-ok and a newline, then use the provided MCP workflow tools to submit that file for initial lead review. Preserve README.md.', criteria: ['FILE-1'] }).issue;
  const worker = run('actor_enroll', { role: 'worker', name: `${harness} fixture worker` });
  change('issue_assign', task.id, { actorId: worker.actor.id, harness });
  const job = change('work_dispatch', task.id, { designId: store.get<Issue>('issue', parent.id).designId, scopeRevision: 1 }).run as Run;
  const app = createServer(store); const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const coordinator = new Coordinator(store, { endpoint, directory: join(root, 'runs'), bridgeScript, concurrency: 1, maxRunMs: 120000 });
  try {
    await coordinator.start(); const deadline = Date.now() + 140000;
    while (['QUEUED', 'STARTING', 'RUNNING', 'STOPPING'].includes(store.get<Run>('run', job.id).state) && Date.now() < deadline) await new Promise(done => setTimeout(done, 250));
    await coordinator.close();
    const final = store.get<Run>('run', job.id); const issue = store.get<Issue>('issue', task.id);
    const delivered = issue.candidate?.executionRoot ? join(issue.candidate.executionRoot, 'delivery.txt') : null;
    const expectedContent = delivered && existsSync(delivered) ? readFileSync(delivered, 'utf8') === 'agiledev-native-ok\n' : false;
    const sourceIntact = !existsSync(join(source, 'delivery.txt')) && readFileSync(join(source, 'README.md'), 'utf8') === 'Disposable AgileDev execution fixture.\n';
    return { harness, status: final.state === 'SUCCEEDED' && expectedContent && sourceIntact && issue.state === 'LEAD_REVIEW' ? 'EXECUTION_VERIFIED' : 'EXECUTION_NOT_VERIFIED', runState: final.state, errorCode: final.errorCode, issueState: issue.state, providerSessionRecorded: !!final.providerSessionId, expectedContent, sourceIntact, retainedEvidenceDirectory: root, diagnostic: final.state !== 'SUCCEEDED' ? final.summary?.replaceAll(root, '<fixture>')?.slice(-2500) : undefined, limitations: ['This verifies worker execution and submission, not independent QA or user acceptance.'] };
  } finally { await coordinator.close(); await app.close(); store.close(); }
}
