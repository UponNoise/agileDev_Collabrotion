import { useMemo, useRef, useState } from 'react';
import { command, loadIssue } from './api';
import type { IssueData } from './api';
import { diffBlocks, onlyChanges } from './changes';
import { blocks as parseBlocks } from './markdown';
import { lastDecidedRevision } from './card-model';
import {
  Bar, CardFrame, ChangeNotice, Document, Markdown, ProblemList, ReasonBox, Recorded, Section, WhoWhen,
  auditRows, plainRows, useCard, useCtrlEnter, useNextLine, useReasonShortcut, useSentence, viewRows
} from './CardKit';
import type { CardProps } from './CardKit';
import { problemsOf } from './card-model';
import { cardShown } from './decision-model';
import { useText } from './Preferences';
import { blockerSentence, kindSentence } from './sentences';

interface Approval { id: string; designId: string; decision: 'APPROVED' | 'CHANGES_REQUESTED'; reason?: string | null }
interface DesignData { packet: IssueData; decisions: Approval[] }

export function DesignCard({ entry, gone, hasNext, onNext }: CardProps) {
  const t = useText();
  const render = useSentence();
  const nextLine = useNextLine();
  const cached = useRef<{ id: string; decisions: Approval[] } | null>(null);
  const card = useCard<DesignData>({
    entryId: entry.id,
    async load() {
      const packet = await loadIssue(entry.workspaceId, entry.issueId);
      const designId = packet.design?.id ?? null;
      if (designId && cached.current?.id !== designId) {
        const result = await command<{ decisions: Approval[] }>('design_get', { workspaceId: entry.workspaceId, issueId: entry.issueId, designId, limit: 20 });
        cached.current = { id: designId, decisions: result.decisions };
      }
      return { packet, decisions: designId ? (cached.current?.decisions ?? []) : [] };
    },
    describe({ packet }) {
      return cardShown({
        kind: 'DESIGN_REVIEW',
        entryId: entry.id,
        issueVersion: packet.issue.version,
        riskHash: packet.designRisks?.hash ?? null,
        target: { designId: packet.design?.id ?? null, designHash: packet.design?.hash ?? null }
      });
    }
  });
  const [mode, setMode] = useState<'full' | 'changes'>('full');
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<{ recorded: string; next: string | null } | null>(null);
  const packet = card.data?.packet ?? null;
  const design = packet?.design ?? null;
  const base = card.previous?.packet.design ?? lastDecidedRevision(packet?.designHistory ?? [], design?.id ?? '');
  const rows = useMemo(() => {
    if (!design) return [];
    const full = base ? diffBlocks(parseBlocks(base.content), parseBlocks(design.content)) : null;
    if (!full) return plainRows(design.content);
    return mode === 'changes' ? viewRows(onlyChanges(full)) : full.map((row) => ({ state: row.state, block: row.block }));
  }, [design, base, mode]);
  const request = card.data?.decisions[0]?.decision === 'CHANGES_REQUESTED' ? card.data.decisions[0] : null;
  const scopeStale = packet?.readiness.blocking.includes('DESIGN_SCOPE_STALE') ?? false;
  const blocked = !design || !packet?.designRisks || scopeStale || !design.requirementDescription;
  const locked = card.busy || !card.ready || !card.online || card.changed || gone;
  const submit = async (decision: 'APPROVED' | 'CHANGES_REQUESTED') => {
    if (locked || (decision === 'CHANGES_REQUESTED' && !reason.trim()) || !packet || !design) return;
    const result = await card.decide('design_decide', ({ data, version }) => ({
      workspaceId: entry.workspaceId,
      issueId: entry.issueId,
      expectedVersion: version,
      designId: data.packet.design!.id,
      designHash: data.packet.design!.hash,
      riskHash: data.packet.designRisks!.hash,
      decision,
      ...(decision === 'CHANGES_REQUESTED' ? { reason: reason.trim() } : {})
    }));
    if (!result) return;
    setReasonOpen(false);
    setReason('');
    setDone(decision === 'APPROVED'
      ? { recorded: t('You approved the design.'), next: await nextLine(entry.workspaceId, 'Design approved; {pm} plans the tasks next') }
      : { recorded: t('You asked for changes to the design.'), next: await nextLine(entry.workspaceId, 'Waiting for {lead} to revise the design') });
  };
  const main = done || locked || blocked ? null : reasonOpen ? () => void submit('CHANGES_REQUESTED') : () => void submit('APPROVED');
  useCtrlEnter(main);
  useReasonShortcut(done || locked ? null : () => setReasonOpen(true));
  const changeLines = card.seen ? [t('The design changed while you were reading it. Changed blocks are marked below.')] : [];
  const bar = done || gone ? (
    <Recorded recorded={done?.recorded ?? t('This was already handled.')} next={done?.next ?? null} onNext={onNext} hasNext={hasNext} />
  ) : (
    <Bar changed={card.changed} onSeeChanges={() => { card.seeChanges(); setMode('changes'); }} error={card.error}>
      {blocked && packet ? <p className="muted">{render(blockerSentence(scopeStale ? 'DESIGN_SCOPE_STALE' : 'DESIGN_APPROVAL_REQUIRED', {}))}</p> : null}
      {reasonOpen ? (
        <ReasonBox
          label={t('What should change?')}
          value={reason}
          onChange={setReason}
          submitLabel={t('Send request')}
          disabled={locked}
          onSubmit={() => void submit('CHANGES_REQUESTED')}
          onCancel={() => setReasonOpen(false)}
        />
      ) : (
        <div className="bar-row">
          <button type="button" disabled={locked} onClick={() => setReasonOpen(true)}>{t('Request changes')}</button>
          <button type="button" className="primary" disabled={locked || blocked} onClick={() => void submit('APPROVED')}>{t('Approve')}</button>
        </div>
      )}
    </Bar>
  );
  if (!packet || !design) return <p role="status" className="muted card-loading">{card.loadFailed ? t('Nothing was recorded; your input is kept') : t('Loading…')}</p>;
  return (
    <CardFrame
      entry={entry}
      kindLabel={render(kindSentence('DESIGN_REVIEW'))}
      title={entry.title}
      who={<WhoWhen entry={entry} />}
      audit={[...auditRows(entry), ['Issue version', packet.issue.version], ['Design', design.id], ['Design hash', design.hash], ['Risk hash', packet.designRisks?.hash]]}
      bar={bar}
    >
      <ChangeNotice seen={card.seen} lines={changeLines} />
      {request?.reason ? (
        <Section title={t('Your last request')}>
          <p className="quote">{request.reason}</p>
        </Section>
      ) : null}
      <Section title={t('Requirement')}>
        {design.requirementDescription
          ? <Markdown source={design.requirementDescription} />
          : <p className="muted">{t('This older revision has no captured requirement scope. Create a new revision before approval.')}</p>}
      </Section>
      <Section title={t('Design')}>
        {base ? (
          <div className="segmented" role="group" aria-label={t('Design view')}>
            <button type="button" aria-pressed={mode === 'full'} onClick={() => setMode('full')}>{t('Full text')}</button>
            <button type="button" aria-pressed={mode === 'changes'} onClick={() => setMode('changes')}>{t('Changes only')}</button>
          </div>
        ) : null}
        <Document rows={rows} />
      </Section>
      <Section title={t('Acceptance criteria')}>
        <ul>{design.criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
      </Section>
      <Section title={t('Known problems')}>
        <ProblemList problems={problemsOf(packet.designRisks)} />
      </Section>
    </CardFrame>
  );
}
