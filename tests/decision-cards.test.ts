import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  closedDefectPrimary, confirmInput, convertInput, countProblems, createIntent, decodeWindow, defectConfirm,
  deliveryChanges, deliveryChoice, firstLine, formatAge, lastDecidedRevision, matchOpenEntry, nextFromEntries,
  previewWindow, problemsOf, rejectInput, requirementDraft, rowTitle
} from '../web/card-model.ts';
import type { DeliverySnapshot, OpenEntryRef } from '../web/card-model.ts';
import { translate } from '../web/locales.ts';
import type { DecisionRiskView } from '../src/defect-contracts';

const risks = (): DecisionRiskView => ({
  hash: 'h',
  defects: [
    { id: 'd1', key: 'X-D1', version: 1, state: 'OPEN', origin: 'QA', severity: 'MINOR', criterionIds: ['C1'], reproduce: 'r', expected: 'e', actual: 'a', source: { kind: 'QA_REPORT', id: 'rep', index: 0 } },
    { id: 'd2', key: 'X-D2', version: 1, state: 'PROPOSED', origin: null, severity: 'MAJOR', criterionIds: [], reproduce: 'r', expected: 'e', actual: 'a', source: { kind: 'AGENT_PROPOSAL', id: 's' } }
  ],
  qaReport: {
    id: 'rep',
    findings: [
      { id: 'rep:0', version: 1, criterionId: 'C1', severity: 'MINOR', expected: 'e', actual: 'a', reproduce: 'r' },
      { id: 'rep:1', version: 1, criterionId: 'C2', severity: 'BLOCKER', expected: 'e', actual: 'a', reproduce: 'r' }
    ]
  }
});

test('a QA finding that already has a defect record is listed once', () => {
  const problems = problemsOf(risks());
  assert.deepEqual(problems.map((problem) => problem.id), ['rep:1', 'd2', 'd1']);
  assert.equal(problems.filter((problem) => problem.criterionIds.includes('C1')).length, 1);
  assert.deepEqual(problemsOf(null), []);
});

test('problem counts separate open, unconfirmed and blocking', () => {
  const counts = countProblems(problemsOf(risks()));
  assert.deepEqual(counts.open, { BLOCKER: 1, MAJOR: 0, MINOR: 1, INFO: 0 });
  assert.equal(counts.unconfirmed, 1);
  assert.equal(counts.openMinor, 1);
  assert.equal(counts.blocking, 1);
});

test('an open blocker or major problem makes Needs fixes the primary delivery action', () => {
  assert.deepEqual(deliveryChoice(problemsOf(risks())), { primary: 'needs-fixes', minorCount: 1 });
  const minorOnly = risks();
  minorOnly.qaReport!.findings.splice(1, 1);
  assert.deepEqual(deliveryChoice(problemsOf(minorOnly)), { primary: 'accept', minorCount: 1 });
  assert.deepEqual(deliveryChoice([]), { primary: 'accept', minorCount: 0 });
});

test('an unconfirmed report is never counted as an open problem', () => {
  const problems = problemsOf({ hash: 'h', defects: risks().defects.slice(1), qaReport: null });
  assert.deepEqual(deliveryChoice(problems), { primary: 'accept', minorCount: 0 });
  assert.equal(countProblems(problems).unconfirmed, 1);
});

test('a lost response replays the same key and changed input takes a new one', () => {
  let counter = 0;
  const intent = createIntent(() => `key-${++counter}`);
  const input = { decision: 'ACCEPT', digest: 'd' };
  assert.equal(intent.keyFor(input), 'key-1');
  assert.equal(intent.keyFor({ ...input }), 'key-1');
  assert.equal(intent.keyFor({ ...input, digest: 'e' }), 'key-2');
  intent.clear();
  assert.equal(intent.keyFor({ ...input, digest: 'e' }), 'key-3');
  intent.adopt({ a: 1 }, 'adopted');
  assert.equal(intent.keyFor({ a: 1 }), 'adopted');
});

test('file previews are bounded and honest about binary content', () => {
  assert.deepEqual(previewWindow(0, 100), { offset: 0, limit: 100 });
  assert.deepEqual(previewWindow(0, 100000), { offset: 0, limit: 16384 });
  assert.deepEqual(previewWindow(16384, 100000), { offset: 16384, limit: 65536 - 16384 });
  assert.equal(previewWindow(65536, 100000), null);
  assert.equal(previewWindow(100, 100), null);
  assert.deepEqual(decodeWindow(new TextEncoder().encode('héllo'), true), { kind: 'text', text: 'héllo' });
  assert.deepEqual(decodeWindow(new Uint8Array([0x68, 0x00, 0x69]), true), { kind: 'binary' });
  assert.deepEqual(decodeWindow(new Uint8Array([0xff, 0xfe, 0x41]), true), { kind: 'binary' });
  const split = new TextEncoder().encode('日本');
  assert.deepEqual(decodeWindow(split.subarray(0, 4), false), { kind: 'text', text: '日' });
  assert.deepEqual(decodeWindow(split.subarray(0, 4), true), { kind: 'binary' });
});

test('the confirm actions follow the delivery state and the severity', () => {
  assert.equal(defectConfirm(false, 'USER_ACCEPTANCE'), 'none');
  assert.equal(defectConfirm(true, 'USER_ACCEPTANCE'), 'acceptance');
  assert.equal(defectConfirm(true, 'DONE'), 'closed');
  assert.equal(defectConfirm(true, 'QA_TEST'), 'none');
  assert.equal(closedDefectPrimary('BLOCKER'), 'fix-now');
  assert.equal(closedDefectPrimary('MAJOR'), 'fix-now');
  assert.equal(closedDefectPrimary('MINOR'), 'fix-later');
  assert.equal(closedDefectPrimary('INFO'), 'fix-later');
});

test('triage inputs carry a reason only where the service requires one', () => {
  const base = { workspaceId: 'w', defectId: 'd', expectedVersion: 2, expectedIssueVersion: 9 };
  const observation = { kind: 'DELIVERY' };
  const confirm = confirmInput(base, 'MAJOR', observation);
  assert.equal('reason' in confirm, false);
  assert.equal('disposition' in confirm, false);
  assert.equal(confirm.action, 'CONFIRM');
  const later = confirmInput(base, 'MINOR', observation, { kind: 'DEFER' });
  assert.equal('reason' in later, false);
  assert.equal((later as { disposition?: string }).disposition, 'DEFER');
  const now = confirmInput(base, 'BLOCKER', observation, { kind: 'REOPEN', reason: 'Broken' });
  assert.equal((now as { reason?: string }).reason, 'Broken');
  assert.equal((now as { disposition?: string }).disposition, 'REOPEN');
  assert.deepEqual(rejectInput(base, 'Works as designed'), { ...base, action: 'REJECT', reason: 'Works as designed' });
  const converted = convertInput(base, 'Out of scope', 'Title', 'Body');
  assert.equal(converted.action, 'NEW_REQUIREMENT');
  assert.deepEqual(converted.requirement, { title: 'Title', description: 'Body' });
});

test('the requirement draft takes its title from the report and its text from expected and steps', () => {
  const draft = requirementDraft({ key: 'ADC-D0007', actual: '  The  button\nis missing ', expected: 'A button', reproduce: 'Open the page' });
  assert.equal(draft.title, 'Problem ADC-D0007: The button is missing');
  assert.ok(draft.description.includes('A button'));
  assert.ok(draft.description.includes('Open the page'));
  assert.ok(requirementDraft({ key: 'K', actual: 'x'.repeat(500), expected: 'e', reproduce: 'r' }).title.length <= 300);

  const zhDraft = requirementDraft(
    { key: 'REV-D0003', actual: 'Cost is $100 $& raw', expected: 'Keep exact text', reproduce: 'Step 1' },
    {
      problem: translate('zh-CN', 'Problem {key}: {summary}'),
      expected: translate('zh-CN', 'Expected behavior'),
      steps: translate('zh-CN', 'Steps')
    }
  );
  assert.equal(zhDraft.title, '问题 REV-D0003：Cost is $100 $& raw');
  assert.equal(zhDraft.description, '预期行为\n\nKeep exact text\n\n复现步骤\n\nStep 1');
});

test('an open card matches a replacement entry of the same issue and kind instead of disappearing', () => {
  const design1: OpenEntryRef = { id: 'entry-d1', workspaceId: 'w1', issueId: 'i1', kind: 'DESIGN_REVIEW', target: {} };
  const design2: OpenEntryRef = { id: 'entry-d2', workspaceId: 'w1', issueId: 'i1', kind: 'DESIGN_REVIEW', target: {} };
  assert.equal(matchOpenEntry([design2], design1)?.id, 'entry-d2');

  const delivery1: OpenEntryRef = { id: 'entry-del1', workspaceId: 'w1', issueId: 'i1', kind: 'DELIVERY_ACCEPTANCE', target: {} };
  const delivery2: OpenEntryRef = { id: 'entry-del2', workspaceId: 'w1', issueId: 'i1', kind: 'DELIVERY_ACCEPTANCE', target: {} };
  const closure: OpenEntryRef = { id: 'entry-close', workspaceId: 'w1', issueId: 'i1', kind: 'CLOSURE_BLOCKED', target: {} };
  assert.equal(matchOpenEntry([delivery2], delivery1)?.id, 'entry-del2');
  assert.equal(matchOpenEntry([closure], delivery1), null);
  assert.equal(matchOpenEntry([], design1), null);

  const otherWorkspace: OpenEntryRef = { id: 'entry-w2', workspaceId: 'w2', issueId: 'i1', kind: 'DESIGN_REVIEW', target: {} };
  assert.equal(matchOpenEntry([otherWorkspace], design1), null);

  const defect1: OpenEntryRef = { id: 'entry-def1', workspaceId: 'w1', issueId: 'i1', kind: 'DEFECT_TRIAGE', target: { defectId: 'def-1' } };
  const defect1New: OpenEntryRef = { id: 'entry-def1-v2', workspaceId: 'w1', issueId: 'i1', kind: 'DEFECT_TRIAGE', target: { defectId: 'def-1' } };
  const defect2: OpenEntryRef = { id: 'entry-def2', workspaceId: 'w1', issueId: 'i1', kind: 'DEFECT_TRIAGE', target: { defectId: 'def-2' } };
  assert.equal(matchOpenEntry([defect2, defect1New], defect1)?.id, 'entry-def1-v2');
  assert.equal(matchOpenEntry([defect2], defect1), null);

  const q1: OpenEntryRef = { id: 'entry-q1', workspaceId: 'w1', issueId: 'i1', kind: 'AGENT_QUESTION', target: { messageId: 'm1' } };
  const q2: OpenEntryRef = { id: 'entry-q2', workspaceId: 'w1', issueId: 'i1', kind: 'AGENT_QUESTION', target: { messageId: 'm2' } };
  assert.equal(matchOpenEntry([q2], q1), null);
});

test('who acts next after confirming a report follows the current inbox entries', () => {
  assert.deepEqual(
    nextFromEntries([{ issueId: 'i1', kind: 'CLOSURE_BLOCKED', status: 'READY_TO_COMPLETE', blockers: [] }], 'i1'),
    { key: 'Accepted and ready to complete' }
  );
  assert.deepEqual(
    nextFromEntries([{ issueId: 'i1', kind: 'CLOSURE_BLOCKED', status: 'BLOCKED', blockers: ['UNRESOLVED_DEFECTS'] }], 'i1'),
    { key: 'Accepted; {blocker}', blocker: 'UNRESOLVED_DEFECTS' }
  );
  assert.deepEqual(
    nextFromEntries([{ issueId: 'i1', kind: 'DELIVERY_ACCEPTANCE', status: 'WAITING', blockers: [] }], 'i1', false),
    { key: 'Awaiting your acceptance' }
  );
  assert.deepEqual(
    nextFromEntries([{ issueId: 'i1', kind: 'DELIVERY_ACCEPTANCE', status: 'WAITING', blockers: [] }], 'i1', true),
    { key: 'The whole delivery awaits your acceptance' }
  );
  assert.deepEqual(
    nextFromEntries([{ issueId: 'i1', kind: 'DELIVERY_ACCEPTANCE', status: 'BLOCKED', blockers: ['MINOR_ACKNOWLEDGEMENT_REQUIRED'] }], 'i1'),
    { key: 'New minor problems need another look from you' }
  );
  assert.equal(
    nextFromEntries([{ issueId: 'i2', kind: 'DELIVERY_ACCEPTANCE', status: 'WAITING', blockers: [] }], 'i1'),
    null
  );
});

test('delivery change view names specific problem, commit, QA and review changes', () => {
  const base: DeliverySnapshot = {
    candidateId: 'cand-1',
    snapshotId: 'snap-1',
    criteria: ['C1', 'C2'],
    decisionRisks: {
      hash: 'h1',
      defects: [
        { id: 'd1', key: 'X-D1', version: 1, state: 'PROPOSED', origin: null, severity: 'MINOR', criterionIds: ['C1'], reproduce: 'r', expected: 'e', actual: 'Old report', source: { kind: 'AGENT_PROPOSAL', id: 'p1' } }
      ],
      qaReport: null
    },
    qa: { id: 'qa-1', verdict: 'PASS', results: [{ criterionId: 'C1', result: 'PASS', evidenceIds: [] }, { criterionId: 'C2', result: 'PASS', evidenceIds: [] }] },
    initial: { id: 'rev-1', verdict: 'PASS' },
    final: { id: 'rev-2', verdict: 'PASS' },
    git: { state: 'PENDING', entries: [{ repository: 'org/repo', sha: '1111111111111111111111111111111111111111' }] }
  };
  assert.deepEqual(deliveryChanges(base, base), []);

  const updated: DeliverySnapshot = {
    ...base,
    decisionRisks: {
      hash: 'h2',
      defects: [
        { id: 'd1', key: 'X-D1', version: 2, state: 'OPEN', origin: 'USER_ACCEPTANCE', severity: 'MAJOR', criterionIds: ['C1'], reproduce: 'r', expected: 'e', actual: 'Old report', source: { kind: 'AGENT_PROPOSAL', id: 'p1' } },
        { id: 'd2', key: 'X-D2', version: 1, state: 'PROPOSED', origin: null, severity: 'BLOCKER', criterionIds: ['C2'], reproduce: 'r', expected: 'e', actual: 'Crash on save', source: { kind: 'AGENT_PROPOSAL', id: 'p2' } }
      ],
      qaReport: null
    },
    qa: { id: 'qa-2', verdict: 'FAIL', results: [{ criterionId: 'C1', result: 'PASS', evidenceIds: [] }, { criterionId: 'C2', result: 'FAIL', evidenceIds: [] }] },
    git: { state: 'VERIFIED', entries: [{ repository: 'org/repo', sha: '2222222222222222222222222222222222222222' }] }
  };
  const changes = deliveryChanges(base, updated);
  assert.deepEqual(changes, [
    { kind: 'problem-added', unconfirmed: true, severity: 'BLOCKER', summary: 'Crash on save' },
    { kind: 'problem-confirmed', severity: 'MAJOR', summary: 'Old report' },
    { kind: 'problem-severity', before: 'MINOR', after: 'MAJOR', summary: 'Old report' },
    { kind: 'commit-attached' },
    { kind: 'qa-criterion', criterion: 'C2', before: 'PASS', after: 'FAIL' }
  ]);

  const verifiedOnly = deliveryChanges(base, { ...base, git: { ...base.git!, state: 'VERIFIED' } });
  assert.deepEqual(verifiedOnly, [{ kind: 'commit-verified' }]);
});

test('a problem report and a question show their own text as the row title', () => {
  assert.equal(rowTitle({ kind: 'DEFECT_TRIAGE', title: 'Issue', defect: { summary: 'Missing value' } }), 'Missing value');
  assert.equal(rowTitle({ kind: 'AGENT_QUESTION', title: 'Issue', question: { body: '\n  Which file?\nMore' } }), 'Which file?');
  assert.equal(rowTitle({ kind: 'DESIGN_REVIEW', title: 'Issue' }), 'Issue');
  assert.equal(firstLine('x'.repeat(200), 20).length, 20);
});

test('ages use the existing short forms', () => {
  assert.equal(formatAge(null), null);
  assert.deepEqual(formatAge(5000), { key: 'Less than a minute' });
  assert.deepEqual(formatAge(5 * 60000), { key: '{count} min', count: 5 });
  assert.deepEqual(formatAge(3 * 3600000), { key: '{count} h', count: 3 });
});

test('the last decided revision skips the current and undecided ones', () => {
  const history = [
    { id: 'c', status: 'IN_REVIEW' },
    { id: 'b', status: 'DRAFT' },
    { id: 'a', status: 'CHANGES_REQUESTED' },
    { id: 'z', status: 'APPROVED' }
  ];
  assert.equal(lastDecidedRevision(history, 'c')?.id, 'a');
  assert.equal(lastDecidedRevision([{ id: 'c', status: 'APPROVED' }], 'c'), null);
});

test('every literal the card files pass to the translator has a Chinese form', () => {
  const files = ['CardKit', 'DesignCard', 'DeliveryCard', 'ScopeReview', 'RunCard', 'DefectCard', 'Decisions'];
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(new URL(`../web/${file}.tsx`, import.meta.url), 'utf8');
    for (const call of source.matchAll(/\bt\(([^()]*)\)/g)) {
      for (const literal of call[1]!.matchAll(/'([^']*[a-z][^']*)'/g)) {
        const text = literal[1]!;
        if (/^[A-Z_]+$/.test(text) || !/^[A-Z{]/.test(text)) continue;
        if (translate('zh-CN', text) === text) missing.push(`${file}: ${text}`);
      }
    }
  }
  for (const key of ['Passed', 'Failed', 'Blocked', 'Not run', 'No result']) if (translate('zh-CN', key) === key) missing.push(`result: ${key}`);
  assert.deepEqual(missing, []);
});

test('the decision flows no longer use dialogs or the exact decision target view', () => {
  const forms = readFileSync(new URL('../web/IssueForms.tsx', import.meta.url), 'utf8');
  const decisions = readFileSync(new URL('../web/Decisions.tsx', import.meta.url), 'utf8');
  for (const gone of ['design-review', "'delivery'", 'scope-decision', 'execution-recovery', 'DeliveryReview']) assert.equal(forms.includes(gone), false, gone);
  assert.equal(decisions.includes('Exact decision target'), false);
  assert.equal(readFileSync(new URL('../web/ScopeReview.tsx', import.meta.url), 'utf8').includes('Modal'), false);
});
