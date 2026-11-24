import { useState } from 'react';
import { command } from './api';
import type { ScopeData } from './api';
import { Bar, CardFrame, ChangeNotice, Recorded, Section, WhoWhen, auditRows, useCard, useCtrlEnter, useNextLine, useReasonShortcut, useSentence } from './CardKit';
import type { CardProps } from './CardKit';
import { cardShown } from './decision-model';
import { useDateText, useText } from './Preferences';
import { kindSentence } from './sentences';

type Choice = 'EXCLUDE' | 'REPLACE' | 'RESTORE';

export function ScopeCard({ entry, gone, hasNext, onNext }: CardProps) {
  const t = useText();
  const render = useSentence();
  const dateText = useDateText();
  const nextLine = useNextLine();
  const card = useCard<ScopeData>({
    entryId: entry.id,
    load: () => command<ScopeData>('scope_get', { workspaceId: entry.workspaceId, issueId: entry.issueId, limit: 100 }),
    describe(data) {
      const target = data.children.find((child) => child.issue.id === entry.issueId);
      const eligible = data.children.filter((child) => child.issue.id !== entry.issueId && child.issue.state !== 'ABANDONED' && child.scope.status === 'INCLUDED');
      return cardShown({
        kind: 'SCOPE_DECISION',
        entryId: entry.id,
        issueVersion: (target?.issue.version ?? 0) + data.issue.version,
        riskHash: null,
        target: {},
        scope: {
          designId: data.design?.id ?? '',
          scopeHash: data.scopeHash,
          childScopeHash: target?.scopeHash ?? '',
          replacements: eligible.map((child) => `${child.issue.id}:${child.scopeHash}`)
        }
      });
    }
  });
  const [choice, setChoice] = useState<Choice | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [reopenParent, setReopenParent] = useState(false);
  const [done, setDone] = useState<{ recorded: string; next: string | null } | null>(null);
  const data = card.data;
  const target = data?.children.find((child) => child.issue.id === entry.issueId) ?? null;
  const previous = target?.scope.decision ?? null;
  const parentClosed = !!data && ['DONE', 'ABANDONED'].includes(data.issue.state);
  const replacements = data?.children.filter((child) => child.issue.id !== entry.issueId && child.issue.state !== 'ABANDONED' && child.scope.status === 'INCLUDED') ?? [];
  const own = new Set(target?.issue.criteria ?? []);
  const chosen = replacements.filter((child) => selected.includes(child.issue.id));
  const covered = [...own].every((criterion) => chosen.some((child) => child.issue.criteria.includes(criterion)));
  const approved = data?.design?.status === 'APPROVED';
  const available = {
    EXCLUDE: target?.issue.state === 'ABANDONED',
    REPLACE: target?.issue.state === 'ABANDONED' && replacements.some((child) => child.issue.criteria.some((criterion) => own.has(criterion))),
    RESTORE: !!previous && previous.action !== 'RESTORE'
  };
  const ready = !!choice && available[choice] && approved && (choice !== 'REPLACE' || (chosen.length > 0 && covered)) && (choice !== 'RESTORE' || !parentClosed || reopenParent);
  const locked = card.busy || !card.ready || !card.online || card.changed || gone;
  const label = choice === 'REPLACE' ? t('Confirm replacement') : choice === 'EXCLUDE' ? t('Confirm exclusion') : choice === 'RESTORE' ? t('Restore to the scope') : t('Choose one first');
  const submit = async () => {
    if (locked || !ready || !choice || !reason.trim()) return;
    const result = await card.decide('scope_decide', ({ data: current }) => {
      const child = current.children.find((value) => value.issue.id === entry.issueId)!;
      return {
        workspaceId: entry.workspaceId,
        issueId: entry.issueId,
        expectedVersion: child.issue.version,
        expectedParentVersion: current.issue.version,
        designId: current.design!.id,
        expectedDecisionId: child.issue.scopeDecisionId ?? null,
        scopeHash: current.scopeHash,
        childScopeHash: child.scopeHash,
        action: choice,
        replacements: choice === 'REPLACE'
          ? current.children.filter((value) => selected.includes(value.issue.id)).map((value) => ({ issueId: value.issue.id, expectedVersion: value.issue.version, scopeHash: value.scopeHash }))
          : [],
        reason: reason.trim(),
        reopenParent: choice === 'RESTORE' ? reopenParent : false,
        reopenChild: false
      };
    });
    if (!result) return;
    setDone({
      recorded: choice === 'RESTORE' ? t('You restored the task to the delivery scope.') : choice === 'EXCLUDE' ? t('You excluded the task from the delivery.') : t('You replaced the task with other tasks.'),
      next: await nextLine(entry.workspaceId, 'Waiting for {pm} to plan the tasks')
    });
  };
  useCtrlEnter(done || locked || !ready ? null : () => void submit());
  useReasonShortcut(null);
  const bar = done || gone ? (
    <Recorded recorded={done?.recorded ?? t('This was already handled.')} next={done?.next ?? null} onNext={onNext} hasNext={hasNext} />
  ) : (
    <Bar changed={card.changed} onSeeChanges={card.seeChanges} error={card.error}>
      {choice ? (
        <div className="reason-box">
          <label className="field">
            <span>{t('Reason')}</span>
            <textarea rows={3} maxLength={65536} value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          {choice === 'RESTORE' && parentClosed ? (
            <label className="check-row">
              <input type="checkbox" checked={reopenParent} onChange={(event) => setReopenParent(event.target.checked)} />
              <span>{t('Reopen the closed requirement; its acceptance will be invalidated.')}</span>
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="bar-row">
        <button type="button" className="primary" disabled={locked || !ready || !reason.trim()} onClick={() => void submit()}>{label}</button>
      </div>
    </Bar>
  );
  if (!data || !target) return <p role="status" className="muted card-loading">{card.loadFailed ? t('Nothing was recorded; your input is kept') : t('Loading…')}</p>;
  return (
    <CardFrame
      entry={entry}
      kindLabel={render(kindSentence('SCOPE_DECISION'))}
      title={entry.title}
      who={<WhoWhen entry={entry} />}
      audit={[...auditRows(entry), ['Design', data.design?.id], ['Design hash', data.design?.hash], ['Scope hash', data.scopeHash], ['Task scope hash', target.scopeHash], ['Previous decision', previous?.id]]}
      bar={bar}
    >
      <ChangeNotice seen={card.seen} lines={[t('The tasks or the design changed while you were reading.')]} />
      <Section title={t('What happened')}>
        {entry.abandonment ? (
          <p>{t('{name} abandoned this task on {date}.').replace('{name}', entry.abandonment.by.name).replace('{date}', dateText(entry.abandonment.at))}{' '}
            {entry.abandonment.granted ? t('It used a grant from you.') : null}</p>
        ) : <p>{t('The scope of this task needs your decision again.')}</p>}
        {entry.abandonment ? <p className="quote">{entry.abandonment.reason}</p> : null}
      </Section>
      <Section title={t('Criteria of this task')}>
        {target.issue.criteria.length ? <ul>{target.issue.criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul> : <p className="muted">{t('None declared')}</p>}
      </Section>
      <Section title={t('Your choice')}>
        {!approved ? <p className="error">{t('Approve the current parent design before confirming scope changes.')}</p> : null}
        <div className="choices" role="radiogroup" aria-label={t('Your choice')}>
          {(['EXCLUDE', 'REPLACE', 'RESTORE'] as const).filter((value) => value !== 'RESTORE' || available.RESTORE).map((value) => (
            <label key={value} className={`choice ${available[value] ? '' : 'disabled'}`}>
              <input type="radio" name="scope-choice" disabled={!available[value]} checked={choice === value} onChange={() => setChoice(value)} />
              <span>{t(value === 'EXCLUDE' ? 'Exclude it from the delivery' : value === 'REPLACE' ? 'Replace it with other tasks' : 'Restore it to the delivery scope')}</span>
            </label>
          ))}
        </div>
        {choice === 'REPLACE' ? (
          <fieldset className="replacements">
            <legend>{t('Tasks that take over')}</legend>
            {!replacements.length ? <p className="muted">{t('No other task in the delivery can take over.')}</p> : null}
            {replacements.map((child) => {
              const overlaps = child.issue.criteria.some((criterion) => own.has(criterion));
              return (
                <label key={child.issue.id} className={`check-row ${overlaps ? '' : 'disabled'}`}>
                  <input
                    type="checkbox"
                    disabled={!overlaps}
                    checked={selected.includes(child.issue.id)}
                    onChange={(event) => setSelected((ids) => (event.target.checked ? [...ids, child.issue.id] : ids.filter((id) => id !== child.issue.id)))}
                  />
                  <span>{child.issue.titleSuffix}<small>{child.issue.criteria.join(', ') || t('None declared')}</small></span>
                </label>
              );
            })}
            {chosen.length && !covered ? <p className="muted">{t('The chosen tasks do not cover every criterion yet.')}</p> : null}
          </fieldset>
        ) : null}
      </Section>
    </CardFrame>
  );
}
