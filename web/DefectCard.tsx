import { useState } from 'react';
import type { DefectSeverity } from '../src/defect-contracts';
import { command, loadIssue, stateLabel } from './api';
import type { DefectRecord, IssueData } from './api';
import {
  closedDefectPrimary, confirmInput, convertInput, defectConfirm, rejectInput, requirementDraft, SEVERITY_ORDER
} from './card-model';
import type { TriageBase } from './card-model';
import {
  Bar, CardFrame, ChangeNotice, Markdown, ReasonBox, Recorded, Section, WhoWhen, auditRows,
  useCard, useCtrlEnter, useEntriesNextLine, useReasonShortcut, useSentence, useSeverityText
} from './CardKit';
import type { CardProps } from './CardKit';
import { cardShown } from './decision-model';
import { useText } from './Preferences';
import { kindSentence } from './sentences';

interface DefectData { packet: IssueData; defect: DefectRecord }
type Mode = 'reject' | 'fix-now' | 'convert' | null;

export function DefectCard({ entry, gone, hasNext, onNext }: CardProps) {
  const t = useText();
  const render = useSentence();
  const severityText = useSeverityText();
  const entriesNextLine = useEntriesNextLine();
  const confirmable = entry.defect?.confirmable ?? false;
  const card = useCard<DefectData>({
    entryId: entry.id,
    async load() {
      const [packet, found] = await Promise.all([
        loadIssue(entry.workspaceId, entry.issueId),
        command<{ defect: DefectRecord }>('defect_get', { workspaceId: entry.workspaceId, defectId: entry.target.defectId })
      ]);
      return { packet, defect: found.defect };
    },
    describe({ packet, defect }) {
      const confirms = defectConfirm(confirmable, packet.issue.state) !== 'none';
      return cardShown({
        kind: 'DEFECT_TRIAGE',
        entryId: entry.id,
        issueVersion: packet.issue.version,
        riskHash: null,
        target: {},
        defect: { id: defect.id, version: defect.version, observation: confirms ? JSON.stringify(packet.defects?.observation ?? null) : null }
      });
    }
  });
  const [severity, setSeverity] = useState<DefectSeverity | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [done, setDone] = useState<{ recorded: string; next: string | null } | null>(null);
  const data = card.data;
  const defect = data?.defect ?? null;
  const packet = data?.packet ?? null;
  const chosen = severity ?? defect?.severity ?? 'MINOR';
  const confirmKind = packet ? defectConfirm(confirmable, packet.issue.state) : 'none';
  const draftLabels = {
    problem: t('Problem {key}: {summary}'),
    expected: t('Expected behavior'),
    steps: t('Steps')
  };
  const draft = defect ? requirementDraft(defect, draftLabels) : null;
  const locked = card.busy || !card.ready || !card.online || card.changed || gone;
  const base = (current: DefectData, version: number): TriageBase => ({
    workspaceId: entry.workspaceId,
    defectId: current.defect.id,
    expectedVersion: current.defect.version,
    expectedIssueVersion: version
  });
  const observation = (current: DefectData) => current.packet.defects!.observation;
  const finish = (recorded: string, next: string | null) => {
    setMode(null);
    setReason('');
    setDone({ recorded, next });
  };
  const triage = async (build: (current: DefectData, version: number) => object, recorded: string, next?: () => Promise<string | null>) => {
    if (locked) return;
    const result = await card.decide('defect_triage', ({ data: current, version }) => build(current, version));
    if (result) finish(recorded, next ? await next() : null);
  };
  const confirm = () => triage(
    (current, version) => confirmInput(base(current, version), chosen, observation(current)),
    t('You confirmed the problem.'),
    () => entriesNextLine(entry.workspaceId, entry.issueId, !packet?.issue.parentId)
  );
  const fixLater = () => triage(
    (current, version) => confirmInput(base(current, version), chosen, observation(current), { kind: 'DEFER' }),
    t('You confirmed the problem and will fix it later.')
  );
  const fixNow = () => reason.trim() && triage(
    (current, version) => confirmInput(base(current, version), chosen, observation(current), { kind: 'REOPEN', reason: reason.trim() }),
    t('You confirmed the problem and the task was reopened.')
  );
  const reject = () => reason.trim() && triage(
    (current, version) => rejectInput(base(current, version), reason.trim()),
    t('You ruled it out as not a problem.')
  );
  const convert = () => reason.trim() && (title ?? draft?.title ?? '').trim() && (description ?? draft?.description ?? '').trim() && triage(
    (current, version) => {
      const currentDraft = requirementDraft(current.defect, draftLabels);
      return convertInput(base(current, version), reason.trim(), (title ?? currentDraft.title).trim(), (description ?? currentDraft.description).trim());
    },
    t('You turned it into a new requirement.')
  );
  const modeAction = mode === 'reject' ? reject : mode === 'fix-now' ? fixNow : mode === 'convert' ? convert : null;
  useCtrlEnter(done || locked ? null : modeAction ? () => void modeAction() : confirmKind === 'acceptance' ? () => void confirm() : null);
  useReasonShortcut(done || locked ? null : () => setMode('reject'));
  const primaryClosed = closedDefectPrimary(chosen);
  const bar = done || gone ? (
    <Recorded recorded={done?.recorded ?? t('This was already handled.')} next={done?.next ?? null} onNext={onNext} hasNext={hasNext} />
  ) : (
    <Bar changed={card.changed} onSeeChanges={card.seeChanges} error={card.error}>
      {confirmKind === 'none' ? <p className="muted">{t('It can be confirmed once the task is delivered and waiting for your acceptance.')}</p> : null}
      {mode ? (
        <ReasonBox
          label={t(mode === 'convert' ? 'Why a new requirement?' : mode === 'fix-now' ? 'Why fix it now?' : 'Why is it not a problem?')}
          value={reason}
          onChange={setReason}
          submitLabel={t(mode === 'convert' ? 'Make it a requirement' : mode === 'fix-now' ? 'Confirm, fix now' : 'Not a problem')}
          disabled={locked || (mode === 'convert' && (!(title ?? draft?.title ?? '').trim() || !(description ?? draft?.description ?? '').trim()))}
          onSubmit={() => void modeAction?.()}
          onCancel={() => setMode(null)}
          extra={mode === 'convert' && draft ? (
            <>
              <label className="field"><span>{t('Title')}</span><input value={title ?? draft.title} maxLength={300} onChange={(event) => setTitle(event.target.value)} /></label>
              <label className="field"><span>{t('Description')}</span><textarea rows={4} value={description ?? draft.description} onChange={(event) => setDescription(event.target.value)} /></label>
            </>
          ) : null}
        />
      ) : (
        <div className="bar-row">
          <button type="button" disabled={locked} onClick={() => setMode('reject')}>{t('Not a problem')}</button>
          <button type="button" disabled={locked} onClick={() => setMode('convert')}>{t('Make it a requirement')}</button>
          {confirmKind === 'acceptance' ? <button type="button" className="primary" disabled={locked} onClick={() => void confirm()}>{t('Confirm')}</button> : null}
          {confirmKind === 'closed' ? (
            <>
              <button type="button" className={primaryClosed === 'fix-later' ? 'primary' : ''} disabled={locked} onClick={() => void fixLater()}>{t('Confirm, fix later')}</button>
              <button type="button" className={primaryClosed === 'fix-now' ? 'primary' : ''} disabled={locked} onClick={() => setMode('fix-now')}>{t('Confirm, fix now')}</button>
            </>
          ) : null}
        </div>
      )}
    </Bar>
  );
  if (!data || !defect || !packet) return <p role="status" className="muted card-loading">{card.loadFailed ? t('Nothing was recorded; your input is kept') : t('Loading…')}</p>;
  return (
    <CardFrame
      entry={entry}
      kindLabel={render(kindSentence('DEFECT_TRIAGE'))}
      title={entry.defect?.summary ?? defect.actual}
      who={<WhoWhen entry={entry} fallbackName={entry.defect?.reporterName} />}
      audit={[...auditRows(entry), ['Problem key', defect.key], ['Observed delivery', packet.defects?.observation.digest]]}
      bar={bar}
    >
      <ChangeNotice seen={card.seen} lines={[t('The report or the delivery changed while you were reading.')]} />
      <Section title={t('What was reported')}>
        <dl className="plain">
          <dt>{t('Actual behavior')}</dt><dd>{defect.actual}</dd>
          <dt>{t('Expected behavior')}</dt><dd>{defect.expected}</dd>
          <dt>{t('Reproduction steps')}</dt><dd>{defect.reproduce}</dd>
        </dl>
      </Section>
      <Section title={t('The task')}>
        <p>{entry.title} · {t(stateLabel(packet.issue))}</p>
      </Section>
      {confirmKind !== 'none' ? (
        <Section title={t('Severity')}>
          <label className="field">
            <span>{t('How serious is it?')}</span>
            <select value={chosen} onChange={(event) => setSeverity(event.target.value as DefectSeverity)}>
              {SEVERITY_ORDER.map((level) => <option key={level} value={level}>{severityText(level)}</option>)}
            </select>
          </label>
        </Section>
      ) : null}
    </CardFrame>
  );
}

export function QuestionCard({ entry, gone, hasNext, onNext }: CardProps) {
  const t = useText();
  const render = useSentence();
  const card = useCard<IssueData>({
    entryId: entry.id,
    load: () => loadIssue(entry.workspaceId, entry.issueId),
    describe(packet) {
      return cardShown({
        kind: 'AGENT_QUESTION',
        entryId: entry.id,
        issueVersion: packet.issue.version,
        riskHash: null,
        target: { messageId: entry.target.messageId ?? null }
      });
    }
  });
  const [reply, setReply] = useState('');
  const [done, setDone] = useState<{ recorded: string; next: string | null } | null>(null);
  const locked = card.busy || !card.ready || !card.online || card.changed || gone;
  const send = async () => {
    if (locked || !reply.trim() || !entry.question) return;
    const result = await card.decide('message_send', () => ({
      workspaceId: entry.workspaceId,
      issueId: entry.issueId,
      recipient: { kind: 'actor', actorId: entry.question!.senderId },
      kind: 'REPLY',
      replyTo: entry.target.messageId,
      body: reply
    }));
    if (!result) return;
    setReply('');
    setDone({ recorded: t('Your reply was sent.'), next: null });
  };
  useCtrlEnter(done || locked || !reply.trim() ? null : () => void send());
  useReasonShortcut(null);
  const bar = done || gone ? (
    <Recorded recorded={done?.recorded ?? t('This was already handled.')} next={null} onNext={onNext} hasNext={hasNext} />
  ) : (
    <Bar changed={card.changed} onSeeChanges={card.seeChanges} error={card.error}>
      <label className="field">
        <span>{t('Your reply')}</span>
        <textarea rows={3} maxLength={16000} value={reply} onChange={(event) => setReply(event.target.value)} />
      </label>
      <div className="bar-row">
        <button type="button" className="primary" disabled={locked || !reply.trim()} onClick={() => void send()}>{t('Reply')}</button>
      </div>
    </Bar>
  );
  const packet = card.data;
  if (!packet) return <p role="status" className="muted card-loading">{card.loadFailed ? t('Nothing was recorded; your input is kept') : t('Loading…')}</p>;
  const requirement = packet.parent?.description ?? packet.issue.description;
  return (
    <CardFrame
      entry={entry}
      kindLabel={render(kindSentence('AGENT_QUESTION'))}
      title={entry.question ? entry.question.body.split(/\r?\n/).find((line) => line.trim())?.slice(0, 160) ?? entry.title : entry.title}
      who={<WhoWhen entry={entry} fallbackName={entry.question?.senderName} />}
      audit={auditRows(entry)}
      bar={bar}
    >
      <ChangeNotice seen={card.seen} lines={[t('The question changed while you were reading.')]} />
      {entry.question ? <Section title={t('The question')}><Markdown source={entry.question.body} /></Section> : null}
      {requirement ? <Section title={t('The requirement')}><Markdown source={requirement} /></Section> : null}
    </CardFrame>
  );
}
