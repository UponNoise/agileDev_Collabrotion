import { useEffect, useMemo, useRef, useState } from 'react';
import type { Actor, InboxKind, Workspace } from '../src/contracts';
import type { InboxEntry, InboxSettings } from './api';
import { ApiError, command, errorText, mutation } from './api';
import { Empty, Field } from './components';
import { formatAge, matchOpenEntry, rowTitle } from './card-model';
import { useCodeText, useSentence } from './CardKit';
import type { CardProps } from './CardKit';
import { DefectCard, QuestionCard } from './DefectCard';
import { DeliveryCard } from './DeliveryCard';
import { DesignCard } from './DesignCard';
import { groupEntries } from './decision-model';
import type { ListGroup } from './decision-model';
import { ClosureCard, RunCard } from './RunCard';
import { ScopeCard } from './ScopeReview';
import { useText } from './Preferences';
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

export function useDecisionInbox(actor: Actor | null, refresh: number, filter: DecisionFilter, visible: boolean) {
  const [result, setResult] = useState<{ data: InboxData | null; global: InboxData | null; error: unknown; loading: boolean }>({ data: null, global: null, error: null, loading: true });
  const wanted = visible ? Math.max(PAGE, filter.limit ?? PAGE) : 1;
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

function typing(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
}

export function Decisions({ feed, filter, setFilter, workspaces, open, retry }: {
  feed: ReturnType<typeof useDecisionInbox>;
  filter: DecisionFilter;
  setFilter(filter: DecisionFilter): void;
  workspaces: Workspace[];
  open?(entry: InboxEntry): void;
  retry(): void;
}) {
  const t = useText();
  const render = useSentence();
  const codeText = useCodeText();
  const data = feed.data;
  const groups = useMemo(() => groupEntries(data?.entries ?? []), [data]);
  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const [slot, setSlot] = useState<{ key: string; entry: InboxEntry } | null>(null);
  const [want, setWant] = useState(() => readWant());
  const remembered = useRef<{ entry: InboxEntry; index: number } | null>(null);
  const openSlot = (entry: InboxEntry) => {
    remembered.current = { entry, index: Math.max(0, flat.indexOf(entry)) };
    setSlot({ key: entry.id, entry });
  };
  const matched = slot ? matchOpenEntry(flat, slot.entry) : null;
  useEffect(() => {
    const pop = () => setWant(readWant());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (!data) return;
    if (want) {
      const match = flat.find((entry) => entry.issueId === want.issueId && entry.kind === want.kind);
      if (match && matched?.id !== match.id) openSlot(match);
      setWant(null);
      return;
    }
    if (!slot && flat.length) openSlot(flat[0]!);
  }, [data, flat, want, slot, matched?.id]);
  if (matched) remembered.current = { entry: matched, index: flat.indexOf(matched) };
  const current = matched ?? (slot && remembered.current ? remembered.current.entry : null);
  const gone = !!current && !matched;
  const currentId = matched?.id ?? slot?.entry.id ?? null;
  const hasNext = flat.some((entry) => entry.id !== currentId);
  const go = (delta: 1 | -1) => {
    const count = flat.length;
    if (!count) return;
    const position = matched ? flat.indexOf(matched) : (remembered.current?.index ?? 0);
    const index = matched
      ? (position + delta + count) % count
      : delta === 1 ? Math.min(position, count - 1) : (position - 1 + count) % count;
    const target = flat[index]!;
    if (target.id !== matched?.id) openSlot(target);
  };
  const nextOne = () => { if (hasNext) go(1); };
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || typing(event.target)) return;
      if (event.key.toLowerCase() === 'j') go(1);
      else if (event.key.toLowerCase() === 'k') go(-1);
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  });
  const more = data !== null && data.nextOffset !== null;
  const showWorkspace = workspaces.length > 1;
  return (
    <section className="decisions" aria-label={t('Human decisions')}>
      {feed.error ? (
        <div className="error" role="alert">
          <p>{feed.error instanceof ApiError ? codeText(feed.error.code) : codeText('SERVICE_UNAVAILABLE')}</p>
          <button onClick={retry}>{t('Retry')}</button>
        </div>
      ) : null}
      {feed.loading && !data ? <p role="status">{t('Loading decisions…')}</p> : null}
      {data && !flat.length && !current ? (
        <Empty title={t('Nothing is waiting on you')}><p>{t('New decisions appear here.')}</p></Empty>
      ) : null}
      {data && (flat.length || current) ? (
        <div className="decisions-layout">
          <nav className="decision-rail" aria-label={t('Decisions')}>
            {!flat.length ? <p className="muted">{t('Nothing is waiting on you')}</p> : null}
            {groups.filter((group) => group.entries.length).map((group) => (
              <section key={group.group} aria-labelledby={`rail-${group.group}`}>
                <h2 id={`rail-${group.group}`}>{render({ key: groupLabel[group.group], values: {} })} <span className="rail-count">{group.entries.length}</span></h2>
                <ul>
                  {group.entries.map((entry) => {
                    const age = formatAge(entry.ageMs);
                    return (
                      <li key={entry.id}>
                        <a
                          href={entry.url}
                          aria-current={entry.id === currentId ? 'true' : undefined}
                          onClick={(event) => {
                            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                            event.preventDefault();
                            if (matched?.id !== entry.id) openSlot(entry);
                          }}
                        >
                          <span className="rail-title">{rowTitle(entry)}</span>
                          <span className="rail-meta">
                            {render(kindSentence(entry.kind))}
                            {showWorkspace ? ` · ${entry.workspaceName}` : ''}
                            {age ? ` · ${t(age.key).replace('{count}', String(age.count ?? ''))}` : ''}
                            {entry.status === 'READY_TO_COMPLETE' ? ` · ${t('Ready')}` : ''}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {more ? <button type="button" onClick={() => setFilter({ ...filter, limit: (filter.limit ?? PAGE) + PAGE })}>{t('Show more')}</button> : null}
          </nav>
          <div className="decision-panel">
            {current && slot ? (
              <>
                {open ? <p className="card-links"><a href={current.url} onClick={(event) => { event.preventDefault(); open(current); }}>{t('Open the issue')}</a></p> : null}
                <Card key={slot.key} entry={current} gone={gone} hasNext={hasNext} onNext={nextOne} />
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function readWant() {
  const query = new URLSearchParams(location.search);
  const issueId = query.get('issue');
  const kind = query.get('kind');
  return issueId && kind ? { issueId, kind } : null;
}

export function InboxSettingsForm({ workspaceId, onSaved }: { workspaceId: string; onSaved(): void }) {
  const t = useText();
  const [settings, setSettings] = useState<InboxSettings | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const intent = useRef<{ payload: string; key: string } | null>(null);
  async function reload(keepInput: boolean) {
    setBusy(true);
    try {
      const result = await command<{ settings: InboxSettings }>('inbox_settings_get', { workspaceId });
      setSettings(result.settings);
      if (!keepInput) setValue(String(result.settings.agingThresholdHours));
      setConflict(false);
      setError('');
      intent.current = null;
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void reload(false); }, [workspaceId]);
  return (
    <section className="appearance inbox-settings" aria-labelledby="inbox-settings-title">
      <h2 id="inbox-settings-title">{t('Decision attention')}</h2>
      <p className="muted">{t('Aging is an advisory reminder for this workspace. It never advances a gate or changes an approval.')}</p>
      <form onSubmit={async event => {
        event.preventDefault();
        if (!settings || busy || conflict) return;
        const input = { workspaceId, expectedVersion: settings.version, agingThresholdHours: Number(value) };
        const payload = JSON.stringify(input);
        if (intent.current?.payload !== payload) intent.current = { payload, key: crypto.randomUUID() };
        setBusy(true); setError(''); setSaved(false);
        try {
          const result = await mutation<{ settings: InboxSettings }>('inbox_settings_update', { ...input, idempotencyKey: intent.current.key });
          setSettings(result.settings); setSaved(true); intent.current = null; onSaved();
        } catch (failure) {
          setConflict(failure instanceof ApiError && failure.code === 'VERSION_CONFLICT');
          setError(errorText(failure));
        } finally { setBusy(false); }
      }}>
        <Field label={t('Aging threshold (hours)')} hint={t('Choose a whole number from 1 to 168.')}>
          <input type="number" min="1" max="168" step="1" required value={value} disabled={!settings || busy} onChange={event => { setValue(event.target.value); setSaved(false); }} />
        </Field>
        {settings ? <p className="muted">{t('Settings version')}: {settings.version} · {t('Saved threshold')}: {settings.agingThresholdHours} {t('hours')}</p> : null}
        {error ? <p className="error" role="alert">{t(error)}</p> : null}
        {conflict ? <p>{t('Another session changed these settings. Reload the version, review the saved threshold, and submit again. Your input is kept.')}</p> : null}
        {saved ? <p role="status">{t('Attention settings saved.')}</p> : null}
        <div className="decision-settings-actions">
          <button type="submit" disabled={!settings || busy || conflict}>{t(busy ? 'Saving…' : 'Save attention settings')}</button>
          {conflict || !settings && error ? <button type="button" disabled={busy} onClick={() => void reload(!!settings)}>{t('Reload settings version')}</button> : null}
        </div>
      </form>
    </section>
  );
}
