import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Actor, CheckRun, Issue, Run } from '../src/contracts.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { Coordinator } from '../src/runner.js';
import { AdapterContext, AdapterResult, ExecutionAdapter } from '../src/adapters.js';
import { createServer } from '../src/http.js';
import { LocalClient } from '../src/client.js';
import { applyFixturePlan } from './fixtures.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 12000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Integration fixture did not reach the expected state');
    await new Promise((done) => setTimeout(done, 20));
  }
}
class IntegrationProviderDouble implements ExecutionAdapter {
  contexts: AdapterContext[] = [];
  finish = new Map<string, (result: AdapterResult) => void>();
  async start(context: AdapterContext) {
    this.contexts.push(context);
    context.onProvider(`integration-fixture-${randomUUID()}`);
    return {
      result: new Promise<AdapterResult>((done) => this.finish.set(context.cwd, done)),
      interrupt: async () => {
        this.finish.get(context.cwd)?.({ outcome: 'cancelled' });
        return true;
      }
    };
  }
}

test(
  'accepted replacements and explicit human exclusions require real assembled QA, fresh rework and exact parent acceptance; reopening invalidates the parent',
  { timeout: 60000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agiledev-integration-'));
    const source = join(directory, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'README.md'), 'base\n');
    const store = new Store(join(directory, 'workflow.sqlite'));
    const flow = new Workflow(store);
    const human = store.bootstrap().actor;
    const call = (actor: Actor, op: string, input: object) =>
      flow.execute(actor, op, {
        ...input,
        ...(['issue_get', 'plan_get', 'integration_get', 'artifact_read'].includes(op)
          ? {}
          : { idempotencyKey: randomUUID() })
      }) as any;
    const workspace = call(human, 'workspace_register', {
      root: source,
      name: 'Assembled integration fixture',
      prefix: 'INT'
    }).workspace;
    const run = (op: string, input: object, actor = human) => call(actor, op, { workspaceId: workspace.id, ...input });
    const current = (id: string) => store.get<Issue>('issue', id);
    const change = (op: string, id: string, input: object = {}, actor = human) =>
      run(op, { issueId: id, expectedVersion: current(id).version, ...input }, actor);
    const enroll = (role: string, name: string) => run('actor_enroll', { role, name });
    const lead = enroll('lead', 'Fixture lead').actor as Actor;
    const pm = enroll('pm', 'Fixture PM').actor as Actor;
    const workers = ['Worker A', 'Worker B', 'Integration worker'].map((name) => enroll('worker', name));
    const qa = enroll('qa', 'Independent fixture QA').actor as Actor;
    const parent = run('issue_create', {
      title: 'Assemble reviewed outputs',
      description: 'Deliver A, B, and their exact combined artifact',
      criteria: ['A', 'B', 'JOIN']
    }).issue as Issue;
    change('design_set', parent.id, {
      content:
        'a.txt is A followed by a space, Euro, and LF; b.txt is B and LF. combined.txt must concatenate a.txt then b.txt. Preserve README.md.',
      criteria: ['A', 'B', 'JOIN']
    });
    change('design_submit', parent.id);
    change('design_decide', parent.id, {
      designId: current(parent.id).designId,
      decision: 'APPROVED',
      reason: 'Automated integration fixture approval only'
    });
    let plan = change(
      'plan_apply',
      parent.id,
      {
        designId: current(parent.id).designId,
        mode: 'DRAFT',
        tasks: [
          {
            ref: 'a',
            title: '[Feature] A: deliver exact text -> accepted artifact',
            description: 'Create a.txt with the specified exact bytes',
            criteria: ['A'],
            assigneeId: workers[0].actor.id,
            harness: 'codex'
          },
          {
            ref: 'b',
            title: '[Feature] B: deliver exact text -> accepted artifact',
            description: 'Create b.txt with the specified exact bytes',
            criteria: ['B'],
            assigneeId: workers[1].actor.id,
            harness: 'claude-code'
          },
          {
            ref: 'obsolete',
            title: '[Feature] Legacy A: deliver text -> superseded route',
            description: 'Superseded implementation route for a.txt',
            criteria: ['A']
          }
        ],
        integrationCriteria: ['JOIN'],
        reason: 'Automated PM fixture decomposition, not product acceptance'
      },
      pm
    );
    const ids = [plan.taskIds.a, plan.taskIds.b] as string[];
    const obsoleteId = plan.taskIds.obsolete as string;
    change('issue_transition',obsoleteId,{ action: 'abandon',reason: 'Automated fixture replaces the implementation route, not the requirement' });
    const scope = flow.execute(human,'scope_get',{ workspaceId: workspace.id,issueId: parent.id,limit: 100 }) as any;
    const target = scope.children.find((v: any) => v.issue.id === obsoleteId);
    const replacement = scope.children.find((v: any) => v.issue.id === ids[0]);
    const exclusion = change('scope_decide',obsoleteId,{ expectedParentVersion: scope.issue.version,designId: scope.design.id,scopeHash: scope.scopeHash,childScopeHash: target.scopeHash,action: 'REPLACE',replacements: [{ issueId: replacement.issue.id,expectedVersion: replacement.issue.version,scopeHash: replacement.scopeHash }],reason: 'Automated fixture human scope approval; not product acceptance' }).decision;
    const ready = applyFixturePlan(flow,pm,parent.id);
    plan = { ...plan,plan: ready.plan };
    assert.equal(ready.coverage.children.excluded,1);
    assert.equal(ready.coverage.children.inScope,2);
    const profiles = [['A'], ['B'], ['A', 'B', 'JOIN']].map(
      (criteria, index) =>
        run('check_profile_create', {
          name: `Fixture check ${index}`,
          command: process.execPath,
          args: ['.qa/check.mjs'],
          criteria,
          timeoutMs: 5000
        }).profile
    );
    for (let index = 0; index < ids.length; index++)
      change('qa_configure', ids[index]!, { actorId: qa.id, harness: 'dsh', checkProfileIds: [profiles[index].id] });
    const adapter = new IntegrationProviderDouble();
    const app = createServer(store);
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const coordinator = new Coordinator(store, {
      endpoint,
      directory: join(directory, 'runs'),
      bridgeScript: resolve('dist/cli.js'),
      adapter,
      concurrency: 2
    });
    let bridge: Client | undefined;
    const client = (context: AdapterContext) => new LocalClient(endpoint, context.token);
    const finish = async (context: AdapterContext) => {
      const actor = store.authenticate(context.token);
      const id = actor.runId!;
      adapter.finish.get(context.cwd)!({ outcome: 'succeeded' });
      await until(() => ['SUCCEEDED', 'FAILED'].includes(store.get<Run>('run', id).state));
      assert.equal(store.get<Run>('run', id).state, 'SUCCEEDED');
    };
    const dispatch = (id: string) =>
      change(
        'work_dispatch',
        id,
        { designId: current(parent.id).designId, scopeRevision: current(id).scopeRevision },
        pm
      );
    const submit = async (context: AdapterContext, id: string, files: string[]) => {
      await client(context).command('work_submit', {
        workspaceId: workspace.id,
        issueId: id,
        expectedVersion: current(id).version,
        fence: current(id).fence,
        files,
        summary: 'Automated adapter fixture; actual sealed files and independent Node checks',
        idempotencyKey: randomUUID()
      });
      await finish(context);
    };
    const review = (id: string) =>
      change(
        'review_submit',
        id,
        {
          candidateId: current(id).candidate!.id,
          verdict: 'PASS',
          reason: 'Automated exact-snapshot lead fixture review'
        },
        lead
      );
    const accept = (id: string) =>
      change('delivery_decide', id, {
        candidateId: current(id).candidate!.id,
        digest: run('issue_get', { issueId: id }).deliveryDigest,
        decision: 'ACCEPT',
        reason: 'Automated fixture decision, not real user acceptance'
      });
    const testQa = async (context: AdapterContext, id: string, profileId: string, script: string, pass = true) => {
      mkdirSync(join(context.cwd, '.qa'));
      writeFileSync(join(context.cwd, '.qa/check.mjs'), script);
      const queued = await client(context).command('qa_check_run', {
        workspaceId: workspace.id,
        issueId: id,
        expectedVersion: current(id).version,
        profileId,
        testFiles: ['.qa/check.mjs'],
        idempotencyKey: randomUUID()
      });
      await until(() => ['PASSED', 'FAILED'].includes(store.get<CheckRun>('check', queued.check.id).state));
      const check = store.get<CheckRun>('check', queued.check.id);
      assert.equal(check.state, pass ? 'PASSED' : 'FAILED');
      assert.equal(check.exitCode, pass ? 0 : 1);
      await client(context).command('qa_report_submit', {
        workspaceId: workspace.id,
        issueId: id,
        expectedVersion: current(id).version,
        candidateId: current(id).candidate!.id,
        verdict: pass ? 'PASS' : 'FAIL',
        summary: 'Actual independent Node assertion result in this snapshot',
        results: current(id).criteria.map((criterionId) => ({
          criterionId,
          result: pass ? 'PASS' : criterionId === 'JOIN' ? 'FAIL' : 'BLOCKED',
          evidenceIds: [check.id],
          reason:
            pass || criterionId === 'JOIN'
              ? 'Captured script checks the actual assembled bytes'
              : 'The aggregate command failed; no separately captured passing result is available'
        })),
        findings: pass
          ? []
          : [
              {
                criterionId: 'JOIN',
                severity: 'MAJOR',
                expected: 'combined.txt equals a.txt then b.txt',
                actual: 'combined.txt is incomplete',
                reproduce: 'Run the captured .qa/check.mjs against this sealed snapshot'
              }
            ],
        idempotencyKey: randomUUID()
      });
      await finish(context);
      return check;
    };
    const checkScript = (body: string) =>
      `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';${body};assert.equal(readFileSync('README.md','utf8'),'base\\n');console.log('actual integration check passed');`;
    try {
      ids.forEach(dispatch);
      await coordinator.start();
      await until(() => adapter.contexts.length === 2);
      const aText = 'A \u20ac\n';
      const bText = 'B\n';
      for (let index = 0; index < 2; index++) {
        const context = adapter.contexts[index]!;
        const actor = store.authenticate(context.token);
        const id = store.get<Run>('run', actor.runId!).issueId;
        const isA = id === ids[0];
        writeFileSync(join(context.cwd, isA ? 'a.txt' : 'b.txt'), isA ? aText : bText);
        await submit(context, id, [isA ? 'a.txt' : 'b.txt']);
      }
      ids.forEach(review);
      await until(() => adapter.contexts.length === 4);
      for (const context of adapter.contexts.slice(2, 4)) {
        const id = store.get<Run>('run', store.authenticate(context.token).runId!).issueId;
        const index = ids.indexOf(id);
        const file = index === 0 ? 'a.txt' : 'b.txt';
        await testQa(
          context,
          id,
          profiles[index].id,
          checkScript(`assert.equal(readFileSync('${file}','utf8'),${JSON.stringify(index === 0 ? aText : bText)})`)
        );
        review(id);
        assert.equal(accept(id).issue.state, 'DONE');
      }
      assert.equal(current(parent.id).state, 'IN_PROGRESS');
      assert.equal(current(parent.id).candidate, null);
      assert.equal(store.list<Run>('run').filter((r) => r.issueId === parent.id).length, 0);
      change('issue_assign', parent.id, { actorId: workers[2].actor.id, harness: 'dsh' });
      change('qa_configure', parent.id, { actorId: qa.id, harness: 'codex', checkProfileIds: [profiles[2].id] });
      dispatch(parent.id);
      await until(() => adapter.contexts.length === 5);
      const integration = adapter.contexts[4]!;
      assert.match(integration.prompt, /parent integration assignment/);
      bridge = new Client({ name: 'integration-fixture', version: '0.1.0' });
      const env = Object.fromEntries(
        Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined)
      );
      await bridge.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', resolve('src/cli.ts'), 'mcp'],
          cwd: resolve('.'),
          env: { ...env, AGILEDEV_ENDPOINT: endpoint, AGILEDEV_TOKEN: integration.token },
          stderr: 'pipe'
        })
      );
      const catalogue = await bridge.listTools();
      assert.equal(catalogue.tools.some(t => t.name === 'scope_decide'),false);
      assert.equal(catalogue.tools.some(t => t.name === 'work_reconcile'),false);
      assert.equal(catalogue.tools.find(t => t.name === 'scope_get')?.annotations?.readOnlyHint,true);
      const packet = (
        await bridge.callTool({ name: 'integration_get', arguments: { workspaceId: workspace.id, issueId: parent.id } })
      ).structuredContent as any;
      assert.equal(packet.manifest.children.length, 2);
      assert.equal(packet.manifest.planScopeHash, plan.plan.scopeHash);
      assert.deepEqual(packet.manifest.excluded,[{ issueId: obsoleteId,decisionId: exclusion.id,decisionHash: exclusion.hash,replacementIds: [ids[0]] }]);
      for (let index = 0; index < 2; index++) {
        const entry = packet.manifest.children.find((child: any) => child.issueId === ids[index]);
        const path = index === 0 ? 'a.txt' : 'b.txt';
        const read = (
          await bridge.callTool({
            name: 'artifact_read',
            arguments: { workspaceId: workspace.id, issueId: parent.id, snapshotId: entry.snapshotId, path }
          })
        ).structuredContent as any;
        assert.equal(read.content, index === 0 ? aText : bText);
        assert.ok(!('root' in read));
        writeFileSync(join(integration.cwd, path), read.content);
        const escape = await bridge.callTool({
          name: 'artifact_read',
          arguments: {
            workspaceId: workspace.id,
            issueId: parent.id,
            snapshotId: entry.snapshotId,
            path: '../private.json'
          }
        });
        assert.equal(escape.isError, true);
        if (index === 0) {
          const utf8 = await bridge.callTool({
            name: 'artifact_read',
            arguments: {
              workspaceId: workspace.id,
              issueId: parent.id,
              snapshotId: entry.snapshotId,
              path,
              offset: 2,
              limit: 1
            }
          });
          assert.match(JSON.stringify(utf8.content), /ENCODING_INVALID/);
          const binary = (
            await bridge.callTool({
              name: 'artifact_read',
              arguments: {
                workspaceId: workspace.id,
                issueId: parent.id,
                snapshotId: entry.snapshotId,
                path,
                offset: 2,
                limit: 1,
                encoding: 'base64'
              }
            })
          ).structuredContent as any;
          assert.equal(binary.content, Buffer.from(aText).subarray(2, 3).toString('base64'));
          assert.equal(binary.nextOffset, 3);
        }
      }
      assert.throws(
        () =>
          run('issue_create', {
            parentId: parent.id,
            expectedParentVersion: current(parent.id).version,
            title: '[Test] Late: add scope -> stale live integration'
          }),
        (error: any) => error.code === 'RUN_EXISTS'
      );
      writeFileSync(join(integration.cwd, 'combined.txt'), aText);
      await bridge.close();
      bridge = undefined;
      await submit(integration, parent.id, ['combined.txt', 'a.txt', 'b.txt']);
      const firstCandidate = current(parent.id).candidate!;
      assert.equal(firstCandidate.integration!.children.length, 2);
      assert.equal(firstCandidate.integration!.excluded![0]!.decisionId,exclusion.id);
      await assert.rejects(
        new LocalClient(endpoint, workers[0].token).command('artifact_read', {
          workspaceId: workspace.id,
          issueId: parent.id,
          snapshotId: firstCandidate.snapshotId,
          path: 'combined.txt'
        }),
        (error: any) => error.code === 'SCOPE_DENIED'
      );
      review(parent.id);
      await until(() => adapter.contexts.length === 6);
      const assembledCheck = checkScript(
        `assert.equal(readFileSync('a.txt','utf8'),${JSON.stringify(aText)});assert.equal(readFileSync('b.txt','utf8'),${JSON.stringify(bText)});assert.equal(readFileSync('combined.txt','utf8'),readFileSync('a.txt','utf8')+readFileSync('b.txt','utf8'))`
      );
      await testQa(adapter.contexts[5]!, parent.id, profiles[2].id, assembledCheck, false);
      assert.equal(current(parent.id).state, 'QA_REJECTED');
      assert.equal(
        store.list<any>('defect', workspace.id).filter((d) => d.issueId === parent.id && d.state === 'OPEN').length,
        1
      );
      dispatch(parent.id);
      await until(() => adapter.contexts.length === 7);
      const rework = adapter.contexts[6]!;
      writeFileSync(join(rework.cwd, 'a.txt'), aText);
      writeFileSync(join(rework.cwd, 'b.txt'), bText);
      writeFileSync(join(rework.cwd, 'combined.txt'), aText + bText);
      await submit(rework, parent.id, ['combined.txt', 'a.txt', 'b.txt']);
      assert.notEqual(current(parent.id).candidate!.id, firstCandidate.id);
      review(parent.id);
      await until(() => adapter.contexts.length === 8);
      await testQa(adapter.contexts[7]!, parent.id, profiles[2].id, assembledCheck);
      review(parent.id);
      const digest = run('issue_get', { issueId: parent.id }).deliveryDigest;
      applyFixturePlan(flow, pm, parent.id);
      assert.equal(run('issue_get', { issueId: parent.id }).deliveryDigest, digest);
      assert.equal(accept(parent.id).issue.state, 'DONE');
      assert.equal(readFileSync(join(source, 'README.md'), 'utf8'), 'base\n');
      assert.deepEqual(readdirSync(source), ['README.md']);
      assert.deepEqual(
        store
          .list<Run>('run')
          .filter((r) => r.issueId === parent.id && r.kind !== 'qa')
          .map((r) => r.state),
        ['SUCCEEDED', 'SUCCEEDED']
      );
      assert.throws(
        () =>
          run('issue_create', {
            parentId: parent.id,
            expectedParentVersion: current(parent.id).version,
            title: '[Test] Late: add scope -> explicit reopen required'
          }),
        (error: any) => error.code === 'PARENT_CLOSED'
      );
      const accepted = store.list('delivery_approval', workspace.id).length;
      change('issue_transition', ids[0]!, {
        action: 'reopen',
        reason: 'Automated fixture reopens a child and its affected parent integration'
      });
      assert.equal(current(parent.id).state, 'IN_PROGRESS');
      assert.equal(current(parent.id).candidate, null);
      assert.equal(store.list('delivery_approval', workspace.id).length, accepted);
      assert.throws(
        () => dispatch(parent.id),
        (error: any) => error.code === 'NOT_READY'
      );
      assert.throws(
        () =>
          change('delivery_decide', parent.id, {
            candidateId: firstCandidate.id,
            digest,
            decision: 'ACCEPT',
            reason: 'Old integration acceptance cannot survive a reopened child'
          }),
        (error: any) => error.code === 'APPROVAL_STALE'
      );
    } finally {
      await bridge?.close();
      await coordinator.close();
      await app.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
