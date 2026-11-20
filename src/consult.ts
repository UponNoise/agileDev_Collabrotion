import { randomUUID } from 'node:crypto';
import { DomainError, type Actor, type Harness, type Issue, type Run } from './contracts.js';
import type { Store } from './store.js';
import type { IssueMessage } from './messages.js';

export type ConsultAvailability = (harness: Harness) => boolean;
export const consultBudgetMs = 10 * 60 * 1000;
const dailyWakeLimit = 3;

interface WakeSettings {
  workspaceId: string;
  enabled: boolean;
  version: number;
}

export function wakeSettings(store: Store, workspaceId: string): WakeSettings {
  const row = store.db.prepare("SELECT data FROM records WHERE kind = 'wake_settings' AND id = ? AND workspace_id = ?")
    .get(workspaceId, workspaceId) as { data: string } | undefined;
  if (!row) return { workspaceId, enabled: false, version: 0 };
  const { enabled, version } = JSON.parse(row.data) as WakeSettings;
  return { workspaceId, enabled, version };
}

export function updateWakeSettings(store: Store, actor: Actor, workspaceId: string, expectedVersion: number, enabled: boolean) {
  const previous = wakeSettings(store, workspaceId);
  if (previous.version !== expectedVersion) {
    throw new DomainError('VERSION_CONFLICT', 'Workspace wake settings changed; reload before retrying', 409, { currentVersion: previous.version });
  }
  const settings: WakeSettings = { workspaceId, enabled, version: previous.version + 1 };
  store.put('wake_settings', { id: workspaceId, ...settings }, workspaceId);
  store.event(workspaceId, actor, 'wake_settings_update', workspaceId, { enabled, previousEnabled: previous.enabled, version: settings.version });
  return { settings };
}

function recipientHarness(store: Store, issue: Issue, recipient: Extract<IssueMessage['recipient'], { kind: 'actor' }>): Harness | null {
  if (recipient.role === 'worker') return issue.assignee === recipient.actorId ? issue.harness : null;
  if (recipient.role === 'qa') return issue.qaAssignee === recipient.actorId ? issue.qaHarness ?? null : null;
  const row = store.db.prepare(`
    SELECT data FROM records
    WHERE kind = 'connection' AND workspace_id = ? AND json_extract(data, '$.actorId') = ?
    ORDER BY json_extract(data, '$.initializedAt') DESC, rowid DESC LIMIT 1
  `).get(issue.workspaceId, recipient.actorId) as { data: string } | undefined;
  const name = row ? String(JSON.parse(row.data).client?.name ?? '').trim().toLowerCase() : '';
  if (['codex', 'codex-cli', 'codex-mcp-client', 'openai codex'].includes(name)) return 'codex';
  if (['claude code', 'claude-code', 'claude-code-client'].includes(name)) return 'claude-code';
  if (['dsh', 'dsh-mcp-client', 'deepseek harness', 'deepseek-harness'].includes(name)) return 'dsh';
  return null;
}

export function admitConsult(store: Store, actor: Actor, issue: Issue, message: IssueMessage, now: number, available?: ConsultAvailability) {
  if (actor.runId && store.get<Run>('run', actor.runId).kind === 'consult') return { state: 'STORED', reason: 'WAKE_NESTED' } as const;
  if (!wakeSettings(store, issue.workspaceId).enabled) return { state: 'STORED', reason: 'WAKE_DISABLED' } as const;
  if (message.recipient.kind !== 'actor') return { state: 'STORED', reason: 'WAKE_UNAVAILABLE' } as const;
  const recipient = message.recipient;
  const harness = recipientHarness(store, issue, recipient);
  if (!harness || !available?.(harness)) return { state: 'STORED', reason: 'WAKE_UNAVAILABLE' } as const;
  const day = new Date(now).toISOString().slice(0, 10);
  const runs = store.list<Run>('run', issue.workspaceId).filter(run => run.kind === 'consult' && run.issueId === issue.id);
  if (runs.some(run => run.state === 'UNCERTAIN' && run.actorId === recipient.actorId)) {
    return { state: 'STORED', reason: 'WAKE_UNCERTAIN' } as const;
  }
  const wakes = runs.filter(run => run.createdAt.startsWith(day) &&
    !(run.state === 'FAILED' && run.errorCode === 'HARNESS_UNAVAILABLE' && !run.pid && !run.providerSessionId));
  if (wakes.length >= dailyWakeLimit) {
    return { state: 'STORED', reason: 'WAKE_BUDGET_EXHAUSTED' } as const;
  }
  const root = issue.parentId ? store.get<Issue>('issue', issue.parentId) : issue;
  const run: Run = {
    id: randomUUID(), workspaceId: issue.workspaceId, issueId: issue.id, actorId: message.recipient.actorId,
    harness, kind: 'consult', consult: { questionId: message.id, mode: 'fresh' },
    state: 'QUEUED', version: 1, createdAt: new Date(now).toISOString(), designId: root.designId,
    scopeRevision: issue.scopeRevision, budgetMs: consultBudgetMs
  };
  store.put('run', run, issue.workspaceId);
  store.event(issue.workspaceId, actor, 'consult_queued', run.id, { questionId: message.id, issueId: issue.id, harness, mode: 'fresh' });
  return { state: 'QUEUED', runId: run.id, harness, mode: 'fresh' } as const;
}

export function consultQuestion(store: Store, run: Extract<Run, { kind: 'consult' }>, issue: Issue): IssueMessage {
  const question = store.get<IssueMessage>('issue_message', run.consult.questionId);
  const root = issue.parentId ? store.get<Issue>('issue', issue.parentId) : issue;
  if (question.kind !== 'QUESTION' || question.workspaceId !== run.workspaceId || question.issueId !== issue.id ||
      question.recipient.kind !== 'actor' || question.recipient.actorId !== run.actorId ||
      recipientHarness(store, issue, question.recipient) !== run.harness ||
      ['ON_HOLD', 'ABANDONED'].includes(issue.state) || ['ON_HOLD', 'ABANDONED'].includes(root.state) ||
      issue.scopeRevision !== run.scopeRevision || root.designId !== run.designId) {
    throw new DomainError('CONSULT_STALE', 'The consult target changed before it could answer');
  }
  return question;
}

export function consultDelivery(run: Extract<Run, { kind: 'consult' }>) {
  return {
    runId: run.id, harness: run.harness, mode: run.consult.mode,
    state: run.state === 'SUCCEEDED' ? 'REPLIED' : run.state,
    ...(run.errorCode ? { reason: run.errorCode } : {})
  };
}
