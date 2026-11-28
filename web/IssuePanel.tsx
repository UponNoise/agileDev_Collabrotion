import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QaReport } from '../src/contracts';
import { ApiError, command, errorText, harnessName, mutation } from './api';
import type { DefectRecord, InboxEntry, IssueData, IssueMessageView, WorkspaceData } from './api';
import { PREVIEW_FIRST_BYTES, PREVIEW_MAX_BYTES, base64Bytes, decodeWindow, previewWindow } from './card-model';
import type { Preview } from './card-model';
import { AuditDetails, Markdown, useCodeText, useSentence, useSeverityText } from './CardKit';
import { openDecisionCard } from './Decisions';
import { Avatar, ProgressRing, StatusIcon, UiIcon } from './Icons';
import type { IssueDialog } from './IssueForms';
import { useDateText, useRoleWords, useText } from './Preferences';
import { wakeReasonSentence } from './sentences';
import {
  activeRunForIssue,
  actorInitials,
  decisionActionVerb,
  enrichHistoryEvents,
  historyAuditRow,
  isActiveAgent,
  isActionableEntry,
  issueIconKind,
  issueStatusForPacket,
  issueSteps,
  moreActionsForIssue,
  requirementProgress
} from './work-model';
import type { MoreActionKind } from './work-model';
import { TaskRow } from './WorkspaceViews';

type IssueTab = 'overview' | 'history' | 'discussion';

function FilePreviewRow({
  workspaceId,
  issueId,
  snapshotId,
  path,
  size
}: {
  workspaceId: string;
  issueId: string;
  snapshotId: string;
  path: string;
  size: number | null;
}) {
  const t = useText();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ bytes: Uint8Array; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const next = previewWindow(state?.bytes.length ?? 0, state?.total ?? size ?? PREVIEW_MAX_BYTES);
    if (!next && state) return;
    setBusy(true);
    setFailed(false);
    try {
      const read = await command<{ content: string; totalBytes: number }>('artifact_read', {
        workspaceId,
        issueId,
        snapshotId,
        path,
        encoding: 'base64',
        offset: next?.offset ?? 0,
        limit: next?.limit ?? PREVIEW_FIRST_BYTES
      });
      const chunk = base64Bytes(read.content);
      const joined = new Uint8Array((state?.bytes.length ?? 0) + chunk.length);
      if (state) joined.set(state.bytes);
      joined.set(chunk, state?.bytes.length ?? 0);
      setState({ bytes: joined, total: read.totalBytes });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const preview: Preview | null = state
    ? decodeWindow(state.bytes, state.bytes.length >= Math.min(state.total, PREVIEW_MAX_BYTES))
    : null;
  const more = state ? previewWindow(state.bytes.length, state.total) : null;
  const sizeLabel =
    size === null ? '' : size > 9999 ? `${Math.round(size / 1024)} KB` : `${size} B`;

  return (
    <div className="file-item">
      <button
        type="button"
        className="frow"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && !state) void load();
        }}
      >
        <UiIcon name="chev" size={13} />
        <span className="grow">{path}</span>
        {sizeLabel ? <small>{sizeLabel}</small> : null}
      </button>
      {open ? (
        <div className="file-preview-box">
          {failed ? <p className="prev-n">{t('This file could not be read.')}</p> : null}
          {preview?.kind === 'binary' ? <p className="prev-n">{t('This file cannot be previewed as text.')}</p> : null}
          {preview?.kind === 'text' ? <pre className="prev" tabIndex={0}>{preview.text}</pre> : null}
          {state && more ? (
            <button type="button" className="btn sm" disabled={busy} onClick={() => void load()}>
              {t('Show more')}
            </button>
          ) : null}
          {state && !more && state.total > PREVIEW_MAX_BYTES ? (
            <p className="prev-n">{t('Only the first 64 KiB are shown.')}</p>
          ) : null}
          {!state && busy ? <p className="prev-n">{t('Loading…')}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

const REJECTION_STAGE_LABEL: Record<string, string> = {
  PRE_QA: 'Initial review',
  QA: 'Independent QA',
  FINAL: 'Final review',
  USER: 'Your acceptance'
};

export function IssuePanel({
  packet,
  workspace,
  entries,
  online,
  onDialog,
  onRefresh,
  onBack,
  onSelectIssue,
  onMenu
}: {
  packet: IssueData;
  workspace: WorkspaceData;
  entries: readonly InboxEntry[];
  online: boolean;
  onDialog(dialog: Omit<IssueDialog, 'id'>): void;
  onRefresh(): void;
  onBack(): void;
  onSelectIssue(issueId: string): void;
  onMenu(): void;
}) {
  const t = useText();
  const render = useSentence();
  const codeText = useCodeText();
  const severityText = useSeverityText();
  const dateText = useDateText();
  const roleWords = useRoleWords();
  const issue = packet.issue;

  const [tab, setTab] = useState<IssueTab>('overview');
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePos, setMorePos] = useState<{ x: number; y: number } | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  const [history, setHistory] = useState(packet.history);
  const [nextAfter, setNextAfter] = useState(packet.nextAfter);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const [defects, setDefects] = useState<DefectRecord[]>([]);
  const [qaReport, setQaReport] = useState<QaReport | null>(null);
  const [messages, setMessages] = useState<IssueMessageView[]>([]);
  const [noteText, setNoteText] = useState('');
  const [noteRecipient, setNoteRecipient] = useState('');
  const [noteSending, setNoteSending] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setTab('overview');
    setMoreOpen(false);
    setNoteText('');
    setNoteError(null);
    setActionError(null);
  }, [issue.id]);

  // Keep full history merged so newest-first order is accurate
  useEffect(() => {
    setHistory(packet.history);
    setNextAfter(packet.nextAfter);
  }, [issue.id]);

  useEffect(() => {
    setHistory((previous) => {
      const merged = [...new Map([...previous, ...packet.history].map((item) => [item.sequence, item])).values()].sort(
        (a, b) => a.sequence - b.sequence
      );
      return merged;
    });
    setNextAfter((previous) => {
      if (packet.nextAfter === null && previous === null) return null;
      if (packet.nextAfter === null) return previous;
      return Math.max(previous ?? 0, packet.nextAfter);
    });
  }, [packet.history, packet.nextAfter]);

  // Automatically fetch remaining history pages when History tab is opened so newest events appear first
  const loadRemainingHistory = useCallback(async () => {
    if (nextAfter === null || loadingHistory) return;
    setLoadingHistory(true);
    try {
      let cursor: number | null = nextAfter;
      let pages = 0;
      const collected: IssueData['history'] = [];
      while (cursor !== null && pages < 5) {
        const next: IssueData = await command<IssueData>('ui_issue', {
          workspaceId: issue.workspaceId,
          issueId: issue.id,
          after: cursor,
          limit: 100
        });
        collected.push(...next.history);
        cursor = next.nextAfter;
        pages += 1;
      }
      if (collected.length) {
        setHistory((previous) =>
          [...new Map([...previous, ...collected].map((item) => [item.sequence, item])).values()].sort(
            (a, b) => a.sequence - b.sequence
          )
        );
      }
      setNextAfter(cursor);
    } catch (failure) {
      setActionError(failure instanceof ApiError ? codeText(failure.code) : errorText(failure));
    } finally {
      setLoadingHistory(false);
    }
  }, [nextAfter, loadingHistory, issue.workspaceId, issue.id, codeText]);

  useEffect(() => {
    if (tab === 'history' && nextAfter !== null) {
      void loadRemainingHistory();
    }
  }, [tab, nextAfter, loadRemainingHistory]);

  // Fetch defects for this issue
  useEffect(() => {
    let active = true;
    command<{ defects: DefectRecord[] }>('defect_list', {
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      limit: 50
    })
      .then((result) => {
        if (active) setDefects(result.defects.filter((item) => item.state === 'OPEN' || item.state === 'PROPOSED'));
      })
      .catch(() => {
        if (active) setDefects([]);
      });
    return () => {
      active = false;
    };
  }, [issue.workspaceId, issue.id, workspace.cursor]);

  // Fetch latest QA report for criteria results if available
  const qaReportId = useMemo(() => {
    if (packet.decisionRisks?.qaReport?.id) return packet.decisionRisks.qaReport.id;
    const found = packet.evidence.find((item) => item.kind === 'qa_report');
    return found?.id ?? null;
  }, [packet.decisionRisks?.qaReport?.id, packet.evidence]);

  useEffect(() => {
    setQaReport(null);
    if (!qaReportId) return;
    let active = true;
    command<{ evidence: QaReport }>('evidence_get', {
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      kind: 'qa_report',
      evidenceId: qaReportId
    })
      .then((result) => {
        if (active) setQaReport(result.evidence);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [issue.workspaceId, issue.id, qaReportId]);

  // Fetch messages for Discussion tab (and count)
  const loadMessages = useCallback(async () => {
    try {
      const collected: IssueMessageView[] = [];
      let cursor: string | null = null;
      let pages = 0;
      while (pages < 10) {
        const result: { messages: IssueMessageView[]; nextCursor: string | null } = await command('message_list', {
          workspaceId: issue.workspaceId,
          issueId: issue.id,
          ...(cursor ? { cursor } : {}),
          limit: 20
        });
        collected.push(...result.messages);
        cursor = result.nextCursor;
        pages += 1;
        if (!cursor) break;
      }
      setMessages(collected);
    } catch {
      setMessages([]);
    }
  }, [issue.workspaceId, issue.id]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages, workspace.cursor]);

  // Close More popover on outside click or Escape
  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (moreMenuRef.current?.contains(target) || moreBtnRef.current?.contains(target)) return;
      setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMoreOpen(false);
        moreBtnRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  // Eligible agents for NOTE composer (lead, pm, assigned developer, assigned QA)
  const eligibleRecipients = useMemo(() => {
    const allowed = workspace.actors.filter((actor) => {
      if (!isActiveAgent(actor)) return false;
      if (actor.role === 'lead' || actor.role === 'pm') return true;
      if (actor.role === 'worker' && issue.assignee === actor.id) return true;
      if (actor.role === 'qa' && issue.qaAssignee === actor.id) return true;
      return false;
    });
    return allowed;
  }, [workspace.actors, issue.assignee, issue.qaAssignee]);

  useEffect(() => {
    if (!eligibleRecipients.some((actor) => actor.id === noteRecipient)) {
      setNoteRecipient(eligibleRecipients[0]?.id ?? '');
    }
  }, [eligibleRecipients, noteRecipient]);

  async function sendNote() {
    const body = noteText.trim();
    if (!body || !noteRecipient || noteSending || !online) return;
    setNoteSending(true);
    setNoteError(null);
    try {
      await mutation('message_send', {
        workspaceId: issue.workspaceId,
        issueId: issue.id,
        recipient: { kind: 'actor', actorId: noteRecipient },
        kind: 'NOTE',
        body
      });
      setNoteText('');
      await loadMessages();
      onRefresh();
    } catch (failure) {
      setNoteError(failure instanceof ApiError ? codeText(failure.code) : errorText(failure));
    } finally {
      setNoteSending(false);
    }
  }

  const actionableEntry = useMemo(
    () => entries.find((entry) => entry.issueId === issue.id && isActionableEntry(entry)) ?? null,
    [entries, issue.id]
  );

  const liveRun = useMemo(
    () =>
      packet.runs.find(
        (run) =>
          run.kind !== 'consult' &&
          ['QUEUED', 'STARTING', 'RUNNING', 'STOPPING', 'UNCERTAIN'].includes(run.state)
      ) ?? activeRunForIssue(workspace.activeRuns, issue.id),
    [packet.runs, workspace.activeRuns, issue.id]
  );

  const statusText = render(issueStatusForPacket(packet, workspace, entries, roleWords));
  const icon = issueIconKind(issue, liveRun);
  const childTasks = useMemo(
    () => workspace.issues.filter((item) => item.parentId === issue.id),
    [workspace.issues, issue.id]
  );
  const progress = useMemo(
    () => (!issue.parentId ? requirementProgress(issue.id, workspace.issues, entries) : null),
    [issue.parentId, issue.id, workspace.issues, entries]
  );
  const steps = useMemo(
    () => issueSteps(issue, packet.design?.status ?? null, childTasks.length > 0),
    [issue, packet.design?.status, childTasks.length]
  );

  const moreActions = useMemo(() => moreActionsForIssue(packet), [packet]);
  const formActions = moreActions.filter((action) => action.group === 'forms');
  const lifecycleActions = moreActions.filter((action) => action.group === 'lifecycle');

  async function runMoreAction(id: MoreActionKind) {
    setMoreOpen(false);
    setActionError(null);
    if (id === 'design_submit') {
      try {
        await mutation('design_submit', {
          workspaceId: issue.workspaceId,
          issueId: issue.id,
          expectedVersion: issue.version
        });
        onRefresh();
      } catch (failure) {
        setActionError(failure instanceof ApiError ? codeText(failure.code) : errorText(failure));
      }
      return;
    }
    if (id === 'create_task') {
      onDialog({ kind: 'create', parent: issue });
      return;
    }
    if (id === 'hold' || id === 'resume' || id === 'abandon' || id === 'reopen') {
      onDialog({ kind: 'transition', packet, action: id });
      return;
    }
    onDialog({ kind: id, packet });
  }

  const timeline = useMemo(
    () => enrichHistoryEvents(history, workspace.actors, packet.runs, issue, harnessName),
    [history, workspace.actors, packet.runs, issue]
  );

  const declinedByMessage = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of history) {
      if (item.operation === 'consult_declined' && item.data && typeof item.data === 'object') {
        const reason = (item.data as Record<string, unknown>).reason;
        if (typeof reason === 'string') map.set(item.targetId, reason);
      }
    }
    return map;
  }, [history]);

  const answeredQuestionIds = useMemo(() => {
    const answered = new Set<string>();
    for (const msg of messages) {
      if (msg.kind === 'REPLY' && msg.replyTo) answered.add(msg.replyTo);
    }
    return answered;
  }, [messages]);

  const actorNameById = (id?: string | null) => {
    if (!id) return null;
    return workspace.actors.find((actor) => actor.id === id)?.name ?? null;
  };

  const singleLead = useMemo(() => {
    const leads = workspace.actors.filter((actor) => isActiveAgent(actor) && actor.role === 'lead');
    return leads.length === 1 ? leads[0]!.name : null;
  }, [workspace.actors]);

  const criteria = issue.criteria.length ? issue.criteria : packet.design?.criteria ?? [];
  const lastUpdated = history.at(-1)?.at ?? null;
  const resultText: Record<string, string> = { PASS: 'Passed', FAIL: 'Failed', BLOCKED: 'Blocked', NOT_RUN: 'Not run' };
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!childTasks.length) return;
    const hasLive = workspace.activeRuns.some(
      (run) => ['STARTING', 'RUNNING', 'STOPPING'].includes(run.state) && childTasks.some((child) => child.id === run.issueId)
    );
    if (!hasLive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [childTasks, workspace.activeRuns]);

  const openMoreMenu = () => {
    if (moreOpen) {
      setMoreOpen(false);
      return;
    }
    const rect = moreBtnRef.current?.getBoundingClientRect();
    if (rect) {
      const appWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-width')) || window.innerWidth;
      setMorePos({ x: Math.max(8, Math.min(rect.right - 220, appWidth - 236)), y: rect.bottom + 6 });
    }
    setMoreOpen(true);
  };

  return (
    <>
      <header className="bar">
        <button type="button" className="icon-btn menu-btn" aria-label={t('Open navigation')} onClick={onMenu}>
          <UiIcon name="menu" />
        </button>
        <div className="crumb">
          <a
            href={`/?${new URLSearchParams({ workspace: issue.workspaceId, view: 'work' })}`}
            onClick={(event) => {
              if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onBack();
            }}
          >
            {t('Work')}
          </a>
          <UiIcon name="chev" size={12} />
          {packet.parent ? (
            <>
              <a
                href={`/w/${encodeURIComponent(issue.workspaceId)}/issues/${encodeURIComponent(packet.parent.id)}`}
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  onSelectIssue(packet.parent!.id);
                }}
              >
                {packet.parent.title}
              </a>
              <UiIcon name="chev" size={12} />
            </>
          ) : null}
          <b>{issue.key}</b>
        </div>
        <button
          ref={moreBtnRef}
          type="button"
          className="btn ghost sm"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          disabled={!online}
          onClick={openMoreMenu}
        >
          <UiIcon name="more" size={16} />
          {t('More')}
        </button>
      </header>
      <div className="scroll">
        <div className="issue">
          <div className="i-main">
            <h1>{issue.titleSuffix}</h1>
            <div className={`status ${actionableEntry ? 'you' : ''}`}>
              {!issue.parentId && progress ? (
                issue.state === 'DONE' ? <StatusIcon kind="done" /> : <ProgressRing done={progress.done} total={progress.total} />
              ) : (
                <StatusIcon kind={icon.kind} progress={icon.progress} />
              )}
              <p>{statusText}</p>
              {actionableEntry ? (
                <a
                  className="btn primary"
                  href={`/?${new URLSearchParams({ workspace: actionableEntry.workspaceId, view: 'decisions', issue: actionableEntry.issueId, kind: actionableEntry.kind })}`}
                  onClick={(event) => {
                    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    openDecisionCard(actionableEntry.workspaceId, actionableEntry.issueId, actionableEntry.kind);
                  }}
                >
                  {t(decisionActionVerb(actionableEntry.kind))}
                </a>
              ) : null}
            </div>
            {actionError ? (
              <p className="error" role="alert">
                {actionError}
              </p>
            ) : null}
            {steps.length ? (
              <ol className="steps" aria-label={t('Progress')}>
                {steps.map((step) => (
                  <li key={step.id} className={step.status} aria-current={step.status === 'cur' ? 'step' : undefined}>
                    {step.status === 'done' ? (
                      <StatusIcon kind="done" />
                    ) : step.status === 'cur' ? (
                      <StatusIcon
                        kind={
                          ['LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED'].includes(issue.state)
                            ? 'rework'
                            : issue.state === 'USER_ACCEPTANCE'
                              ? 'you'
                              : 'dev'
                        }
                        progress={0.5}
                      />
                    ) : (
                      <StatusIcon kind="todo" />
                    )}
                    {t(step.labelKey)}
                  </li>
                ))}
              </ol>
            ) : null}
            <div
              className="tabs"
              role="tablist"
              aria-label={t('Issue sections')}
              onKeyDown={(event) => {
                const tabs: IssueTab[] = ['overview', 'history', 'discussion'];
                const index = tabs.indexOf(tab);
                const next = {
                  ArrowLeft: tabs[(index + tabs.length - 1) % tabs.length],
                  ArrowRight: tabs[(index + 1) % tabs.length],
                  Home: tabs[0],
                  End: tabs.at(-1)
                }[event.key];
                if (!next) return;
                event.preventDefault();
                setTab(next);
                event.currentTarget.querySelector<HTMLButtonElement>(`#tab-${next}`)?.focus();
              }}
            >
              <button
                type="button"
                role="tab"
                id="tab-overview"
                aria-selected={tab === 'overview'}
                tabIndex={tab === 'overview' ? 0 : -1}
                aria-controls="panel-overview"
                onClick={() => setTab('overview')}
              >
                {t('Overview')}
              </button>
              <button
                type="button"
                role="tab"
                id="tab-history"
                aria-selected={tab === 'history'}
                tabIndex={tab === 'history' ? 0 : -1}
                aria-controls="panel-history"
                onClick={() => setTab('history')}
              >
                {t('History')}
              </button>
              <button
                type="button"
                role="tab"
                id="tab-discussion"
                aria-selected={tab === 'discussion'}
                tabIndex={tab === 'discussion' ? 0 : -1}
                aria-controls="panel-discussion"
                onClick={() => setTab('discussion')}
              >
                {t('Discussion')}
                {messages.length > 0 ? <span className="c">{messages.length}</span> : null}
              </button>
            </div>

            {tab === 'overview' ? (
              <div className="ov" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
                <section className="sec">
                  <div className="sec-h">{issue.parentId ? t('Description') : t('Requirement')}</div>
                  {issue.description ? (
                    <Markdown source={issue.description} />
                  ) : (
                    <p className="muted">{t('No description yet.')}</p>
                  )}
                </section>

                {packet.lastRejection ? (
                  <div className="quote">
                    <small>
                      {t(REJECTION_STAGE_LABEL[packet.lastRejection.stage] ?? 'Rejection')} · {dateText(packet.lastRejection.at)}
                    </small>
                    <p>{packet.lastRejection.reason || t('Returned for rework.')}</p>
                  </div>
                ) : null}

                {!issue.parentId && packet.design ? (
                  <section className="sec">
                    <div className="sec-h">
                      <span>{t('Design')}</span>
                      {packet.design.status === 'DRAFT' ? <span className="chip">{t('Draft')}</span> : null}
                      {packet.design.status === 'IN_REVIEW' ? <span className="chip you">{t('Awaits you')}</span> : null}
                      {packet.design.status === 'CHANGES_REQUESTED' ? <span className="chip rework">{t('Changes requested')}</span> : null}
                    </div>
                    {packet.design.status === 'APPROVED' ? (
                      <details className="audit">
                        <summary>{t('Approved design')}</summary>
                        <div className="design-expanded">
                          <Markdown source={packet.design.content} />
                        </div>
                      </details>
                    ) : (
                      <Markdown source={packet.design.content} />
                    )}
                  </section>
                ) : null}

                {!issue.parentId && childTasks.length ? (
                  <section className="sec">
                    <div className="sec-h">{t('Tasks')}</div>
                    <div className="tree">
                      {childTasks.map((child) => (
                        <TaskRow
                          key={child.id}
                          issue={child}
                          workspace={workspace}
                          entries={entries}
                          now={now}
                          onSelect={onSelectIssue}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}

                {criteria.length ? (
                  <section className="sec">
                    <div className="sec-h">{t('Acceptance criteria')}</div>
                    <div className="clist">
                      {criteria.map((criterion) => {
                        const result = qaReport?.results.find((item) => item.criterionId === criterion);
                        return (
                          <div className="crow" key={criterion}>
                            {result ? (
                              <StatusIcon kind={result.result === 'PASS' ? 'done' : result.result === 'FAIL' ? 'crit' : 'todo'} />
                            ) : (
                              <span className="dotmark" aria-hidden="true" />
                            )}
                            <b>
                              {criterion}
                              {result ? (
                                <span className="sr-only"> {t(resultText[result.result] ?? 'No result')}</span>
                              ) : null}
                            </b>
                            {result?.reason ? <small>{result.reason}</small> : null}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ) : null}

                {defects.length ? (
                  <section className="sec">
                    <div className="sec-h">{t('Open problems')}</div>
                    {defects.map((defect) => (
                      <div
                        className={`risk ${['BLOCKER', 'MAJOR'].includes(defect.severity) && defect.state === 'OPEN' ? 'hot' : ''}`}
                        key={defect.id}
                      >
                        <div className="rt">
                          <span className={`chip ${['BLOCKER', 'MAJOR'].includes(defect.severity) ? 'crit' : defect.severity === 'MINOR' ? 'warn' : ''}`}>
                            {severityText(defect.severity)}
                          </span>
                          <span className="grow">{defect.actual}</span>
                          {defect.state === 'PROPOSED' ? <span className="chip">{t('Not confirmed yet')}</span> : null}
                        </div>
                      </div>
                    ))}
                  </section>
                ) : null}

                {issue.candidate ? (
                  <section className="sec">
                    <div className="sec-h">
                      <span>{t('Delivery')}</span>
                      {packet.git?.entries.filter((entry) => /^https:\/\//.test(entry.url)).map((entry) => (
                        <a
                          key={`${entry.repository}-${entry.sha}`}
                          className="lnk sec-right"
                          href={entry.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('View the commit on GitHub')}
                          <UiIcon name="ext" size={13} />
                        </a>
                      ))}
                    </div>
                    {issue.candidate.summary ? <Markdown source={issue.candidate.summary} /> : null}
                    {issue.candidate.files.length && issue.candidate.snapshotId ? (
                      <div className="file-list">
                        {issue.candidate.files.map((file) => (
                          <FilePreviewRow
                            key={file.path}
                            workspaceId={issue.workspaceId}
                            issueId={issue.id}
                            snapshotId={issue.candidate!.snapshotId!}
                            path={file.path}
                            size={packet.snapshot?.files.find((item) => item.path === file.path)?.bytes ?? null}
                          />
                        ))}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                <AuditDetails
                  rows={[
                    ['Issue ID', issue.id],
                    ['Issue version', issue.version],
                    ['Scope revision', issue.scopeRevision],
                    ['State code', issue.stage ? `${issue.state} · ${issue.stage}` : issue.state],
                    ['Design', packet.design?.id],
                    ['Design hash', packet.design?.hash],
                    ['Candidate', issue.candidate?.id],
                    ['Digest', packet.deliveryDigest],
                    ['Snapshot', issue.candidate?.snapshotId],
                    ['Snapshot hash', packet.snapshot?.hash],
                    ['Commit', packet.git?.entries[0]?.sha],
                    ['Blockers', (issue.state === 'USER_ACCEPTANCE' ? packet.closureBlocked : packet.readiness.blocking).join(', ')]
                  ]}
                />
              </div>
            ) : null}

            {tab === 'history' ? (
              <div className="ov" role="tabpanel" id="panel-history" aria-labelledby="tab-history">
                {loadingHistory ? <p className="muted" role="status">{t('Loading…')}</p> : null}
                {timeline.length ? (
                  <ol className="tl">
                    {timeline.map((item) => (
                      <li key={item.sequence}>
                        <Avatar name={item.actorName} initials={actorInitials(item.actorName)} />
                        <p>
                          <b>{item.actorName}</b> {render(item.sentence)}
                        </p>
                        <time>{dateText(item.at)}</time>
                        {item.reason ? <small>{item.reason}</small> : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted">{t('No records yet.')}</p>
                )}
                {nextAfter !== null ? (
                  <button type="button" className="btn sm" disabled={loadingHistory} onClick={() => void loadRemainingHistory()}>
                    {t('Show more')}
                  </button>
                ) : null}
                <AuditDetails
                  rows={[...history]
                    .reverse()
                    .map((item): [string, string] => [
                      dateText(item.at),
                      historyAuditRow(item, render)
                    ])}
                />
              </div>
            ) : null}

            {tab === 'discussion' ? (
              <div className="ov" role="tabpanel" id="panel-discussion" aria-labelledby="tab-discussion">
                <div className="msgs">
                  {messages.length ? (
                    messages.map((msg) => {
                      const senderName =
                        msg.sender.role === 'human'
                          ? t('You')
                          : actorNameById(msg.sender.principalId) ?? actorNameById(msg.sender.actorId) ?? t('Agent');
                      const recipientName =
                        msg.recipient.kind === 'owner'
                          ? t('You')
                          : actorNameById(msg.recipient.actorId) ?? t('Agent');
                      const pending = msg.kind === 'QUESTION' && !answeredQuestionIds.has(msg.id);
                      const declinedReason = declinedByMessage.get(msg.id);
                      const wakeText = msg.delivery
                        ? msg.delivery.reason
                          ? render(wakeReasonSentence(msg.delivery.reason))
                          : t('Woke {harness} to answer').replace('{harness}', harnessName(msg.delivery.harness))
                        : declinedReason
                          ? render(wakeReasonSentence(declinedReason))
                          : null;
                      return (
                        <div className="msg" key={msg.id}>
                          <Avatar
                            name={senderName}
                            initials={msg.sender.role === 'human' ? t('You').slice(0, 1) : actorInitials(senderName)}
                            isYou={msg.sender.role === 'human'}
                          />
                          <div className="mh">
                            <b>{senderName}</b>
                            <span>
                              {t('to')} {recipientName}
                            </span>
                            <span>{dateText(msg.createdAt)}</span>
                            {pending ? (
                              <span className={`chip ${msg.recipient.kind === 'owner' ? 'you' : ''}`}>
                                {msg.recipient.kind === 'owner' ? t('Waiting for you') : t('Waiting')}
                              </span>
                            ) : null}
                          </div>
                          <div className="mb">
                            <Markdown source={msg.body} />
                          </div>
                          {wakeText ? <div className="mb muted msg-wake">{wakeText}</div> : null}
                        </div>
                      );
                    })
                  ) : (
                    <p className="muted">{t('No messages yet.')}</p>
                  )}
                </div>
                {eligibleRecipients.length ? (
                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void sendNote();
                    }}
                  >
                    <label className="sr-only" htmlFor="issue-note-body">
                      {t('Message')}
                    </label>
                    <textarea
                      id="issue-note-body"
                      rows={2}
                      maxLength={16000}
                      placeholder={t('Leave a message for an agent')}
                      value={noteText}
                      disabled={!online || noteSending}
                      onChange={(event) => setNoteText(event.target.value)}
                    />
                    {noteError ? (
                      <p className="error" role="alert">
                        {noteError}
                      </p>
                    ) : null}
                    <div className="abar-row">
                      <label className="sr-only" htmlFor="issue-note-recipient">
                        {t('Recipient')}
                      </label>
                      <select
                        id="issue-note-recipient"
                        className="sel"
                        value={noteRecipient}
                        disabled={!online || noteSending}
                        onChange={(event) => setNoteRecipient(event.target.value)}
                      >
                        {eligibleRecipients.map((actor) => (
                          <option key={actor.id} value={actor.id}>
                            {actor.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="btn"
                        disabled={!online || noteSending || !noteText.trim() || !noteRecipient}
                      >
                        {t('Send')}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="muted">{t('Enroll or assign an agent to leave a message.')}</p>
                )}
              </div>
            ) : null}
          </div>

          <aside className="i-side" aria-label={t('Properties')}>
            {issue.parentId ? (
              <>
                <div className="prop">
                  <small>{t('Developer')}</small>
                  <span>
                    <Avatar name={actorNameById(issue.assignee)} initials={actorNameById(issue.assignee) ? actorInitials(actorNameById(issue.assignee)!) : undefined} />
                    <span className="cut">{actorNameById(issue.assignee) ?? t('Unassigned')}</span>
                  </span>
                </div>
                <div className="prop">
                  <small>{t('Independent QA')}</small>
                  <span>
                    <Avatar name={actorNameById(issue.qaAssignee)} initials={actorNameById(issue.qaAssignee) ? actorInitials(actorNameById(issue.qaAssignee)!) : undefined} />
                    <span className="cut">{actorNameById(issue.qaAssignee) ?? t('Unassigned')}</span>
                  </span>
                </div>
              </>
            ) : null}
            <div className="prop">
              <small>{t('Lead')}</small>
              <span>
                <Avatar name={singleLead} initials={singleLead ? actorInitials(singleLead) : undefined} />
                <span className="cut">{singleLead ?? t('Lead')}</span>
              </span>
            </div>
            {!issue.parentId && progress && progress.total > 0 ? (
              <div className="prop">
                <small>{t('Tasks')}</small>
                <span>
                  {progress.done}/{progress.total}
                </span>
              </div>
            ) : null}
            <div className="prop">
              <small>{t('Delivery')}</small>
              <span>{issue.artifactMode === 'artifact' ? t('Files') : t('Git commit')}</span>
            </div>
            {lastUpdated ? (
              <div className="prop">
                <small>{t('Updated')}</small>
                <span>{dateText(lastUpdated)}</span>
              </div>
            ) : null}
          </aside>
        </div>
      </div>

      {moreOpen && morePos ? (
        <div
          ref={moreMenuRef}
          className="pop"
          role="menu"
          aria-label={t('More')}
          style={{ left: `${morePos.x}px`, top: `${morePos.y}px` }}
        >
          {formActions.map((action) => (
            <button key={action.id} type="button" role="menuitem" onClick={() => void runMoreAction(action.id)}>
              {t(action.labelKey)}
            </button>
          ))}
          {formActions.length > 0 && lifecycleActions.length > 0 ? <hr /> : null}
          {lifecycleActions.map((action) => (
            <button key={action.id} type="button" role="menuitem" onClick={() => void runMoreAction(action.id)}>
              {t(action.labelKey)}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
