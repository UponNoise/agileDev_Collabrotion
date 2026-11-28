import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Actor, InboxKind, Workspace } from '../src/contracts';
import type { InboxEntry, InboxSettings } from './api';
import { ApiError, command } from './api';
import { formatAge, matchOpenEntry, rowTitle } from './card-model';
import { useCodeText, useSentence } from './CardKit';
import type { CardProps } from './CardKit';
import { DefectCard, QuestionCard } from './DefectCard';
import { DeliveryCard } from './DeliveryCard';
import { DesignCard } from './DesignCard';
import { groupEntries } from './decision-model';
import type { ListGroup } from './decision-model';
import { StatusIcon, UiIcon } from './Icons';
import type { UiIconName } from './Icons';
import { useText } from './Preferences';
import { ClosureCard, RunCard } from './RunCard';
import { ScopeCard } from './ScopeReview';
import { kindSentence } from './sentences';

interface Counts { total: number; blocking: number; attention: number; byKind: Record<InboxKind, number> }
export interface InboxData {
  entries: InboxEntry[];
  total: number;
  nextOffset: number | null;
  summary: Counts;
  workspaces: (Counts & { workspaceId: string; name: string; settings: InboxSettings })[];
  generatedAt: string;
}
export interface DecisionFilter { workspaceId: string; kind: string; offset: number; limit?: number }
const PAGE = 20;

export function useDecisionInbox(actor: Actor | null, refresh: number, limit: number) {
  const [result, setResult] = useState<{ data: InboxData | null; global: InboxData | null; error: unknown; loading: boolean }>({
    data: null,
    global: null,
    error: null,
    loading: true
  });
  const wanted = Math.max(PAGE, limit);
  useEffect(() => {
    if (!actor) {
      setResult({ data: null, global: null, error: null, loading: true });
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setResult((previous) => ({ ...previous, loading: previous.data === null, error: null }));
    const load = async () => {
      try {
        const data = await command<InboxData>('inbox_list', { offset: 0, limit: Math.min(100, wanted) });
        let next = data.nextOffset;
        while (active && next !== null && data.entries.length < wanted) {
          const page = await command<InboxData>('inbox_list', { offset: next, limit: Math.min(100, wanted - data.entries.length) });
          data.entries.push(...page.entries);
          next = page.nextOffset;
          data.nextOffset = next;
        }
        if (active) setResult({ data, global: data, error: null, loading: false });
      } catch (error) {
        if (active) setResult((previous) => ({ ...previous, error, loading: false }));
      } finally {
        if (active) timer = setTimeout(load, 1000);
      }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [actor, refresh, wanted]);
  return result;
}

export function openDecisionCard(workspaceId: string, issueId: string, kind: InboxKind) {
  history.pushState(null, '', `/?${new URLSearchParams({ workspace: workspaceId, view: 'decisions', issue: issueId, kind })}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function Card(props: CardProps) {
  switch (props.entry.kind) {
    case 'DESIGN_REVIEW': return <DesignCard {...props} />;
    case 'DELIVERY_ACCEPTANCE': return <DeliveryCard {...props} />;
    case 'SCOPE_DECISION': return <ScopeCard {...props} />;
    case 'RUN_RECONCILE': return <RunCard {...props} />;
    case 'CLOSURE_BLOCKED': return <ClosureCard {...props} />;
    case 'DEFECT_TRIAGE': return <DefectCard {...props} />;
    case 'AGENT_QUESTION': return <QuestionCard {...props} />;
  }
}

const groupLabel: Record<ListGroup, string> = { 'needs-you': 'Needs you', accepted: 'Accepted', later: 'Later' };

const kindIcon: Record<InboxKind, UiIconName> = {
  DESIGN_REVIEW: 'doc',
  DELIVERY_ACCEPTANCE: 'pkg',
  SCOPE_DECISION: 'scope',
  RUN_RECONCILE: 'alert',
  CLOSURE_BLOCKED: 'lock',
  DEFECT_TRIAGE: 'bug',
  AGENT_QUESTION: 'chat'
};

export interface DecisionTarget {
  entryId: string | null;
  issueId: string | null;
  kind: InboxKind | null;
}

export function useDecisionSelection(
  data: InboxData | null,
  target: DecisionTarget,
  active: boolean,
  onSelectUrl?: (entry: InboxEntry) => void
) {
  const groups = useMemo(() => groupEntries(data?.entries ?? []), [data]);
  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const [slot, setSlot] = useState<{ key: string; entry: InboxEntry } | null>(null);
  const remembered = useRef<{ entry: InboxEntry; index: number } | null>(null);
  const lastTarget = useRef<string>('');

  const openSlot = useCallback(
    (entry: InboxEntry, updateUrl = false) => {
      remembered.current = { entry, index: Math.max(0, flat.indexOf(entry)) };
      setSlot({ key: entry.id, entry });
      if (updateUrl) onSelectUrl?.(entry);
    },
    [flat, onSelectUrl]
  );

  const matched = slot ? matchOpenEntry(flat, slot.entry) : null;

  useEffect(() => {
    if (!data || !active) return;
    const key = `${target.entryId ?? ''}|${target.issueId ?? ''}|${target.kind ?? ''}`;
    if (key !== lastTarget.current && (target.entryId || (target.issueId && target.kind))) {
      const found = target.entryId
        ? flat.find((entry) => entry.id === target.entryId)
        : flat.find((entry) => entry.issueId === target.issueId && entry.kind === target.kind);
      if (found) {
        lastTarget.current = key;
        if (matched?.id !== found.id) openSlot(found, false);
        return;
      }
      if (!data.nextOffset) lastTarget.current = key;
    }
    if (!slot && flat.length) {
      openSlot(flat[0]!, false);
    }
  }, [active, data, flat, target.entryId, target.issueId, target.kind, slot, matched?.id, openSlot]);

  if (matched) remembered.current = { entry: matched, index: flat.indexOf(matched) };
  const current = matched ?? (slot && remembered.current ? remembered.current.entry : null);
  const gone = Boolean(current && !matched);
  const currentId = matched?.id ?? slot?.entry.id ?? null;
  const currentIndex = matched ? flat.indexOf(matched) : -1;
  const hasNext = flat.some((entry) => entry.id !== currentId);

  const step = useCallback(
    (delta: 1 | -1) => {
      const count = flat.length;
      if (!count) return;
      const position = matched ? flat.indexOf(matched) : (remembered.current?.index ?? 0);
      const index = matched
        ? (position + delta + count) % count
        : delta === 1
          ? Math.min(position, count - 1)
          : (position - 1 + count) % count;
      const next = flat[index]!;
      if (next.id !== matched?.id) openSlot(next, true);
    },
    [flat, matched, openSlot]
  );

  return {
    groups,
    flat,
    slot,
    current,
    matched,
    gone,
    currentId,
    currentIndex,
    hasNext,
    select: (entry: InboxEntry) => openSlot(entry, true),
    step,
    nextOne: () => {
      if (hasNext) step(1);
    }
  };
}

export function DecisionRailList({
  feed,
  selection,
  workspaces,
  onMore,
  onSelected
}: {
  feed: ReturnType<typeof useDecisionInbox>;
  selection: ReturnType<typeof useDecisionSelection>;
  workspaces: Workspace[];
  onMore(): void;
  onSelected?(): void;
}) {
  const t = useText();
  const render = useSentence();
  const data = feed.data;
  const showWorkspace = workspaces.length > 1;
  const more = data !== null && data.nextOffset !== null;

  if (feed.loading && !data) {
    return <div className="ctx-h">{t('Loading decisions…')}</div>;
  }
  if (!selection.flat.length) {
    return <div className="ctx-h">{t('Nothing is waiting for you')}</div>;
  }

  return (
    <>
      {selection.groups
        .filter((group) => group.entries.length > 0)
        .map((group) => (
          <div key={group.group} className="ctx-group">
            <div className="ctx-h">{render({ key: groupLabel[group.group], values: {} })}</div>
            {group.entries.map((entry) => {
              const age = formatAge(entry.ageMs);
              const ageLabel =
                entry.status === 'READY_TO_COMPLETE'
                  ? t('Ready')
                  : age
                    ? t(age.key).replace('{count}', String(age.count ?? ''))
                    : '';
              const href = `/?${new URLSearchParams({ workspace: entry.workspaceId, view: 'decisions', entry: entry.id })}`;
              return (
                <a
                  key={entry.id}
                  href={href}
                  className={`ent ${entry.kind === 'RUN_RECONCILE' ? 'crit' : ''}`}
                  aria-current={entry.id === selection.currentId ? 'true' : undefined}
                  onClick={(event) => {
                    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    selection.select(entry);
                    onSelected?.();
                  }}
                >
                  <UiIcon name={kindIcon[entry.kind]} size={15} />
                  <span className="t">{rowTitle(entry)}</span>
                  <span />
                  <span className="s">
                    <span className="cut">
                      {render(kindSentence(entry.kind))}
                      {showWorkspace ? ` · ${entry.workspaceName}` : ''}
                    </span>
                    {ageLabel ? <time>{ageLabel}</time> : null}
                  </span>
                </a>
              );
            })}
          </div>
        ))}
      {more ? (
        <button type="button" className="btn ghost sm ctx-more" onClick={onMore}>
          {t('Show more')}
        </button>
      ) : null}
    </>
  );
}

export function DecisionPane({
  feed,
  selection,
  activeWorkspaceId,
  liveRunCount,
  onMenu,
  onOpenIssue,
  onOpenWork,
  onRetry
}: {
  feed: ReturnType<typeof useDecisionInbox>;
  selection: ReturnType<typeof useDecisionSelection>;
  activeWorkspaceId: string | null;
  liveRunCount: number;
  onMenu(): void;
  onOpenIssue(workspaceId: string, issueId: string): void;
  onOpenWork(): void;
  onRetry(): void;
}) {
  const t = useText();
  const codeText = useCodeText();
  const data = feed.data;
  const current = selection.current;
  const count = selection.flat.length;
  const position = selection.currentIndex;

  return (
    <>
      <header className="bar">
        <button
          type="button"
          className="icon-btn menu-btn"
          aria-label={t('Open navigation')}
          onClick={onMenu}
        >
          <UiIcon name="menu" />
        </button>
        {current ? (
          <>
            <div className="crumb">
              {activeWorkspaceId && current.workspaceId !== activeWorkspaceId ? (
                <>
                  <span className="cut">{current.workspaceName}</span>
                  <UiIcon name="chev" size={12} />
                </>
              ) : null}
              <b>{current.key}</b>
            </div>
            <a
              className="btn ghost sm"
              href={`/w/${encodeURIComponent(current.workspaceId)}/issues/${encodeURIComponent(current.issueId)}`}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onOpenIssue(current.workspaceId, current.issueId);
              }}
            >
              {t('Open issue')}
            </a>
            {count > 0 && position >= 0 ? (
              <>
                <span className="pos">{position + 1} / {count}</span>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={count <= 1}
                  title={`${t('Previous')} (K)`}
                  aria-label={t('Previous')}
                  onClick={() => selection.step(-1)}
                >
                  <UiIcon name="up" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={count <= 1}
                  title={`${t('Next')} (J)`}
                  aria-label={t('Next')}
                  onClick={() => selection.step(1)}
                >
                  <UiIcon name="chevd" />
                </button>
              </>
            ) : null}
          </>
        ) : (
          <h1>{t('Decisions')}</h1>
        )}
      </header>
      {feed.error && !data ? (
        <div className="scroll">
          <div className="center">
            <div className="empty" role="alert">
              <h2>{feed.error instanceof ApiError ? codeText(feed.error.code) : codeText('SERVICE_UNAVAILABLE')}</h2>
              <button type="button" className="btn" onClick={onRetry}>
                {t('Retry')}
              </button>
            </div>
          </div>
        </div>
      ) : feed.loading && !data ? (
        <div className="scroll">
          <div className="center">
            <div className="empty" role="status">
              <p>{t('Loading decisions…')}</p>
            </div>
          </div>
        </div>
      ) : current && selection.slot ? (
        <div className="decision-host">
          <Card
            key={selection.slot.key}
            entry={current}
            gone={selection.gone}
            hasNext={selection.hasNext}
            onNext={selection.nextOne}
          />
        </div>
      ) : (
        <div className="scroll">
          <div className="center">
            <div className="empty">
              <StatusIcon kind="done" />
              <h2>{t('Nothing is waiting for you')}</h2>
              <p>{t('New decisions appear here.')}</p>
              {liveRunCount > 0 ? (
                <a
                  className="btn"
                  href={`/?${new URLSearchParams({ ...(activeWorkspaceId ? { workspace: activeWorkspaceId } : {}), view: 'work' })}`}
                  onClick={(event) => {
                    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onOpenWork();
                  }}
                >
                  {t('{count} runs in progress').replace('{count}', String(liveRunCount))}
                </a>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
