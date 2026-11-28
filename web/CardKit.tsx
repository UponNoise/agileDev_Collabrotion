import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { InboxEntry, WorkspaceData } from './api';
import { ApiError, command } from './api';
import { OnlineContext } from './components';
import { afterVersionConflict, cardChange, createDecisionGuard, DECISION_GUARD_MS, isChangedContentCode } from './decision-model';
import type { CardState } from './decision-model';
import { createIntent, formatAge, nextFromEntries } from './card-model';
import type { Problem } from './card-model';
import type { ChangeState, ChangeViewItem } from './changes';
import type { InlinePart, MarkdownBlock } from './markdown';
import { blocks as parseBlocks } from './markdown';
import { usePreferences, useText } from './Preferences';
import { blockerSentence, codeSentence, renderSentence, resolvePartyNames, severitySentence } from './sentences';
import type { PartyNames, Sentence, SentenceValues } from './sentences';

import { isActiveAgent } from './work-model';

export interface CardProps {
  entry: InboxEntry;
  gone: boolean;
  hasNext: boolean;
  onNext(): void;
}

export async function partyNames(workspaceId: string, roleWords: PartyNames): Promise<PartyNames> {
  try {
    const view = await command<WorkspaceData>('ui_workspace', { workspaceId, limit: 1 });
    return resolvePartyNames(
      view.actors.filter(isActiveAgent),
      null,
      roleWords
    );
  } catch {
    return roleWords;
  }
}

export function useNextLine() {
  const render = useSentence();
  const t = useText();
  return useCallback(
    async (workspaceId: string, key: string, values: SentenceValues | ((names: PartyNames) => SentenceValues) = {}) => {
      const names = await partyNames(workspaceId, { lead: t('lead'), pm: t('pm'), dev: t('worker'), qa: t('qa') });
      return render({ key, values: { ...names, ...(typeof values === 'function' ? values(names) : values) } });
    },
    [render, t]
  );
}

export function useEntriesNextLine() {
  const nextLine = useNextLine();
  return useCallback(
    async (workspaceId: string, issueId: string, isParent = false): Promise<string | null> => {
      try {
        const entries: InboxEntry[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const page: { entries: InboxEntry[]; nextOffset: number | null } = await command('inbox_list', {
            workspaceId, offset, limit: 100
          });
          entries.push(...page.entries);
          offset = page.nextOffset;
        }
        const next = nextFromEntries(entries, issueId, isParent);
        if (!next) return null;
        if (next.blocker) {
          return nextLine(workspaceId, next.key, (names) => ({ blocker: blockerSentence(next.blocker, { ...names }) }));
        }
        return nextLine(workspaceId, next.key);
      } catch {
        return null;
      }
    },
    [nextLine]
  );
}

export function useSentence() {
  const { locale } = usePreferences();
  return useCallback((sentence: Sentence) => renderSentence(sentence, locale), [locale]);
}

export function useCodeText() {
  const render = useSentence();
  const t = useText();
  return useCallback(
    (code: string) =>
      render(codeSentence(code, { lead: t('lead'), pm: t('pm'), dev: t('worker'), qa: t('qa'), blockers: '', harness: '' })),
    [render, t]
  );
}

export function useSeverityText() {
  const render = useSentence();
  return useCallback((severity: string) => render(severitySentence(severity)), [render]);
}

function Inline({ parts }: { parts: InlinePart[] }) {
  return (
    <>
      {parts.map((part, index) => {
        switch (part.kind) {
          case 'text':
            return part.text;
          case 'code':
            return <code key={index}>{part.text}</code>;
          case 'strong':
            return <strong key={index}><Inline parts={part.children} /></strong>;
          case 'em':
            return <em key={index}><Inline parts={part.children} /></em>;
          case 'link':
            return <a key={index} href={part.href} target="_blank" rel="noopener noreferrer"><Inline parts={part.children} /></a>;
          case 'image':
            return part.alt;
        }
      })}
    </>
  );
}

export type DocumentRow = { state: ChangeState; block: MarkdownBlock } | { skip: number };

export function plainRows(source: string): DocumentRow[] {
  return parseBlocks(source).map((block) => ({ state: 'unchanged' as const, block }));
}

export function viewRows(items: readonly ChangeViewItem[]): DocumentRow[] {
  return items.map((item) => (item.kind === 'skip' ? { skip: item.count } : { state: item.state, block: item.block }));
}

export function Document({ rows }: { rows: readonly DocumentRow[] }) {
  const t = useText();
  const out: ReactNode[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if ('skip' in row) {
      out.push(<p className="chg-skip" key={index}>{t('{count} unchanged blocks').replace('{count}', String(row.skip))}</p>);
      index += 1;
      continue;
    }
    const block = row.block;
    const mark = `chg-${row.state}`;
    if (block.kind === 'list-item') {
      const start = index;
      const ordered = block.ordered;
      const items: { state: ChangeState; block: Extract<MarkdownBlock, { kind: 'list-item' }> }[] = [];
      while (index < rows.length) {
        const candidate = rows[index]!;
        if ('skip' in candidate || candidate.block.kind !== 'list-item' || candidate.block.ordered !== ordered) break;
        items.push({ state: candidate.state, block: candidate.block });
        index += 1;
      }
      const children = items.map((item, position) => (
        <li key={position} className={`${item.block.depth ? 'nested' : ''} chg-${item.state}`} value={ordered ? item.block.number : undefined}>
          <Inline parts={item.block.inline} />
        </li>
      ));
      out.push(ordered ? <ol key={start}>{children}</ol> : <ul key={start}>{children}</ul>);
      continue;
    }
    if (block.kind === 'table-row') {
      const start = index;
      const tableRows: { state: ChangeState; block: Extract<MarkdownBlock, { kind: 'table-row' }> }[] = [];
      while (index < rows.length) {
        const candidate = rows[index]!;
        if ('skip' in candidate || candidate.block.kind !== 'table-row') break;
        tableRows.push({ state: candidate.state, block: candidate.block });
        index += 1;
      }
      out.push(
        <div className="table-scroll" key={start}>
          <table>
            <tbody>
              {tableRows.map((tableRow, position) => (
                <tr key={position} className={`chg-${tableRow.state}`}>
                  {tableRow.block.cells.map((cell, column) =>
                    tableRow.block.header ? <th key={column}><Inline parts={cell} /></th> : <td key={column}><Inline parts={cell} /></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    index += 1;
    switch (block.kind) {
      case 'heading':
        out.push(block.level <= 2
          ? <h3 key={index} className={mark}><Inline parts={block.inline} /></h3>
          : <h4 key={index} className={mark}><Inline parts={block.inline} /></h4>);
        break;
      case 'paragraph':
        out.push(<p key={index} className={mark}><Inline parts={block.inline} /></p>);
        break;
      case 'quote':
        out.push(<blockquote key={index} className={mark}><Inline parts={block.inline} /></blockquote>);
        break;
      case 'code':
        out.push(<pre key={index} className={`code ${mark}`}><code>{block.text}</code></pre>);
        break;
      case 'rule':
        out.push(<hr key={index} className={mark} />);
        break;
    }
  }
  return <div className="markdown">{out}</div>;
}

export function Markdown({ source }: { source: string }) {
  return <Document rows={plainRows(source)} />;
}

function CopyValue({ value }: { value: string }) {
  const t = useText();
  const [copied, setCopied] = useState(false);
  return (
    <span className="copyable">
      <span className="mono">{value}</span>
      <button
        type="button"
        className="text-button"
        aria-label={`${t('Copy')} ${value}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        {t(copied ? 'Copied' : 'Copy')}
      </button>
    </span>
  );
}

export function AuditDetails({ rows }: { rows: readonly (readonly [string, string | number | null | undefined])[] }) {
  const t = useText();
  const present = [
    ...new Map(
      rows.filter((row): row is readonly [string, string | number] => row[1] !== null && row[1] !== undefined && row[1] !== '')
    ).entries()
  ];
  return (
    <details className="audit">
      <summary>{t('Audit details')}</summary>
      <dl className="metadata">
        {present.map(([label, value]) => (
          <div className="audit-row" key={label}>
            <dt>{t(label)}</dt>
            <dd><CopyValue value={String(value)} /></dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function auditRows(entry: InboxEntry): [string, string | number | null | undefined][] {
  return [
    ['Issue', entry.key],
    ['Issue ID', entry.issueId],
    ['Issue version', entry.target.issueVersion],
    ['Design', entry.target.designId],
    ['Design hash', entry.target.designHash],
    ['Candidate', entry.target.candidateId],
    ['Digest', entry.target.digest],
    ['Run', entry.target.runId],
    ['Run version', entry.target.runVersion],
    ['Lease fence', entry.target.fence],
    ['Message', entry.target.messageId],
    ['Problem report', entry.target.defectId],
    ['Problem report version', entry.target.defectVersion],
    ['Scope decision', entry.target.decisionId]
  ];
}

export function CardFrame({ entry, kindLabel, title, who, children, audit, bar }: {
  entry: InboxEntry;
  kindLabel: string;
  title: string;
  who: ReactNode;
  children: ReactNode;
  audit: readonly (readonly [string, string | number | null | undefined])[];
  bar: ReactNode;
}) {
  const headingId = `card-title-${entry.id.slice(0, 12)}`;
  return (
    <article className="card" aria-labelledby={headingId} data-decision-kind={entry.kind}>
      <div className="card-scroll">
        <header className="card-head">
          <span className="card-kind">{kindLabel}</span>
          <h2 id={headingId} tabIndex={-1}>{title}</h2>
          <p className="card-who">{who}</p>
        </header>
        {children}
        <AuditDetails rows={audit} />
      </div>
      <div className="card-bar">{bar}</div>
    </article>
  );
}

export function WhoWhen({ entry, fallbackName }: { entry: InboxEntry; fallbackName?: string | null }) {
  const t = useText();
  const age = formatAge(entry.ageMs);
  const text = age ? t(age.key).replace('{count}', String(age.count ?? '')) : t('Age unavailable');
  const who = entry.pendingBy?.name ?? fallbackName ?? null;
  return (
    <>
      {who ? <span>{who}</span> : null}
      {who ? ' · ' : null}
      <span>{text}</span>
      {entry.clockSkew ? <span> · {t('Recorded time is ahead of the service clock.')}</span> : null}
    </>
  );
}

export function ProblemList({ problems }: { problems: readonly Problem[] }) {
  const t = useText();
  const severity = useSeverityText();
  if (!problems.length) return <p className="muted">{t('No open problems.')}</p>;
  return (
    <ul className="problems">
      {problems.map((problem) => (
        <li key={problem.id} className={`problem sev-${problem.severity.toLowerCase()}`}>
          <p>
            <strong>{severity(problem.severity)}</strong>
            {problem.state === 'PROPOSED' ? <span className="chip">{t('Not confirmed yet')}</span> : null}
          </p>
          <dl className="plain">
            <dt>{t('Expected behavior')}</dt><dd>{problem.expected}</dd>
            <dt>{t('Actual behavior')}</dt><dd>{problem.actual}</dd>
            <dt>{t('Reproduction steps')}</dt><dd>{problem.reproduce}</dd>
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="card-section" id={id}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function Bar({ changed, onSeeChanges, error, children }: {
  changed: boolean;
  onSeeChanges(): void;
  error: string | null;
  children: ReactNode;
}) {
  const t = useText();
  const codeText = useCodeText();
  if (changed)
    return (
      <div className="bar bar-changed" role="alert">
        <p>{t('Just changed; nothing was recorded')}</p>
        <button type="button" className="primary" onClick={onSeeChanges}>{t('See what changed')}</button>
      </div>
    );
  return (
    <div className="bar">
      {error ? <p className="error" role="alert">{codeText(error)}</p> : null}
      {children}
    </div>
  );
}

export function ReasonBox({ label, value, onChange, submitLabel, onSubmit, onCancel, disabled, extra }: {
  label: string;
  value: string;
  onChange(value: string): void;
  submitLabel: string;
  onSubmit(): void;
  onCancel(): void;
  disabled: boolean;
  extra?: ReactNode;
}) {
  const t = useText();
  const field = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      cancelRef.current();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, []);
  return (
    <div className="reason-box">
      {extra}
      <label className="field">
        <span>{label}</span>
        <textarea
          ref={field}
          rows={3}
          maxLength={65536}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="bar-row">
        <button type="button" onClick={onCancel}>{t('Cancel')}</button>
        <button type="button" className="primary" disabled={disabled || !value.trim()} onClick={onSubmit}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export function Recorded({ recorded, next, onNext, hasNext }: {
  recorded: string;
  next: string | null;
  onNext(): void;
  hasNext: boolean;
}) {
  const t = useText();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { button.current?.focus(); }, []);
  return (
    <div className="recorded" role="status" aria-live="polite">
      <p className="recorded-line">{recorded}</p>
      {next ? <p className="muted">{next}</p> : null}
      <button ref={button} type="button" className="primary" disabled={!hasNext} onClick={onNext}>{t('Next decision')}</button>
    </div>
  );
}

export function useCtrlEnter(run: (() => void) | null) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      if (!latest.current) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, []);
}

export function useReasonShortcut(open: (() => void) | null) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'r' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (!latest.current) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, []);
}

export interface CardOptions<D> {
  entryId: string;
  load(): Promise<D>;
  describe(data: D): CardState;
}

export interface DecideContext<D> {
  data: D;
  version: number;
}

export function useCard<D>(options: CardOptions<D>) {
  const online = useContext(OnlineContext);
  const [data, setData] = useState<D | null>(null);
  const [previous, setPrevious] = useState<D | null>(null);
  const [changed, setChanged] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [seen, setSeen] = useState(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dataRef = useRef<D | null>(null);
  const shownRef = useRef<CardState | null>(null);
  const latestRef = useRef<D | null>(null);
  const forcedRef = useRef(false);
  const busyRef = useRef(false);
  const guard = useRef(createDecisionGuard(() => Date.now()));
  const intent = useRef(createIntent());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const arm = useCallback(() => {
    guard.current.arm();
    setReady(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setReady(true), DECISION_GUARD_MS);
  }, []);
  const show = useCallback((next: D) => {
    dataRef.current = next;
    shownRef.current = optionsRef.current.describe(next);
    setData(next);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    let active = true;
    let poll: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const fresh = await optionsRef.current.load();
        if (!active) return;
        setLoadFailed(false);
        latestRef.current = fresh;
        if (!shownRef.current) {
          show(fresh);
          arm();
        } else if (!busyRef.current) {
          const verdict = cardChange(shownRef.current, optionsRef.current.describe(fresh));
          if (verdict === 'changed') setChanged(true);
          else {
            if (verdict === 'version-only') show(fresh);
            if (!forcedRef.current) setChanged(false);
          }
        }
      } catch {
        if (active) setLoadFailed(true);
      } finally {
        if (active) poll = setTimeout(tick, 1000);
      }
    };
    void tick();
    return () => { active = false; clearTimeout(poll); };
  }, [options.entryId, arm, show]);
  const seeChanges = useCallback(() => {
    const fresh = latestRef.current;
    if (!fresh) return;
    setPrevious(dataRef.current);
    show(fresh);
    forcedRef.current = false;
    setChanged(false);
    setError(null);
    arm();
    setSeen((count) => count + 1);
  }, [arm, show]);
  const refetch = useCallback(async () => {
    const fresh = await optionsRef.current.load();
    latestRef.current = fresh;
    return fresh;
  }, []);
  const decide = useCallback(async <R,>(operation: string, build: (context: DecideContext<D>) => object): Promise<R | null> => {
    const shown = shownRef.current;
    if (!shown || dataRef.current === null || busyRef.current || !online || guard.current.blocked()) return null;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const attempt = async (version: number, resubmitted: boolean, forcedKey?: string): Promise<R | null> => {
      const input = build({ data: dataRef.current!, version });
      if (forcedKey) intent.current.adopt(input, forcedKey);
      const key = intent.current.keyFor(input);
      try {
        const result = await command<R>(operation, { ...input, idempotencyKey: key });
        intent.current.clear();
        return result;
      } catch (failure) {
        if (!(failure instanceof ApiError)) {
          setError('SERVICE_UNAVAILABLE');
          return null;
        }
        if (isChangedContentCode(failure.code)) {
          await refetch().catch(() => undefined);
          forcedRef.current = true;
          setChanged(true);
          return null;
        }
        if (failure.code === 'VERSION_CONFLICT') {
          const fresh = await refetch().catch(() => null);
          if (!fresh) {
            setError('SERVICE_UNAVAILABLE');
            return null;
          }
          const outcome = afterVersionConflict({
            shown,
            current: optionsRef.current.describe(fresh),
            previousIdempotencyKey: key,
            nextIdempotencyKey: crypto.randomUUID(),
            alreadyResubmitted: resubmitted
          });
          if (outcome.action === 'resubmit') {
            show(fresh);
            return attempt(outcome.issueVersion, true, outcome.idempotencyKey);
          }
          if (outcome.action === 'changed') {
            forcedRef.current = true;
            setChanged(true);
            return null;
          }
          setError('INVALID_TRANSITION');
          return null;
        }
        setError(failure.code);
        return null;
      }
    };
    try {
      return await attempt(shown.issueVersion, false);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [online, refetch, show]);
  return { data, previous, changed, loadFailed, busy, error, setError, ready, seen, online, seeChanges, decide, refetch, guard: guard.current };
}

export function useScrollToChange(seen: number) {
  useEffect(() => {
    if (!seen) return;
    document.getElementById('card-changes')?.scrollIntoView({ block: 'start' });
  }, [seen]);
}

export function ChangeNotice({ seen, lines }: { seen: number; lines: readonly string[] }) {
  const t = useText();
  useScrollToChange(seen);
  if (!seen) return null;
  return (
    <section className="card-section change-notice" id="card-changes">
      <h3>{t('What changed')}</h3>
      {lines.length ? <ul>{lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul> : <p>{t('The content was updated.')}</p>}
    </section>
  );
}
