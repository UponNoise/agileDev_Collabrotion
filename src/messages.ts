import { randomUUID } from 'node:crypto';
import { setTimeout as waitFor } from 'node:timers/promises';
import { DomainError, type Actor, type Issue, type QaReport, type Role, type Run } from './contracts.js';
import type { MessageList, MessageSend, MessageWait } from './message-contracts.js';
import type { Store } from './store.js';
import { briefText } from './issue-brief.js';
import { wakeSettings } from './consult.js';

type AgentRole = Exclude<Role, 'human'>;
type Reader = Pick<Actor, 'id' | 'principalId' | 'role'>;
type Recipient = { kind: 'owner' } | { kind: 'actor'; actorId: string; role: AgentRole };
export interface IssueMessage {
  id: string;
  workspaceId: string;
  issueId: string;
  sender: { actorId: string; principalId: string; role: Role; runId?: string };
  recipient: Recipient;
  kind: MessageSend['kind'];
  body: string;
  replyTo: string | null;
  createdAt: string;
}

function oversightRole(role: Role) {
  return role === 'human' || role === 'lead' || role === 'pm';
}

export class IssueMessages {
  constructor(private store: Store, private now = Date.now) {}

  private logicalAgent(issue: Issue, id: string): Actor {
    const unavailable = () => new DomainError('MESSAGE_RECIPIENT_UNAVAILABLE', 'Select an enrolled agent with access to this issue');
    try {
      const actor = this.store.get<Actor>('actor', id);
      if (actor.role === 'human' || actor.runId || actor.principalId) throw unavailable();
      this.store.issue(actor, issue.workspaceId, issue.id);
      return actor;
    } catch (error) {
      if (error instanceof DomainError && ['NOT_FOUND', 'SCOPE_DENIED'].includes(error.code)) throw unavailable();
      throw error;
    }
  }

  private resolveRecipient(issue: Issue, sender: Actor, input: MessageSend['recipient']): Recipient {
    if (input.kind === 'owner') {
      if (sender.role !== 'lead' && sender.role !== 'pm') throw new DomainError('MESSAGE_OWNER_DENIED', 'Only an issue lead or PM can address the owner', 403);
      return { kind: 'owner' };
    }
    let id: string | null | undefined;
    if (input.kind === 'actor') id = input.actorId;
    else if (input.role === 'worker') id = issue.assignee;
    else if (input.role === 'qa') id = issue.qaAssignee;
    else {
      const candidates = this.store.list<Actor>('actor').filter(actor => actor.role === input.role && !actor.runId &&
        !actor.principalId && actor.workspaceIds.includes(issue.workspaceId));
      if (candidates.length > 1) throw new DomainError('MESSAGE_RECIPIENT_AMBIGUOUS', 'Choose a named agent for this role');
      id = candidates[0]?.id;
    }
    if (!id) throw new DomainError('MESSAGE_RECIPIENT_UNAVAILABLE', 'This issue has no matching recipient');
    const actor = this.logicalAgent(issue, id);
    if ((sender.role === 'qa' && actor.role === 'worker') || (sender.role === 'worker' && actor.role === 'qa')) {
      throw new DomainError('MESSAGE_INDEPENDENCE_REQUIRED', 'Implementation and independent QA exchange evidence through the sealed handoff and QA report', 403);
    }
    return { kind: 'actor', actorId: actor.id, role: actor.role as AgentRole };
  }

  private visible(actor: Reader, issue: Issue, limit: number, after = 0, id: string | null = null) {
    const principal = actor.principalId ?? actor.id;
    const rows = this.store.db.prepare(`
      SELECT rowid, data FROM records
      WHERE kind = 'issue_message' AND workspace_id = ?
        AND json_extract(data, '$.issueId') = ?
        AND (? OR json_extract(data, '$.sender.principalId') = ? OR json_extract(data, '$.recipient.actorId') = ?)
        AND rowid > ? AND (? IS NULL OR id = ?)
      ORDER BY rowid LIMIT ?
    `).all(issue.workspaceId, issue.id, Number(oversightRole(actor.role)), principal, principal, after, id, id, limit) as { rowid: number; data: string }[];
    return rows.map(row => ({ rowid: row.rowid, message: JSON.parse(row.data) as IssueMessage }));
  }

  private visibleReference(actor: Reader, issue: Issue, id: string) {
    const record = this.visible(actor, issue, 1, 0, id)[0];
    if (!record) throw new DomainError('MESSAGE_NOT_VISIBLE', 'Use a visible message from this issue', 404);
    return record;
  }

  private requireActiveRun(actor: Actor) {
    if (actor.runId && this.store.get<Run>('run', actor.runId).state !== 'RUNNING') {
      throw new DomainError('MESSAGE_RUN_INACTIVE', 'The scoped execution is no longer active', 403);
    }
  }

  list(actor: Actor, input: MessageList) {
    const issue = this.store.issue(actor, input.workspaceId, input.issueId);
    this.requireActiveRun(actor);
    const cursor = input.cursor ? this.visibleReference(actor, issue, input.cursor).rowid : 0;
    const visible = this.visible(actor, issue, input.limit + 1, cursor);
    const full = actor.role === 'human' || input.view === 'full';
    const messages = visible.slice(0, input.limit).map(({ message }) => {
      if (full) return message;
      const body = briefText(message.body, 160);
      return { ...message, body, bodyTruncated: body !== message.body };
    });
    return { messages, nextCursor: visible.length > input.limit ? messages.at(-1)!.id : null };
  }

  private pendingQuestions(workspaceId: string, issueId: string | null, actorId: string | null, limit: number) {
    const rows = this.store.db.prepare(`
      SELECT q.data, count(*) OVER () AS pendingCount FROM records q
      WHERE q.kind = 'issue_message' AND q.workspace_id = @workspaceId
        AND (@issueId IS NULL OR json_extract(q.data, '$.issueId') = @issueId)
        AND json_extract(q.data, '$.kind') = 'QUESTION'
        AND ((@actorId IS NULL AND json_extract(q.data, '$.recipient.kind') = 'owner')
          OR json_extract(q.data, '$.recipient.actorId') = @actorId)
        AND NOT EXISTS (
          SELECT 1 FROM records r
          WHERE r.kind = 'issue_message' AND r.workspace_id = q.workspace_id
            AND json_extract(r.data, '$.issueId') = json_extract(q.data, '$.issueId')
            AND json_extract(r.data, '$.kind') = 'REPLY' AND json_extract(r.data, '$.replyTo') = q.id
            AND ((@actorId IS NULL AND json_extract(r.data, '$.sender.role') = 'human')
              OR json_extract(r.data, '$.sender.principalId') = @actorId)
            AND (json_extract(r.data, '$.recipient.actorId') = json_extract(q.data, '$.sender.principalId')
              OR (json_extract(r.data, '$.recipient.kind') = 'owner' AND json_extract(q.data, '$.sender.role') = 'human'))
        )
      ORDER BY q.rowid LIMIT @limit
    `).all({ workspaceId, issueId, actorId, limit }) as { data: string; pendingCount: number }[];
    return { pendingCount: rows[0]?.pendingCount ?? 0, questions: rows.map(row => JSON.parse(row.data) as IssueMessage) };
  }

  ownerQuestions(workspaceId: string) {
    return this.pendingQuestions(workspaceId, null, null, -1).questions;
  }

  summary(actor: Actor, issue: Issue) {
    const principal = actor.principalId ?? actor.id;
    const { visibleCount } = this.store.db.prepare(`
      SELECT count(*) AS visibleCount FROM records
      WHERE kind = 'issue_message' AND workspace_id = ? AND json_extract(data, '$.issueId') = ?
        AND (? OR json_extract(data, '$.sender.principalId') = ? OR json_extract(data, '$.recipient.actorId') = ?)
    `).get(issue.workspaceId, issue.id, Number(oversightRole(actor.role)), principal, principal) as { visibleCount: number };
    if (!visibleCount) return null;
    return { visibleCount, ...this.pendingQuestions(issue.workspaceId, issue.id, actor.role === 'human' ? null : principal, 2) };
  }

  async wait(actor: Actor, input: MessageWait, signal?: AbortSignal) {
    const issue = this.store.issue(actor, input.workspaceId, input.issueId);
    this.requireActiveRun(actor);
    const question = this.visibleReference(actor, issue, input.questionId).message;
    if (question.kind !== 'QUESTION' || question.sender.principalId !== (actor.principalId ?? actor.id)) {
      throw new DomainError('MESSAGE_NOT_VISIBLE', 'Wait on a question you sent in this issue', 404);
    }
    const replies = this.store.db.prepare(`
      SELECT data FROM records
      WHERE kind = 'issue_message' AND workspace_id = ?
        AND json_extract(data, '$.issueId') = ? AND json_extract(data, '$.kind') = 'REPLY'
        AND json_extract(data, '$.replyTo') = ?
        AND (json_extract(data, '$.sender.principalId') = ? OR (? AND json_extract(data, '$.sender.role') = 'human'))
        AND (json_extract(data, '$.recipient.actorId') = ? OR (? AND json_extract(data, '$.recipient.kind') = 'owner'))
      ORDER BY rowid LIMIT 1
    `);
    const deadline = performance.now() + input.timeoutMs;
    while (!signal?.aborted) {
      this.requireActiveRun(actor);
      this.store.issue(actor, input.workspaceId, input.issueId);
      const reply = replies.get(issue.workspaceId, issue.id, question.id,
        question.recipient.kind === 'actor' ? question.recipient.actorId : null, Number(question.recipient.kind === 'owner'),
        question.sender.principalId, Number(question.sender.role === 'human')) as { data: string } | undefined;
      if (reply) return { status: 'REPLIED', reply: JSON.parse(reply.data) as IssueMessage };
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { status: 'TIMED_OUT', reply: null };
      try {
        await waitFor(Math.min(250, remaining), undefined, { signal });
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
    }
    return { status: 'CANCELLED', reply: null };
  }

  private recordQaDelivery(actor: Actor, issue: Issue, message: IssueMessage) {
    const runs = new Set<string>();
    if (actor.role === 'qa' && actor.runId && this.store.get<Run>('run', actor.runId).kind === 'qa') runs.add(actor.runId);
    if (message.recipient.kind === 'actor' && message.recipient.role === 'qa') {
      const recipient = message.recipient.actorId;
      for (const run of this.store.list<Run>('run', issue.workspaceId)) {
        if (run.kind !== 'qa' || run.state !== 'RUNNING' || run.actorId !== recipient || !run.executionActorId) continue;
        const target = this.store.get<Issue>('issue', run.issueId);
        if (target.id === issue.id || target.parentId === issue.id) runs.add(run.id);
      }
    }
    for (const runId of runs) {
      this.store.put('qa_message_delivery', { id: `${runId}:${message.id}`, workspaceId: issue.workspaceId, runId, messageId: message.id }, issue.workspaceId);
    }
  }

  qaEvidence(run: Run): string[] {
    return (this.store.db.prepare(`
      SELECT json_extract(data, '$.messageId') AS messageId FROM records
      WHERE kind = 'qa_message_delivery' AND workspace_id = ? AND json_extract(data, '$.runId') = ?
      ORDER BY rowid
    `).all(run.workspaceId, run.id) as { messageId: string }[]).map(record => record.messageId);
  }

  captureQaEvidence(run: Run) {
    if (run.kind !== 'qa') return;
    run.messageIds = this.qaEvidence(run);
    if (!run.reportId) return;
    const row = this.store.db.prepare("SELECT data FROM records WHERE kind = 'qa_report' AND id = ? AND workspace_id = ?")
      .get(run.reportId, run.workspaceId) as { data: string } | undefined;
    const report = row ? JSON.parse(row.data) as QaReport : null;
    if (report?.runId === run.id && report.workspaceId === run.workspaceId && report.issueId === run.issueId) {
      this.store.put('qa_report', { ...report, messageIds: run.messageIds }, run.workspaceId);
    }
  }

  reportView(actor: Actor, report: QaReport) {
    if (oversightRole(actor.role) || !report.messageIds) return report;
    const run = this.store.get<Run>('run', report.runId);
    const belongsToQa = actor.role === 'qa' && run.actorId === (actor.principalId ?? actor.id) &&
      (!actor.runId || actor.runId === run.id);
    if (belongsToQa) return report;
    const { messageIds, ...permitted } = report;
    return permitted;
  }

  send(actor: Actor, input: MessageSend) {
    const issue = this.store.issue(actor, input.workspaceId, input.issueId);
    this.requireActiveRun(actor);
    const recipient = this.resolveRecipient(issue, actor, input.recipient);
    if (input.replyTo) {
      this.visibleReference(actor, issue, input.replyTo);
      if (recipient.kind === 'actor') this.visibleReference({ id: recipient.actorId, role: recipient.role }, issue, input.replyTo);
    }
    const message: IssueMessage = {
      id: randomUUID(), workspaceId: issue.workspaceId, issueId: issue.id,
      sender: { actorId: actor.id, principalId: actor.principalId ?? actor.id, role: actor.role, ...(actor.runId ? { runId: actor.runId } : {}) },
      recipient, kind: input.kind, body: input.body, replyTo: input.replyTo ?? null,
      createdAt: new Date(this.now()).toISOString()
    };
    this.store.put('issue_message', message, issue.workspaceId);
    this.recordQaDelivery(actor, issue, message);
    this.store.event(issue.workspaceId, actor, 'message_sent', message.id, { issueId: issue.id, kind: message.kind, replyTo: message.replyTo });
    let reason = 'WAKE_NOT_REQUESTED';
    if (input.wake) reason = wakeSettings(this.store, issue.workspaceId).enabled ? 'WAKE_UNAVAILABLE' : 'WAKE_DISABLED';
    return { message, delivery: { state: 'STORED', reason } };
  }
}
