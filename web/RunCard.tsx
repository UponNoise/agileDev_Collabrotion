import { useRef, useState } from 'react';
import type { Actor, Run } from '../src/contracts';
import { command, harnessName, loadIssue } from './api';
import type { IssueData, WorkspaceData } from './api';
import { Bar, CardFrame, ChangeNotice, ReasonBox, Recorded, Section, WhoWhen, auditRows, useCard, useCtrlEnter, useNextLine, useReasonShortcut, useSentence } from './CardKit';
import type { CardProps } from './CardKit';
import { cardShown } from './decision-model';
import { useDateText, useText } from './Preferences';
import { blockerSentence, kindSentence } from './sentences';

interface RunData { packet: IssueData; run: Run | null; actors: Actor[] }

export function RunCard({ entry, gone, hasNext, onNext }: CardProps) {
  const t = useText();
  const render = useSentence();
  const dateText = useDateText();
  const nextLine = useNextLine();
  const actors = useRef<Actor[] | null>(null);
  const card = useCard<RunData>({
    entryId: entry.id,
    async load() {
      const packet = await loadIssue(entry.workspaceId, entry.issueId);
      const run = entry.target.runId
        ? (await command<{ run: Run }>('run_get', { workspaceId: entry.workspaceId, runId: entry.target.runId })).run
        : null;
      if (!actors.current) actors.current = (await command<WorkspaceData>('ui_workspace', { workspaceId: entry.workspaceId, limit: 1 })).actors;
      return { packet, run, actors: actors.current };
    },
    describe({ packet, run }) {
      return cardShown({
        kind: 'RUN_RECONCILE',
        entryId: entry.id,
        issueVersion: packet.issue.version,
        riskHash: null,
        target: run
          ? { runId: run.id, runVersion: run.version }
          : { fence: packet.executionRecovery.fence, candidateId: packet.executionRecovery.candidateId }
      });
    }
  });
  const [stopped, setStopped] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<{ recorded: string; next: string | null } | null>(null);
  const data = card.data;
  const run = data?.run ?? null;
  const locked = card.busy || !card.ready || !card.online || card.changed || gone;
  const submit = async () => {
    if (locked || !stopped || !reason.trim()) return;
    const result = await card.decide(run ? 'run_reconcile' : 'work_reconcile', ({ data: current, version }) =>
      current.run
        ? { workspaceId: entry.workspaceId, runId: current.run.id, expectedVersion: current.run.version, reason: reason.trim(), confirmStopped: true }
        : {
            workspaceId: entry.workspaceId,
            issueId: entry.issueId,
            expectedVersion: version,
            fence: current.packet.executionRecovery.fence,
            candidateId: current.packet.executionRecovery.candidateId,
            confirmStopped: true,
            reason: reason.trim()
          });
    if (!result) return;
    setDone({ recorded: t('You confirmed that it has stopped.'), next: await nextLine(entry.workspaceId, 'Development stopped; {pm} decides next') });
  };
  useCtrlEnter(done || locked || !stopped ? null : () => void submit());
  useReasonShortcut(null);
  const bar = done || gone ? (
    <Recorded recorded={done?.recorded ?? t('This was already handled.')} next={done?.next ?? null} onNext={onNext} hasNext={hasNext} />
  ) : (
    <Bar changed={card.changed} onSeeChanges={card.seeChanges} error={card.error}>
      <label className="check-row">
        <input type="checkbox" checked={stopped} disabled={locked} onChange={(event) => setStopped(event.target.checked)} />
        <span>{t('I confirm that it has stopped')}</span>
      </label>
      {stopped ? (
        <ReasonBox
          label={t('How did you check?')}
          value={reason}
          onChange={setReason}
          submitLabel={t('Confirm stopped')}
          disabled={locked}
          onSubmit={() => void submit()}
          onCancel={() => setStopped(false)}
        />
      ) : null}
    </Bar>
  );
  if (!data) return <p role="status" className="muted card-loading">{card.loadFailed ? t('Nothing was recorded; your input is kept') : t('Loading…')}</p>;
  const agent = data.actors.find((actor) => actor.id === run?.actorId)?.name ?? t('worker');
  const issue = data.packet.issue;
  return (
    <CardFrame
      entry={entry}
      kindLabel={render(kindSentence('RUN_RECONCILE'))}
      title={entry.title}
      who={<WhoWhen entry={entry} />}
      audit={[...auditRows(entry), ['Provider session', run?.providerSessionId], ['Lease owner', issue.lease?.actorId], ['Candidate', data.packet.executionRecovery.candidateId]]}
      bar={bar}
    >
      <ChangeNotice seen={card.seen} lines={[t('The run changed while you were reading.')]} />
      <Section title={t('What lost contact')}>
        {run ? (
          <dl className="plain">
            <dt>{t('Agent')}</dt><dd>{agent} · {harnessName(run.harness)}</dd>
            <dt>{t('Started')}</dt><dd>{dateText(run.startedAt ?? run.createdAt)}</dd>
            <dt>{t('Last contact')}</dt><dd>{dateText(run.lastHeartbeatAt ?? run.startedAt ?? run.createdAt)}</dd>
            {run.pid ? <><dt>{t('Process ID')}</dt><dd className="mono">{run.pid}</dd></> : null}
          </dl>
        ) : (
          <>
            <p>{render(blockerSentence('UNMANAGED_EXECUTION'))}</p>
            <dl className="plain">
              <dt>{t('Last handoff')}</dt><dd>{issue.candidate?.summary ?? t('None recorded')}</dd>
            </dl>
          </>
        )}
      </Section>
      <Section title={t('How to check')}>
        <p>{t(run ? 'Make sure the process is no longer running on this computer and nothing is still working in its isolated directory.' : 'Make sure the old external worker is no longer running. The service has no process record for this work, so this records your confirmation.')}</p>
      </Section>
    </CardFrame>
  );
}

export function ClosureCard({ entry, gone, hasNext, onNext }: CardProps) {
  const t = useText();
  const render = useSentence();
  const nextLine = useNextLine();
  const card = useCard<IssueData>({
    entryId: entry.id,
    load: () => loadIssue(entry.workspaceId, entry.issueId),
    describe(packet) {
      return cardShown({
        kind: 'CLOSURE_BLOCKED',
        entryId: entry.id,
        issueVersion: packet.issue.version,
        riskHash: null,
        target: { digest: packet.deliveryDigest },
        blockers: packet.closureBlocked
      });
    }
  });
  const [done, setDone] = useState<{ recorded: string; next: string | null } | null>(null);
  const packet = card.data;
  const retry = packet?.nextActions.find((action) => action.operation === 'git_retry') ?? null;
  const complete = !!packet && !packet.closureBlocked.length && packet.nextActions.some((action) => action.operation === 'delivery_complete');
  const locked = card.busy || !card.ready || !card.online || card.changed || gone;
  const finish = async () => {
    if (locked || !complete) return;
    const result = await card.decide('delivery_complete', ({ version }) => ({ workspaceId: entry.workspaceId, issueId: entry.issueId, expectedVersion: version }));
    if (!result) return;
    setDone({ recorded: t('You completed the task.'), next: await nextLine(entry.workspaceId, 'Done') });
  };
  const check = async () => {
    if (locked || !retry) return;
    const submissionId = retry.args.submissionId;
    const result = await card.decide('git_retry', ({ version }) => ({ workspaceId: entry.workspaceId, issueId: entry.issueId, expectedVersion: version, submissionId }));
    if (result) card.setError(null);
  };
  useCtrlEnter(done || locked || !complete ? null : () => void finish());
  useReasonShortcut(null);
  const bar = done || gone ? (
    <Recorded recorded={done?.recorded ?? t('This was already handled.')} next={done?.next ?? null} onNext={onNext} hasNext={hasNext} />
  ) : (
    <Bar changed={card.changed} onSeeChanges={card.seeChanges} error={card.error}>
      <div className="bar-row">
        {retry ? <button type="button" disabled={locked} onClick={() => void check()}>{t('Check again')}</button> : null}
        {complete ? <button type="button" className="primary" disabled={locked} onClick={() => void finish()}>{t('Complete')}</button> : null}
      </div>
    </Bar>
  );
  if (!packet) return <p role="status" className="muted card-loading">{card.loadFailed ? t('Nothing was recorded; your input is kept') : t('Loading…')}</p>;
  const names = { lead: t('lead'), pm: t('pm'), dev: t('worker'), qa: t('qa') };
  return (
    <CardFrame
      entry={entry}
      kindLabel={render(kindSentence('CLOSURE_BLOCKED'))}
      title={entry.title}
      who={<WhoWhen entry={entry} />}
      audit={[...auditRows(entry), ['Blockers', packet.closureBlocked.join(', ')]]}
      bar={bar}
    >
      <ChangeNotice seen={card.seen} lines={[t('The closing checks changed while you were reading.')]} />
      <Section title={t('Where it stands')}>
        {packet.closureBlocked.length ? (
          <ul>{packet.closureBlocked.map((code) => <li key={code}>{render(blockerSentence(code, names))}</li>)}</ul>
        ) : <p>{t('Every check passes')}</p>}
      </Section>
    </CardFrame>
  );
}
