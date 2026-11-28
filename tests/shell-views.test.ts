import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLocation, resolveLegacyRedirect, routeUrl, SETTINGS_SECTIONS } from '../web/routes.ts';
import {
  boardColumns,
  enrichHistoryEvents,
  formatElapsed,
  inferAgentHarness,
  issueSteps,
  issueStatusForWorkspace,
  moreActionsForIssue,
  requirementProgress
} from '../web/work-model.ts';
import { translate } from '../web/locales.ts';
import { renderSentence } from '../web/sentences.ts';
import type { DisplayIssue, InboxEntry, IssueData, WorkspaceData } from '../web/api.ts';
import type { Actor } from '../src/contracts.ts';

function makeIssue(overrides: Partial<DisplayIssue>): DisplayIssue {
  return {
    id: 'iss-1',
    workspaceId: 'ws-1',
    key: 'APP-0001',
    parentId: null,
    title: 'Requirement one',
    titleSuffix: 'Requirement one',
    url: '/w/ws-1/issues/iss-1',
    description: 'Desc',
    state: 'NOT_STARTED',
    stage: null,
    version: 1,
    scopeRevision: 1,
    criteria: [],
    assignee: null,
    harness: null,
    dependencies: [],
    priority: 2,
    plannedStart: null,
    dueDate: null,
    designId: null,
    fence: 0,
    lease: null,
    candidate: null,
    initialReview: null,
    qaReview: null,
    finalReview: null,
    savedState: null,
    ...overrides
  };
}

test('routes parse only the three destinations and canonical URLs round-trip', () => {
  assert.deepEqual(parseLocation('/', ''), {
    route: { dest: 'decisions', workspaceId: null, entryId: null, issueId: null, kind: null },
    legacy: null
  });
  assert.deepEqual(parseLocation('/', '?view=work&workspace=ws-1'), {
    route: { dest: 'work', workspaceId: 'ws-1', mode: 'list', issueId: null },
    legacy: null
  });
  assert.deepEqual(parseLocation('/', '?view=board&workspace=ws-1'), {
    route: { dest: 'work', workspaceId: 'ws-1', mode: 'board', issueId: null },
    legacy: null
  });
  assert.deepEqual(parseLocation('/w/ws-1/issues/iss-2', ''), {
    route: { dest: 'work', workspaceId: 'ws-1', mode: 'list', issueId: 'iss-2' },
    legacy: null
  });
  assert.deepEqual(parseLocation('/', '?view=settings&workspace=ws-1&section=agents'), {
    route: { dest: 'settings', workspaceId: 'ws-1', section: 'agents', runId: null },
    legacy: null
  });
  assert.deepEqual(parseLocation('/', '?view=settings&section=unknown'), {
    route: { dest: 'settings', workspaceId: null, section: 'general', runId: null },
    legacy: null
  });
  assert.equal(SETTINGS_SECTIONS.length, 6);
  assert.equal(routeUrl({ dest: 'work', workspaceId: 'ws-1', mode: 'list', issueId: 'iss-2' }), '/w/ws-1/issues/iss-2');
  assert.equal(routeUrl({ dest: 'work', workspaceId: 'ws-1', mode: 'board', issueId: null }), '/?workspace=ws-1&view=board');
  assert.equal(
    routeUrl({ dest: 'settings', workspaceId: 'ws-1', section: 'runs', runId: 'run-9' }),
    '/?workspace=ws-1&view=settings&section=runs&run=run-9'
  );
});

test('old deep links redirect to the matching card, issue or settings run', () => {
  const entries: Pick<InboxEntry, 'id' | 'workspaceId' | 'issueId' | 'kind' | 'target'>[] = [
    { id: 'e-rev', workspaceId: 'ws-1', issueId: 'iss-1', kind: 'DELIVERY_ACCEPTANCE', target: { issueVersion: 2, revisionHash: null } },
    { id: 'e-run', workspaceId: 'ws-1', issueId: 'iss-2', kind: 'RUN_RECONCILE', target: { issueVersion: 3, revisionHash: null, runId: 'run-lost' } }
  ];

  const revIssue = parseLocation('/w/ws-1/issues/iss-1', '?view=reviews');
  assert.ok(revIssue.legacy);
  assert.deepEqual(resolveLegacyRedirect(revIssue.legacy!, entries), {
    dest: 'decisions',
    workspaceId: 'ws-1',
    entryId: 'e-rev',
    issueId: 'iss-1',
    kind: 'DELIVERY_ACCEPTANCE'
  });

  const revNoCard = parseLocation('/w/ws-1/issues/iss-99', '?view=reviews');
  assert.deepEqual(resolveLegacyRedirect(revNoCard.legacy!, entries), {
    dest: 'work',
    workspaceId: 'ws-1',
    mode: 'list',
    issueId: 'iss-99'
  });

  const revList = parseLocation('/', '?view=reviews&workspace=ws-1');
  assert.deepEqual(resolveLegacyRedirect(revList.legacy!, entries), {
    dest: 'decisions',
    workspaceId: 'ws-1',
    entryId: null,
    issueId: null,
    kind: null
  });

  const runLost = parseLocation('/', '?view=runs&workspace=ws-1&run=run-lost');
  assert.deepEqual(resolveLegacyRedirect(runLost.legacy!, entries), {
    dest: 'decisions',
    workspaceId: 'ws-1',
    entryId: 'e-run',
    issueId: 'iss-2',
    kind: 'RUN_RECONCILE'
  });

  const runNormal = parseLocation('/', '?view=runs&workspace=ws-1&run=run-ok');
  assert.deepEqual(resolveLegacyRedirect(runNormal.legacy!, entries), {
    dest: 'settings',
    workspaceId: 'ws-1',
    section: 'runs',
    runId: 'run-ok'
  });

  const backlog = parseLocation('/', '?view=backlog&workspace=ws-1');
  assert.deepEqual(resolveLegacyRedirect(backlog.legacy!, entries), {
    dest: 'work',
    workspaceId: 'ws-1',
    mode: 'list',
    issueId: null
  });
});

test('board partitions tasks into six columns and lists held and abandoned separately', () => {
  const req = makeIssue({ id: 'r1', key: 'APP-0001', titleSuffix: 'Booking', state: 'IN_PROGRESS' });
  const issues = [
    req,
    makeIssue({ id: 't1', parentId: 'r1', key: 'APP-0002', titleSuffix: 'Todo task', state: 'NOT_STARTED' }),
    makeIssue({ id: 't2', parentId: 'r1', key: 'APP-0003', titleSuffix: 'Dev task', state: 'IN_PROGRESS' }),
    makeIssue({ id: 't3', parentId: 'r1', key: 'APP-0004', titleSuffix: 'Rework task', state: 'QA_REJECTED' }),
    makeIssue({ id: 't4', parentId: 'r1', key: 'APP-0005', titleSuffix: 'Initial review', state: 'LEAD_REVIEW', stage: 'PRE_QA' }),
    makeIssue({ id: 't5', parentId: 'r1', key: 'APP-0006', titleSuffix: 'Final review', state: 'LEAD_REVIEW', stage: 'FINAL' }),
    makeIssue({ id: 't6', parentId: 'r1', key: 'APP-0007', titleSuffix: 'QA task', state: 'QA_TEST' }),
    makeIssue({ id: 't7', parentId: 'r1', key: 'APP-0008', titleSuffix: 'Accept task', state: 'USER_ACCEPTANCE' }),
    makeIssue({ id: 't8', parentId: 'r1', key: 'APP-0009', titleSuffix: 'Done task', state: 'DONE' }),
    makeIssue({ id: 't9', parentId: 'r1', key: 'APP-0010', titleSuffix: 'Held task', state: 'ON_HOLD' }),
    makeIssue({ id: 't10', parentId: 'r1', key: 'APP-0011', titleSuffix: 'Gone task', state: 'ABANDONED' })
  ];
  const { columns, notOnBoard } = boardColumns(issues, '');
  assert.deepEqual(
    columns.map((column) => [column.id, column.items.map((item) => item.id)]),
    [
      ['todo', ['t1']],
      ['dev', ['t2', 't3']],
      ['review', ['t4', 't5']],
      ['qa', ['t6']],
      ['acceptance', ['t7']],
      ['done', ['t8']]
    ]
  );
  assert.deepEqual(notOnBoard.map((item) => item.id), ['t9', 't10']);
  assert.equal(boardColumns(issues, 'Final').columns[2]!.items.length, 1);
  assert.equal(boardColumns(issues, 'Final').columns[0]!.items.length, 0);
});

test('requirement progress, status sentences, steps, elapsed timer and harness inference work together', () => {
  const actors: Actor[] = [
    { id: 'a-lead', name: 'Claude Lead', role: 'lead', workspaceIds: ['ws-1'] },
    { id: 'a-pm', name: 'Claude PM', role: 'pm', workspaceIds: ['ws-1'] },
    { id: 'a-dev', name: 'Codex Dev', role: 'worker', workspaceIds: ['ws-1'] },
    { id: 'a-qa', name: 'DSH QA', role: 'qa', workspaceIds: ['ws-1'] }
  ];
  const req = makeIssue({ id: 'r1', state: 'IN_PROGRESS', designId: 'd1', planId: 'p1' });
  const t1 = makeIssue({ id: 't1', parentId: 'r1', state: 'DONE', assignee: 'a-dev', harness: 'codex' });
  const t2 = makeIssue({ id: 't2', parentId: 'r1', state: 'QA_TEST', assignee: 'a-dev', qaAssignee: 'a-qa', qaHarness: 'dsh' });
  const t3 = makeIssue({ id: 't3', parentId: 'r1', state: 'ABANDONED', scope: { status: 'EXCLUDED', decisionId: 'sd1', action: 'EXCLUDE', blocking: [] } });
  const ws: Pick<WorkspaceData, 'issues' | 'designs' | 'actors' | 'activeRuns'> = {
    issues: [req, t1, t2, t3],
    designs: [{ id: 'd1', issueId: 'r1', status: 'APPROVED' }],
    actors,
    activeRuns: [
      { id: 'run-1', issueId: 't2', kind: 'qa', state: 'RUNNING', actorId: 'a-qa', harness: 'dsh', createdAt: '2026-11-24T00:00:00Z', startedAt: '2026-11-24T00:00:00Z' }
    ]
  };
  const progress = requirementProgress('r1', ws.issues, []);
  assert.deepEqual(progress, { done: 1, total: 2, waiting: 0 });
  const roleWords = { lead: 'lead', pm: 'PM', dev: 'developer', qa: 'QA' };
  assert.equal(renderSentence(issueStatusForWorkspace(req, ws, [], roleWords), 'en'), '1 of 2 tasks done');
  assert.equal(renderSentence(issueStatusForWorkspace(t2, ws, [], roleWords), 'en'), 'DSH QA is testing');
  assert.equal(renderSentence(issueStatusForWorkspace(t2, ws, [], roleWords), 'zh-CN'), 'DSH QA 正在独立测试');
  assert.equal(renderSentence(issueStatusForWorkspace(t3, ws, [], roleWords), 'zh-CN'), '已放弃，不计入交付');

  assert.deepEqual(
    issueSteps({ parentId: 'r1', state: 'LEAD_REVIEW', stage: 'FINAL' }, 'APPROVED', false).map((s) => s.status),
    ['done', 'done', 'done', 'cur', 'todo']
  );
  assert.deepEqual(issueSteps({ parentId: 'r1', state: 'ON_HOLD', stage: null }, 'APPROVED', false), []);
  assert.equal(formatElapsed(65_000), '1:05');
  assert.equal(formatElapsed(3_665_000), '1:01:05');
  assert.equal(
    inferAgentHarness(actors[0]!, [{ id: 'c1', actorId: 'a-lead', client: { name: 'claude-code', version: '1' }, initializedAt: '2026-11-24T00:00:00Z' }], ws.issues),
    'claude-code'
  );
  assert.equal(inferAgentHarness(actors[2]!, [], ws.issues), 'codex');
});

test('Work renders the first service blocker for an unstarted task without an inbox entry', () => {
  const task = makeIssue({ id: 'task', parentId: 'requirement', state: 'NOT_STARTED' });
  const workspace = {
    issues: [task],
    designs: [],
    actors: [],
    activeRuns: [],
    blockersByIssue: new Map([['task', ['DESIGN_APPROVAL_REQUIRED', 'ASSIGNEE_REQUIRED']]])
  };
  const sentence = issueStatusForWorkspace(task, workspace, [], { lead: 'lead', pm: 'PM', dev: 'developer', qa: 'QA' });
  assert.equal(renderSentence(sentence, 'en'), 'Waiting for design approval');
  assert.equal(renderSentence(sentence, 'zh-CN'), '等设计批准');
});

test('history enrichment filters machine events, orders newest first, and resolves actor names and rejection reasons', () => {
  const actors: Actor[] = [
    { id: 'a-dev', name: 'Codex Dev', role: 'worker', workspaceIds: ['ws-1'] },
    { id: 'a-pm', name: 'Claude PM', role: 'pm', workspaceIds: ['ws-1'] }
  ];
  const events: IssueData['history'] = [
    { sequence: 1, actorId: 'a-pm', actorName: 'Claude PM', operation: 'issue_create', targetId: 'i1', data: {}, at: '2026-11-24T01:00:00Z' },
    { sequence: 2, actorId: 'a-pm', actorName: 'Claude PM', operation: 'issue_assign', targetId: 'i1', data: { changes: { assignee: { before: null, after: 'a-dev' } } }, at: '2026-11-24T01:01:00Z' },
    { sequence: 3, actorId: 'a-dev', actorName: 'Codex Dev', operation: 'work_heartbeat', targetId: 'i1', data: {}, at: '2026-11-24T01:02:00Z' },
    { sequence: 4, actorId: 'owner', actorName: 'Owner', operation: 'delivery_decide', targetId: 'i1', data: { state: 'USER_REJECTED', approvalId: 'app-1', reason: 'Fix edge case' }, at: '2026-11-24T01:03:00Z' },
    { sequence: 5, actorId: 'owner', actorName: 'Owner', operation: 'delivery_rejection_classified', targetId: 'i1', data: { approvalId: 'app-1', classification: 'DEFECT' }, at: '2026-11-24T01:03:01Z' }
  ];
  const enriched = enrichHistoryEvents(events, actors, [], { assignee: 'a-dev' }, (value) => value ?? '—');
  assert.deepEqual(
    enriched.map((item) => [item.sequence, renderSentence(item.sentence, 'en'), item.reason]),
    [
      [5, 'sent the delivery back (Needs fixes)', 'Fix edge case'],
      [2, 'assigned it to Codex Dev', null],
      [1, 'created', null]
    ]
  );
});

test('More menu lists only actions allowed by issue state', () => {
  const basePacket = (issue: DisplayIssue, extra: Partial<IssueData> = {}): IssueData => ({
    issue,
    parent: null,
    design: null,
    revision: null,
    designHistory: [],
    deliveryDigest: null,
    authorizationScopeHash: 'h',
    git: null,
    closureBlocked: [],
    readiness: { ready: false, blocking: [] },
    executionRecovery: { required: false, fence: 0, candidateId: null },
    planning: null,
    nextActions: [],
    history: [],
    nextAfter: null,
    evidence: [],
    checks: [],
    runs: [],
    snapshot: null,
    ...extra
  });

  const doneActions = moreActionsForIssue(basePacket(makeIssue({ state: 'DONE' }))).map((a) => a.id);
  assert.deepEqual(doneActions, ['reopen']);

  const heldActions = moreActionsForIssue(basePacket(makeIssue({ state: 'ON_HOLD', parentId: 'r1' }))).map((a) => a.id);
  assert.ok(heldActions.includes('resume'));
  assert.ok(heldActions.includes('abandon'));
  assert.ok(!heldActions.includes('hold'));

  const excludedActions = moreActionsForIssue(
    basePacket(
      makeIssue({
        state: 'ABANDONED',
        parentId: 'r1',
        scopeDecisionId: 'sd-1',
        scope: { status: 'EXCLUDED', decisionId: 'sd-1', action: 'EXCLUDE', blocking: [] }
      })
    )
  ).map((a) => a.id);
  assert.deepEqual(excludedActions, ['restore']);
});

test('removed legacy destinations and aging settings are absent from the T4 shell', () => {
  const app = readFileSync(new URL('../web/App.tsx', import.meta.url), 'utf8');
  const decisions = readFileSync(new URL('../web/Decisions.tsx', import.meta.url), 'utf8');
  const issuePanel = readFileSync(new URL('../web/IssuePanel.tsx', import.meta.url), 'utf8');
  const views = readFileSync(new URL('../web/WorkspaceViews.tsx', import.meta.url), 'utf8');

  assert.equal(decisions.includes('InboxSettingsForm'), false);
  assert.equal(decisions.includes('agingThresholdHours'), false);
  assert.equal(app.includes('Review queue'), false);
  assert.equal(app.includes('InboxSettingsForm'), false);
  assert.equal(views.includes('Workspace backlog'), false);
  assert.equal(issuePanel.includes('gap-panel'), false);
  assert.equal(issuePanel.includes('SCHEDULE_UNSET'), false);
});

test('every UI literal in the T4 shell files has a Chinese translation', () => {
  const files = ['App', 'WorkspaceViews', 'IssuePanel', 'Preferences', 'DesktopAttention', 'Decisions', 'IssueForms'];
  const skip = new Set(['AgileDev', 'PM', 'English', '中文', 'Codex', 'DSH', 'Claude Code']);
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(new URL(`../web/${file}.tsx`, import.meta.url), 'utf8');
    for (const call of source.matchAll(/\bt\(([^()]*)\)/g)) {
      for (const literal of call[1]!.matchAll(/'([^']*[a-z][^']*)'/g)) {
        const text = literal[1]!;
        if (skip.has(text) || /^[A-Z_]+$/.test(text) || !/^[A-Z{]/.test(text)) continue;
        if (translate('zh-CN', text) === text) missing.push(`${file}: ${text}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
