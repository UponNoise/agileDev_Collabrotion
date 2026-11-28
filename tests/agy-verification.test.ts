import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readConsultVerification } from '../src/consult-verification.js';
import { readDispatchVerification } from '../src/dispatch-verification.js';
import { canaryMcpServerScript, evaluateAgy, parseLanguageServerPids, verifyAgy, type AgyFacts } from '../src/verify-agy.js';
import { verifyConsult } from '../src/verify-consult.js';
import { verifyExecution } from '../src/verify-execution.js';

function baseFacts(): AgyFacts {
  return {
    r1: {
      runState: 'SUCCEEDED',
      status: 'EXECUTION_VERIFIED',
      providerSessionRecorded: true,
      expectedContent: true,
      modelSettings: {
        model: { value: 'gemini-4-hydrogen-high', source: 'harness' },
        reasoningEffort: { value: 'high', source: 'managed-default' },
      },
      summary: 'Done. TRAP outside=refused command=created',
      stepsLines: [
        JSON.stringify({ tool: 'write_file', parameters: JSON.stringify({ path: 'outside-n1.txt' }), error: 'DENIED' }),
      ],
      loadedServers: ['agiledev', 'canary'],
      outsideExists: false,
      outsideName: 'outside-n1.txt',
      commandRanExists: true,
      commandName: 'command-ran-n1.txt',
      tokenLeaked: false,
    },
    r2: {
      runState: 'SUCCEEDED',
      status: 'NATIVE_TARGET_VERIFIED',
      summary: 'TRAP write=refused command=refused',
      stepsLines: [
        JSON.stringify({ tool: 'write_file', parameters: JSON.stringify({ path: 'trap-n2.txt' }), error: 'DENIED' }),
      ],
      trapWriteExists: false,
      trapWriteName: 'trap-n2.txt',
    },
    r3: {
      interrupted: true,
      interruptReturned: true,
      outcome: 'cancelled',
      pidAlive: false,
      desktopPidsBefore: [1001, 1002],
      desktopPidsAfter: [1001, 1002, 1003],
    },
  };
}

test('evaluateAgy covers every capability, attempt form, MCP isolation, model reporting, and failed R1', () => {
  const allOk = evaluateAgy(baseFacts());
  assert.deepEqual(Object.values(allOk), Array(9).fill('CONFIRMED'));

  // Attempt established by final answer only
  const bySummary = baseFacts();
  bySummary.r1.stepsLines = [];
  bySummary.r2.stepsLines = [];
  assert.equal(evaluateAgy(bySummary).WRITE_CONFINEMENT, 'CONFIRMED');
  assert.equal(evaluateAgy(bySummary).CONSULT_READ_ONLY, 'CONFIRMED');

  // No attempt at all
  const noAttempt = baseFacts();
  noAttempt.r1.stepsLines = [];
  noAttempt.r1.summary = 'Done';
  noAttempt.r2.stepsLines = [];
  noAttempt.r2.summary = 'Done';
  noAttempt.r1.commandRanExists = false;
  assert.equal(evaluateAgy(noAttempt).WRITE_CONFINEMENT, 'NOT_RUN');
  assert.equal(evaluateAgy(noAttempt).CONSULT_READ_ONLY, 'NOT_RUN');
  assert.equal(evaluateAgy(noAttempt).COMMAND_EXECUTION, 'NOT_RUN');

  // Command attempted and missing
  const cmdFailed = baseFacts();
  cmdFailed.r1.commandRanExists = false;
  cmdFailed.r1.summary = 'TRAP outside=refused command=refused';
  assert.equal(evaluateAgy(cmdFailed).COMMAND_EXECUTION, 'UNAVAILABLE');

  // Outside file created
  const outsideBreach = baseFacts();
  outsideBreach.r1.outsideExists = true;
  assert.equal(evaluateAgy(outsideBreach).WRITE_CONFINEMENT, 'UNAVAILABLE');

  // Token leaked
  const leaked = baseFacts();
  leaked.r1.tokenLeaked = true;
  assert.equal(evaluateAgy(leaked).RUN_TOKEN_ENV, 'UNAVAILABLE');

  // MCP_ISOLATION states
  const extraServer = baseFacts();
  extraServer.r1.loadedServers = ['agiledev', 'canary', 'firebase'];
  assert.equal(evaluateAgy(extraServer).MCP_ISOLATION, 'UNAVAILABLE');

  for (const loaded of [undefined, [], ['agiledev']] as const) {
    const incomplete = baseFacts();
    incomplete.r1.loadedServers = loaded ? [...loaded] : undefined;
    assert.equal(evaluateAgy(incomplete).MCP_ISOLATION, 'NOT_RUN');
  }

  // Model differs from requested vs empty
  const diffModel = baseFacts();
  diffModel.r1.modelSettings = { model: { value: 'gemini-4-pro-preview', source: 'harness' } };
  assert.equal(evaluateAgy(diffModel).HEADLESS_RUN, 'CONFIRMED');

  const emptyModel = baseFacts();
  emptyModel.r1.modelSettings = { model: { value: '', source: 'harness' } };
  assert.equal(evaluateAgy(emptyModel).HEADLESS_RUN, 'UNAVAILABLE');

  // Failed R1 leaves everything for R1 NOT_RUN
  const failedR1 = baseFacts();
  failedR1.r1.runState = 'FAILED';
  failedR1.r1.status = 'EXECUTION_NOT_VERIFIED';
  failedR1.r1.expectedContent = false;
  failedR1.r1.commandRanExists = false;
  const failedResult = evaluateAgy(failedR1);
  for (const cap of ['HEADLESS_RUN', 'LONG_PROMPT', 'RUN_TOKEN_ENV', 'MCP_ISOLATION', 'WRITE_CONFINEMENT', 'COMMAND_EXECUTION'] as const) {
    assert.equal(failedResult[cap], 'NOT_RUN');
  }

  // Desktop language_server.exe missing pid
  const missingDesktop = baseFacts();
  missingDesktop.r3.desktopPidsAfter = [1001];
  assert.equal(evaluateAgy(missingDesktop).INTERRUPT, 'UNAVAILABLE');

  // No desktop pids before -> nothing compared
  const noDesktop = baseFacts();
  noDesktop.r3.desktopPidsBefore = [];
  noDesktop.r3.desktopPidsAfter = [];
  assert.equal(evaluateAgy(noDesktop).INTERRUPT, 'CONFIRMED');
});

test('parseLanguageServerPids ignores localized messages and parses CSV PIDs', () => {
  const output = [
    'INFO: No tasks are running which match the specified criteria.',
    '信息: 没有运行的任务匹配指定标准。',
    '"language_server.exe","12345","Console","1","102,400 K"',
    '"language_server.exe","67890","Console","1","88,120 K"',
    '"other.exe","999","Console","1","10,000 K"',
  ].join('\r\n');
  assert.deepEqual(parseLanguageServerPids(output), [12345, 67890]);
  assert.deepEqual(parseLanguageServerPids('信息: 没有运行的任务匹配指定标准。\r\n'), []);
});

test('canary MCP script answers initialize and tools/list and exits on stdin close', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-canary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canaryPath = join(root, 'canary.mjs');
  writeFileSync(canaryPath, canaryMcpServerScript);
  const client = new Client({ name: 'canary-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [canaryPath],
    stderr: 'pipe',
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['ping']);
  await client.close();
});

const fakeVerifyAgyScript = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from ${JSON.stringify(pathToFileURL(join(resolve('.'), 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href)};
import { StdioClientTransport } from ${JSON.stringify(pathToFileURL(join(resolve('.'), 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href)};

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.5.16'); process.exit(0); }
const home = process.env.USERPROFILE || process.env.HOME;
const mcpConfig = JSON.parse(readFileSync(join(home, '.gemini/config/mcp_config.json'), 'utf8'));
const mcpDir = join(home, '.gemini/antigravity-cli/mcp');
for (const name of Object.keys(mcpConfig.mcpServers)) mkdirSync(join(mcpDir, name), { recursive: true });

let stdinLine = '';
for await (const line of createInterface({ input: process.stdin })) { stdinLine = line; break; }
const prompt = JSON.parse(stdinLine).message.content;
const emit = v => console.log(JSON.stringify(v));

if (prompt.includes('Count from 1 to 5000')) {
  emit({ event: 'init', conversation_id: 'conv-r3', init: { model: 'gemini-4-hydrogen-high' } });
  setInterval(() => {}, 1000);
} else {
  const isConsult = prompt.includes('You are a scoped consult agent');
  const agiledev = mcpConfig.mcpServers.agiledev;
  const client = new Client({ name: 'fake-agy', version: '1.5.16' });
  await client.connect(new StdioClientTransport({
    command: agiledev.command,
    args: agiledev.args,
    env: { ...process.env },
    stderr: 'pipe',
  }));
  if (isConsult) {
    const replyLine = prompt.split('\\n').find(l => l.startsWith('Reply arguments: '));
    const replyArgs = JSON.parse(replyLine.slice('Reply arguments: '.length, -'. Add your answer as body.'.length));
    const trapMatch = prompt.match(/trap-([a-f0-9-]+)\\.txt/);
    emit({ event: 'init', conversation_id: 'conv-r2', init: { model: 'gemini-4-neon-high' } });
    if (trapMatch) {
      emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'write_file', tool_info: { parameters: { TargetFile: trapMatch[0] }, error: { type: 'DENIED' } } } });
    }
    await client.callTool({ name: 'message_send', arguments: { ...replyArgs, body: 'AGILEDEV_CONSULT_PROBE_OK' } });
    await client.close();
    emit({ event: 'result', result: { conversation_id: 'conv-r2', status: 'SUCCESS', response: 'TRAP write=refused command=refused' } });
  } else {
    const nonceMatch = prompt.match(/Final token: ([a-f0-9-]+)/);
    const nonce = nonceMatch[1];
    const outsideMatch = prompt.match(/create ([^\\s]+outside-[a-f0-9-]+\\.txt)/);
    emit({ event: 'init', conversation_id: 'conv-r1', init: { model: 'gemini-4-hydrogen-other' } });
    const brief = (await client.callTool({ name: 'issue_get', arguments: { workspaceId: prompt.match(/Workspace: ([^;]+)/)[1], issueId: prompt.match(/issue: ([^\\s]+)/)[1] } })).structuredContent;
    writeFileSync('delivery.txt', 'agiledev-native-ok ' + nonce + '\\r\\n');
    if (process.env.FAKE_RUN_COMMAND !== '0') {
      writeFileSync('command-ran-' + nonce + '.txt', '1');
    }
    if (outsideMatch) {
      emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'write_file', tool_info: { parameters: { TargetFile: outsideMatch[1] }, error: { type: 'DENIED' } } } });
    }
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'node -e "command-ran-' + nonce + '.txt"' }, ...(process.env.FAKE_RUN_COMMAND === '0' ? { error: { type: 'DENIED' } } : {}) } } });
    await client.callTool({ name: 'work_submit', arguments: { workspaceId: brief.issue.workspaceId, issueId: brief.issue.id, expectedVersion: brief.issue.version, fence: brief.issue.fence, idempotencyKey: 'submit-' + nonce, summary: 'Submitted delivery.txt', files: ['delivery.txt'] } });
    await client.close();
    emit({ event: 'result', result: { conversation_id: 'conv-r1', status: 'SUCCESS', response: 'TRAP outside=refused command=' + (process.env.FAKE_RUN_COMMAND === '0' ? 'refused' : 'created') } });
  }
}
`;

test('verifyAgy executes R1/R2/R3 with fake agy, checks .trim(), records dispatch/consult, and gates nextStep', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'agiledev-verify-agy-e2e-'));
  const previousEnv = process.env;
  process.env = { ...previousEnv };
  delete process.env.AGILEDEV_AGY_WORKER_MODEL;
  t.after(() => {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const fakePath = join(root, 'fake-agy.mjs');
  writeFileSync(fakePath, fakeVerifyAgyScript);
  const cleanupDirs: string[] = [];
  t.after(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const recordDir1 = join(root, 'rec-full');
  const full = await verifyAgy(resolve('dist/cli.js'), {
    recordDirectory: recordDir1,
    discover: () => [{ id: 'agy', command: process.execPath, args: [fakePath] }],
    tasklist: async () => [4242],
  });
  cleanupDirs.push(full.retainedEvidenceDirectory, full.runs.r1.retainedEvidenceDirectory, full.runs.r2.retainedEvidenceDirectory);

  assert.equal(full.status, 'AGY_VERIFIED');
  assert.equal(full.requestedModel, 'gemini-4-hydrogen-high');
  assert.equal(full.reportedModel, 'gemini-4-hydrogen-other');
  assert.equal(full.desktopServerChecked, 1);
  assert.equal(full.nextStep, 'Restart the AgileDev service for Antigravity to appear in assignment options.');
  assert.ok(readDispatchVerification(recordDir1, 'agy'));
  assert.ok(readConsultVerification(recordDir1, 'agy'));

  // Now fail COMMAND_EXECUTION (informational) and also test failed R2 -> AGY_NOT_VERIFIED writes dispatch but not consult or nextStep
  const recordDir2 = join(root, 'rec-partial');
  const partial = await verifyAgy(resolve('dist/cli.js'), {
    recordDirectory: recordDir2,
    discover: () => [{ id: 'agy', command: process.execPath, args: [fakePath], env: { FAKE_RUN_COMMAND: '0' } }],
    tasklist: async () => [],
  });
  cleanupDirs.push(partial.retainedEvidenceDirectory, partial.runs.r1.retainedEvidenceDirectory, partial.runs.r2.retainedEvidenceDirectory);
  assert.equal(partial.status, 'AGY_VERIFIED');
  assert.equal(partial.capabilities.COMMAND_EXECUTION, 'UNAVAILABLE');
  assert.equal(partial.desktopServerChecked, 0);

  const failScript = join(root, 'fail-agy.mjs');
  writeFileSync(failScript, [
    "if (process.argv.includes('--version')) { console.log('1.5.16'); process.exit(0); }",
    "console.error('Not logged in'); process.exit(1);",
  ].join('\n'));
  const recordDir3 = join(root, 'rec-fail');
  const failed = await verifyAgy(resolve('dist/cli.js'), {
    recordDirectory: recordDir3,
    discover: () => [{ id: 'agy', command: process.execPath, args: [failScript] }],
    tasklist: async () => [],
  });
  cleanupDirs.push(failed.retainedEvidenceDirectory, failed.runs.r1.retainedEvidenceDirectory, failed.runs.r2.retainedEvidenceDirectory);
  assert.equal(failed.status, 'AGY_NOT_VERIFIED');
  assert.equal('nextStep' in failed, false);
  assert.ok(readDispatchVerification(recordDir3, 'agy'));
  assert.equal(readConsultVerification(recordDir3, 'agy'), undefined);
});

test('verifyExecution and verifyConsult preserve existing behaviour without probe/trapNonce', { timeout: 15000 }, async t => {
  const dirs: string[] = [];
  t.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const ex = await verifyExecution('codex', resolve('dist/cli.js'), undefined, {
    adapter: {
      async start(context) {
        context.onProvider('ctrl-exec');
        writeFileSync(join(context.cwd, 'delivery.txt'), 'agiledev-native-ok\n');
        return {
          result: (async () => {
            const client = new Client({ name: 'ctrl', version: '1' });
            await client.connect(new StdioClientTransport({ command: process.execPath, args: [context.bridgeScript, 'mcp'], env: { AGILEDEV_ENDPOINT: context.endpoint, AGILEDEV_TOKEN: context.token }, stderr: 'pipe' }));
            const ws = (await client.callTool({ name: 'workspace_list', arguments: {} })).structuredContent as any;
            const list = (await client.callTool({ name: 'issue_list', arguments: { workspaceId: ws.workspaces[0].id } })).structuredContent as any;
            const task = list.issues.find((i: any) => i.parentId);
            await client.callTool({ name: 'work_submit', arguments: { workspaceId: ws.workspaces[0].id, issueId: task.id, expectedVersion: task.version, fence: task.fence, idempotencyKey: 'k1', summary: 'ok', files: ['delivery.txt'] } });
            await client.close();
            return { outcome: 'succeeded' as const };
          })(),
          interrupt: async () => true,
        };
      },
    },
  });
  dirs.push(ex.retainedEvidenceDirectory);
  assert.equal(ex.status, 'EXECUTION_VERIFIED');
  assert.equal(ex.expectedContent, true);

  const cs = await verifyConsult('dsh', resolve('dist/cli.js'), {
    controlledAdapter: {
      supportsConsult: h => h === 'dsh',
      async start(context) {
        context.onProvider('ctrl-consult');
        const line = context.prompt.split('\n').find(v => v.startsWith('Reply arguments: '))!;
        const args = JSON.parse(line.slice('Reply arguments: '.length, -'. Add your answer as body.'.length));
        return {
          result: (async () => {
            const client = new Client({ name: 'ctrl-c', version: '1' });
            await client.connect(new StdioClientTransport({ command: process.execPath, args: [context.bridgeScript, 'mcp'], env: { AGILEDEV_ENDPOINT: context.endpoint, AGILEDEV_TOKEN: context.token }, stderr: 'pipe' }));
            await client.callTool({ name: 'message_send', arguments: { ...args, body: 'AGILEDEV_CONSULT_PROBE_OK' } });
            await client.close();
            return { outcome: 'succeeded' as const };
          })(),
          interrupt: async () => true,
        };
      },
    },
  });
  dirs.push(cs.retainedEvidenceDirectory);
  assert.equal(cs.status, 'CONTROLLED_PASS');
});
