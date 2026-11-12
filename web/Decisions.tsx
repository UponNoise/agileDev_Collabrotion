import { useEffect, useRef, useState } from 'react';
import type { Actor, InboxKind, Workspace } from '../src/contracts';
import type { InboxEntry, InboxSettings } from './api';
import { ApiError, command, errorText, mutation } from './api';
import { Empty, Field } from './components';
import { useDateText, useText } from './Preferences';

export const decisionKinds: Record<InboxKind, string> = {
  DESIGN_REVIEW: 'Design review',
  DELIVERY_ACCEPTANCE: 'Delivery acceptance',
  SCOPE_DECISION: 'Scope decision',
  RUN_RECONCILE: 'Execution reconciliation',
  CLOSURE_BLOCKED: 'Accepted delivery'
};
interface Counts { total: number; blocking: number; byKind: Record<InboxKind, number> }
export interface InboxData {
  entries: InboxEntry[];
  total: number;
  nextOffset: number | null;
  summary: Counts;
  workspaces: (Counts & { workspaceId: string; name: string; settings: InboxSettings })[];
  generatedAt: string;
}
export interface DecisionFilter { workspaceId: string; kind: string; offset: number }
const unfiltered: DecisionFilter = { workspaceId: '', kind: '', offset: 0 };

export function useDecisionInbox(actor: Actor | null, refresh: number, filter: DecisionFilter, visible: boolean) {
  const [result, setResult] = useState<{ data: InboxData | null; global: InboxData | null; error: unknown; loading: boolean }>({ data: null, global: null, error: null, loading: true });
  const { workspaceId, kind, offset } = visible ? filter : unfiltered;
  useEffect(() => {
    if (!actor) {
      setResult({ data: null, global: null, error: null, loading: true });
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setResult(previous => ({ ...previous, data: null, loading: true, error: null }));
    const load = async () => {
      try {
        const filtered = !!workspaceId || !!kind || offset !== 0;
        const query = { ...(workspaceId ? { workspaceId } : {}), ...(kind ? { kind } : {}), offset, limit: 20 };
        const [data, global] = filtered
          ? await Promise.all([command<InboxData>('inbox_list', query), command<InboxData>('inbox_list', { limit: 1 })])
          : await command<InboxData>('inbox_list', query).then(value => [value, value]);
        if (active) setResult({ data, global, error: null, loading: false });
      } catch (error) {
        if (active) setResult(previous => ({ ...previous, error, loading: false }));
      } finally {
        if (active) timer = setTimeout(load, 1000);
      }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [actor, refresh, workspaceId, kind, offset]);
  return result;
}

function Entry({ entry, threshold, open }: { entry: InboxEntry; threshold: number; open(entry: InboxEntry): void }) {
  const t = useText();
  const dateText = useDateText();
  const age = entry.ageMs;
  const ageText = age === null ? t('Age unavailable') : age < 60000 ? t('Less than a minute') : age < 3600000
    ? t('{count} min').replace('{count}', String(Math.floor(age / 60000)))
    : t('{count} h').replace('{count}', String(Math.floor(age / 3600000)));
  return (
    <article className="decision-row" data-decision-kind={entry.kind}>
      <div className="decision-copy">
        <div className="decision-labels">
          <strong>{t(decisionKinds[entry.kind])}</strong>
          <span className={`status ${entry.status === 'READY_TO_COMPLETE' ? 'good' : entry.blocking ? 'review' : 'neutral'}`}>
            {t(entry.status === 'READY_TO_COMPLETE' ? 'Ready to complete' : entry.blocking ? 'Decision required' : 'Acceptance recorded')}
          </span>
        </div>
        <a href={entry.target.runId ? `/?${new URLSearchParams({ workspace: entry.workspaceId, view: 'runs', run: entry.target.runId })}` : `${entry.url}?view=reviews`}
          onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); open(entry); } }}>
          <span className="mono">{entry.key}</span> {entry.title}
        </a>
        <p className="decision-age">
          <span className={age !== null && age > threshold * 3600000 ? 'decision-aged' : ''}>{ageText}</span>
          {entry.pendingSince ? <span> · {t('Pending since')} <time dateTime={entry.pendingSince}>{dateText(entry.pendingSince)}</time></span> : <span> · {t('Historical pending time was not recorded.')}</span>}
          {entry.clockSkew ? <span> · {t('Recorded time is ahead of the service clock.')}</span> : null}
        </p>
        {entry.blockers.length ? <p className="decision-blockers">{t('Current blockers')}: {entry.blockers.join(' · ')}</p> : null}
        {entry.kind === 'CLOSURE_BLOCKED' ? <p className="muted">{t('Acceptance is saved. Inspect current guards, then use Recheck closure; no second acceptance is needed.')}</p> : null}
        <details className="decision-target">
          <summary>{t('Exact decision target')}</summary>
          <dl className="metadata">
            <dt>{t('Issue version')}</dt><dd>{entry.target.issueVersion}</dd>
            {Object.entries(entry.target).filter(([key, value]) => key !== 'issueVersion' && value !== null).map(([key, value]) => <div className="decision-target-field" key={key}><dt>{key}</dt><dd className="mono">{String(value)}</dd></div>)}
          </dl>
        </details>
      </div>
      <button onClick={() => open(entry)}>{t(entry.target.runId ? 'Inspect run' : entry.status === 'READY_TO_COMPLETE' ? 'Inspect completion' : 'Review item')}</button>
    </article>
  );
}

export function Decisions({ feed, filter, setFilter, workspaces, open, retry }: {
  feed: ReturnType<typeof useDecisionInbox>;
  filter: DecisionFilter;
  setFilter(filter: DecisionFilter): void;
  workspaces: Workspace[];
  open(entry: InboxEntry): void;
  retry(): void;
}) {
  const t = useText();
  const data = feed.data;
  return (
    <section className="decisions" aria-label={t('Human decisions')}>
      <div className="decision-filters">
        <Field label={t('Decision workspace')}><select value={filter.workspaceId} onChange={event => setFilter({ ...filter, workspaceId: event.target.value, offset: 0 })}>
          <option value="">{t('All readable workspaces')}</option>
          {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select></Field>
        <Field label={t('Decision kind')}><select value={filter.kind} onChange={event => setFilter({ ...filter, kind: event.target.value, offset: 0 })}>
          <option value="">{t('All decision kinds')}</option>
          {Object.entries(decisionKinds).map(([kind, label]) => <option key={kind} value={kind}>{t(label)}</option>)}
        </select></Field>
      </div>
      {feed.error ? <div className="error" role="alert"><p>{t(errorText(feed.error))}</p><p>{t('The inbox could not refresh. Any visible records may be stale; opening an item revalidates it.')}</p><button onClick={retry}>{t('Retry')}</button></div> : null}
      {feed.loading ? <p role="status">{t('Loading decisions…')}</p> : data?.entries.length ? (
        <>
          {data.workspaces.filter(workspace => data.entries.some(entry => entry.workspaceId === workspace.workspaceId)).map(workspace => (
            <section className="decision-group" aria-labelledby={`decisions-${workspace.workspaceId}`} key={workspace.workspaceId}>
              <h2 id={`decisions-${workspace.workspaceId}`}>{workspace.name}</h2>
              {data.entries.filter(entry => entry.workspaceId === workspace.workspaceId).map(entry => <Entry key={entry.id} entry={entry} threshold={workspace.settings.agingThresholdHours} open={open} />)}
            </section>
          ))}
        </>
      ) : data ? <Empty title={t(filter.kind || filter.workspaceId ? 'No matching decisions' : 'Nothing is waiting on you')}><p>{t('New design reviews, delivery acceptances, scope decisions, and execution reconciliations appear here.')}</p></Empty> : null}
      {data ? <footer className="pagination">
        <span>{t('{count} decisions').replace('{count}', String(data.total))} · {t('page {page}').replace('{page}', String(filter.offset / 20 + 1))}</span>
        <button disabled={!filter.offset || feed.loading} onClick={() => setFilter({ ...filter, offset: Math.max(0, filter.offset - 20) })}>{t('Previous')}</button>
        <button disabled={data.nextOffset === null || feed.loading} onClick={() => setFilter({ ...filter, offset: data.nextOffset! })}>{t('Next')}</button>
      </footer> : null}
    </section>
  );
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
