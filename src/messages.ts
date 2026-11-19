import { randomUUID } from 'node:crypto';
import { setTimeout as waitFor } from 'node:timers/promises';
import { DomainError, type Actor, type Issue, type Role, type Run } from './contracts.js';
import type { MessageList, MessageSend, MessageWait } from './message-contracts.js';
import type { Store } from './store.js';

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

  list(actor: Actor, input: MessageList) {
    const issue = this.store.issue(actor, input.workspaceId, input.issueId);
    const cursor = input.cursor ? this.visibleReference(actor, issue, input.cursor).rowid : 0;
    const visible = this.visible(actor, issue, input.limit + 1, cursor);
    const messages = visible.slice(0, input.limit).map(row => row.message);
    return { messages, nextCursor: visible.length > input.limit ? messages.at(-1)!.id : null };
  }

  async wait(actor: Actor, input: MessageWait, signal?: AbortSignal) {
    const issue = this.store.issue(actor, input.workspaceId, input.issueId);
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

  send(actor: Actor, input: MessageSend) {
    const issue = this.store.issue(actor, input.workspaceId, input.issueId);
    if (actor.runId && this.store.get<Run>('run', actor.runId).state !== 'RUNNING') {
      throw new DomainError('MESSAGE_RUN_INACTIVE', 'Only active execution credentials can send run messages', 403);
    }
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
    this.store.event(issue.workspaceId, actor, 'message_sent', message.id, { issueId: issue.id, kind: message.kind, replyTo: message.replyTo });
    return { message, delivery: { state: 'STORED', reason: input.wake ? 'WAKE_DISABLED' : 'WAKE_NOT_REQUESTED' } };
  }
}
