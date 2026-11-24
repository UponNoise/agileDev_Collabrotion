import { useEffect, useRef, useState } from 'react';
import type { IntegrationManifest, QaReport } from '../src/contracts';
import { command, loadIssue, stateLabel } from './api';
import type { IssueData, ScopeData } from './api';
import {
  PREVIEW_FIRST_BYTES, PREVIEW_MAX_BYTES, base64Bytes, countProblems, decodeWindow, deliveryChanges, deliveryChoice, previewWindow, problemsOf
} from './card-model';
import type { DeliveryChangeItem, DeliverySnapshot, Preview } from './card-model';
import {
  Bar, CardFrame, ChangeNotice, Markdown, ProblemList, ReasonBox, Recorded, Section, WhoWhen,
  auditRows, useCard, useCtrlEnter, useNextLine, useReasonShortcut, useSentence, useSeverityText
} from './CardKit';
import type { CardProps } from './CardKit';
import { cardShown } from './decision-model';
import { useText } from './Preferences';
import { blockerSentence, kindSentence, rejectionSentence } from './sentences';

interface Review { id: string; verdict: 'PASS' | 'FAIL'; reason?: string }
interface Task { key: string; title: string; state: string }
interface DeliveryData {
  packet: IssueData;
  qa: QaReport | null;
  initial: Review | null;
  final: Review | null;
  tasks: Task[] | null;
}

type Rejection = 'DEFECT' | 'SCOPE_CHANGE' | 'CLARIFICATION';
const rejections: readonly Rejection[] = ['DEFECT', 'SCOPE_CHANGE', 'CLARIFICATION'];

const rejectionNext: Record<Rejection, string> = {
  DEFECT: 'You returned it (needs fixes); rework next',
  CLARIFICATION: 'You returned it (needs clarification); rework next',
  SCOPE_CHANGE: 'You changed the requirement; {lead} revises the design'
};

function FilePreview({ workspaceId, issueId, snapshotId, path, size }: {
  workspaceId: string; issueId: string; snapshotId: string; path: string; size: number | null;
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
        workspaceId, issueId, snapshotId, path, encoding: 'base64', offset: next?.offset ?? 0, limit: next?.limit ?? PREVIEW_FIRST_BYTES
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
  const preview: Preview | null = state ? decodeWindow(state.bytes, state.bytes.length >= Math.min(state.total, 65536)) : null;
  const more = state ? previewWindow(state.bytes.length, state.total) : null;
  return (
    <li className="file-row">
      <button
        type="button"
        className="text-button file-name"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && !state) void load();
        }}
      >
        <span className="mono">{path}</span>
      </button>
      {open ? (
        <div className="file-preview">
          {failed ? <p className="muted">{t('This file could not be read.')}</p> : null}
          {preview?.kind === 'binary' ? <p className="muted">{t('This file cannot be previewed as text.')}</p> : null}
          {preview?.kind === 'text' ? <pre className="code">{preview.text}</pre> : null}
          {state && more ? <button type="button" disabled={busy} onClick={() => void load()}>{t('Show more')}</button> : null}
          {state && !more && state.total > 65536 ? <p className="muted">{t('Only the first 64 KiB are shown.')}</p> : null}
          {!state && busy ? <p className="muted">{t('Loading…')}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

function deliverySnapshot(data: DeliveryData): DeliverySnapshot {
  return {
    candidateId: data.packet.issue.candidate?.id ?? null,
    snapshotId: data.packet.issue.candidate?.snapshotId ?? null,
    criteria: data.packet.issue.criteria,
    decisionRisks: data.packet.decisionRisks,
    qa: data.qa,
    initial: data.initial,
    final: data.final,
    git: data.packet.git
  };
}

function formatDeliveryChange(
  item: DeliveryChangeItem,
  t: (text: string) => string,
  severity: (level: string) => string,
  resultText: Record<string, string>
): string {
  switch (item.kind) {
    case 'candidate':
      return t('A new delivery was submitted.');
    case 'problem-added':
      return t(item.unconfirmed ? 'New unconfirmed report ({severity}): {summary}' : 'New problem ({severity}): {summary}')
        .replace('{severity}', () => severity(item.severity))
        .replace('{summary}', () => item.summary);
    case 'problem-removed':
      return t('Problem removed ({severity}): {summary}')
        .replace('{severity}', () => severity(item.severity))
        .replace('{summary}', () => item.summary);
    case 'problem-confirmed':
      return t('Report confirmed ({severity}): {summary}')
        .replace('{severity}', () => severity(item.severity))
        .replace('{summary}', () => item.summary);
    case 'problem-severity':
      return t('Problem severity changed from {before} to {after}: {summary}')
        .replace('{before}', () => severity(item.before))
        .replace('{after}', () => severity(item.after))
        .replace('{summary}', () => item.summary);
    case 'problem-updated':
      return t('Problem updated ({severity}): {summary}')
        .replace('{severity}', () => severity(item.severity))
        .replace('{summary}', () => item.summary);
    case 'commit-attached':
      return t('A new commit was attached.');
    case 'commit-removed':
      return t('The attached commit was removed.');
    case 'commit-verified':
      return t('The commit was verified.');
    case 'commit-state':
      return t('Commit verification changed.');
    case 'qa-criterion':
      return t('QA result for {criterion} changed from {before} to {after}.')
        .replace('{criterion}', () => item.criterion)
        .replace('{before}', () => t(item.before ? resultText[item.before] ?? 'No result' : 'No result'))
        .replace('{after}', () => t(item.after ? resultText[item.after] ?? 'No result' : 'No result'));
    case 'qa-changed':
      return t('The independent QA result changed.');
    case 'initial-review':
      return t('The initial review changed.');
    case 'final-review':
      return t('The final review changed.');
  }
}

export function DeliveryCard({ entry, gone, hasNext, onNext }: CardProps) {
  const t = useText();
  const render = useSentence();
  const severity = useSeverityText();
  const nextLine = useNextLine();
  const records = useRef(new Map<string, unknown>());
  const card = useCard<DeliveryData>({
    entryId: entry.id,
    async load() {
      const packet = await loadIssue(entry.workspaceId, entry.issueId);
      const issue = packet.issue;
      const fetchOnce = async <T,>(kind: string, id: string | null | undefined): Promise<T | null> => {
        if (!id) return null;
        const key = `${kind}:${id}`;
        if (!records.current.has(key)) {
          try {
            records.current.set(key, (await command<{ evidence: T }>('evidence_get', { workspaceId: entry.workspaceId, issueId: entry.issueId, kind, evidenceId: id })).evidence);
          } catch {
            return null;
          }
        }
        return records.current.get(key) as T;
      };
      const [qa, initial, final] = await Promise.all([
        fetchOnce<QaReport>('qa_report', packet.decisionRisks?.qaReport?.id),
        fetchOnce<Review>('review', issue.initialReview),
        fetchOnce<Review>('review', issue.finalReview)
      ]);
      let tasks: Task[] | null = null;
      if (!issue.parentId && issue.candidate?.integration) {
        const cacheKey = `tasks:${issue.candidate.id}`;
        if (!records.current.has(cacheKey)) {
          try {
            const manifest = await command<{ manifest: IntegrationManifest }>('integration_get', { workspaceId: entry.workspaceId, issueId: entry.issueId, limit: 100 });
            const scope = await command<ScopeData>('scope_get', { workspaceId: entry.workspaceId, issueId: entry.issueId, limit: 100 });
            const accepted = new Set(manifest.manifest.children.map((child) => child.issueId));
            records.current.set(cacheKey, scope.children.filter((child) => accepted.has(child.issue.id)).map((child) => ({ key: child.issue.key, title: child.issue.titleSuffix, state: stateLabel(child.issue) })));
          } catch {
            records.current.set(cacheKey, []);
          }
        }
        tasks = records.current.get(cacheKey) as Task[];
      }
      return { packet, qa, initial, final, tasks };
    },
    describe({ packet }) {
      return cardShown({
        kind: 'DELIVERY_ACCEPTANCE',
        entryId: entry.id,
        issueVersion: packet.issue.version,
        riskHash: packet.decisionRisks?.hash ?? null,
        target: { candidateId: packet.issue.candidate?.id ?? null, digest: packet.deliveryDigest }
      });
    }
  });
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<{ recorded: string; next: string | null } | null>(null);
  const packet = card.data?.packet ?? null;
  const issue = packet?.issue ?? null;
  const problems = problemsOf(packet?.decisionRisks);
  const counts = countProblems(problems);
  const choice = deliveryChoice(problems);
  const blocked = !packet?.deliveryDigest || !packet.decisionRisks || !issue?.candidate;
  const locked = card.busy || !card.ready || !card.online || card.changed || gone || blocked;
  const send = async (decision: 'ACCEPT' | Rejection) => {
    if (locked || !packet) return;
    if (decision !== 'ACCEPT' && !reason.trim()) return;
    const result = await card.decide('delivery_decide', ({ data, version }) => ({
      workspaceId: entry.workspaceId,
      issueId: entry.issueId,
      expectedVersion: version,
      candidateId: data.packet.issue.candidate!.id,
      digest: data.packet.deliveryDigest!,
      riskHash: data.packet.decisionRisks!.hash,
      ...(decision === 'ACCEPT' ? { decision: 'ACCEPT' } : { decision: 'REJECT', classification: decision, reason: reason.trim() })
    }));
    if (!result) return;
    setRejection(null);
    setReason('');
    if (decision !== 'ACCEPT') {
      setDone({ recorded: t('You sent the delivery back.'), next: await nextLine(entry.workspaceId, rejectionNext[decision]) });
      return;
    }
    const after = await loadIssue(entry.workspaceId, entry.issueId).catch(() => null);
    const first = after?.closureBlocked[0];
    setDone({
      recorded: t('You accepted the delivery.'),
      next: first
        ? await nextLine(entry.workspaceId, 'Accepted; {blocker}', (names) => ({ blocker: blockerSentence(first, { ...names }) }))
        : await nextLine(entry.workspaceId, 'Accepted and ready to complete')
    });
  };
  const primaryRun = rejection ? () => void send(rejection) : choice.primary === 'accept' ? () => void send('ACCEPT') : null;
  useCtrlEnter(done || locked ? null : primaryRun);
  useReasonShortcut(done || locked ? null : () => setRejection(rejection ?? 'DEFECT'));
  const [shownFiles, setShownFiles] = useState(false);
  useEffect(() => { setShownFiles(false); }, [entry.id]);
  const acceptLabel = choice.minorCount > 0
    ? t('Accept with {count} known minor problems').replace('{count}', String(choice.minorCount))
    : t('Accept');
  const bar = done || gone ? (
    <Recorded recorded={done?.recorded ?? t('This was already handled.')} next={done?.next ?? null} onNext={onNext} hasNext={hasNext} />
  ) : (
    <Bar changed={card.changed} onSeeChanges={card.seeChanges} error={card.error}>
      {blocked && packet ? <p className="muted">{render(blockerSentence('EVIDENCE_DIGEST_UNAVAILABLE', { lead: t('lead') }))}</p> : null}
      {choice.primary === 'needs-fixes' && !rejection ? <p className="muted">{t('Serious problems are open, so completion will wait.')}</p> : null}
      {rejection ? (
        <ReasonBox
          label={t('What needs to happen?')}
          value={reason}
          onChange={setReason}
          submitLabel={t('Send back')}
          disabled={locked}
          onSubmit={() => void send(rejection)}
          onCancel={() => setRejection(null)}
          extra={
            <div className="segmented" role="group" aria-label={t('Why is it sent back?')}>
              {rejections.map((kind) => (
                <button key={kind} type="button" aria-pressed={rejection === kind} onClick={() => setRejection(kind)}>
                  {render(rejectionSentence(kind))}
                </button>
              ))}
            </div>
          }
        />
      ) : (
        <div className="bar-row">
          {rejections.map((kind) => (
            <button key={kind} type="button" className={choice.primary === 'needs-fixes' && kind === 'DEFECT' ? 'primary' : ''} disabled={locked} onClick={() => setRejection(kind)}>
              {render(rejectionSentence(kind))}
            </button>
          ))}
          <button type="button" className={choice.primary === 'accept' ? 'primary' : ''} disabled={locked} onClick={() => void send('ACCEPT')}>{acceptLabel}</button>
        </div>
      )}
    </Bar>
  );
  if (!packet || !issue) return <p role="status" className="muted card-loading">{card.loadFailed ? t('Nothing was recorded; your input is kept') : t('Loading…')}</p>;
  const candidate = issue.candidate;
  const qa = card.data!.qa;
  const passed = qa ? new Set(qa.results.filter((result) => result.result === 'PASS').map((result) => result.criterionId)).size : 0;
  const reviewsPassed = card.data!.initial?.verdict === 'PASS' && card.data!.final?.verdict === 'PASS';
  const commit = issue.artifactMode === 'artifact' ? 'artifact' : packet.git?.state === 'VERIFIED' ? 'verified' : 'unverified';
  const severities = (['BLOCKER', 'MAJOR', 'MINOR', 'INFO'] as const).filter((level) => counts.open[level] > 0);
  const resultText: Record<string, string> = { PASS: 'Passed', FAIL: 'Failed', BLOCKED: 'Blocked', NOT_RUN: 'Not run' };
  const changeLines = card.seen && card.previous && card.data
    ? deliveryChanges(deliverySnapshot(card.previous), deliverySnapshot(card.data)).map((item) => formatDeliveryChange(item, t, severity, resultText))
    : [];
  return (
    <CardFrame
      entry={entry}
      kindLabel={render(kindSentence('DELIVERY_ACCEPTANCE'))}
      title={entry.title}
      who={<WhoWhen entry={entry} />}
      audit={[...auditRows(entry), ['Issue version', issue.version], ['Candidate', candidate?.id], ['Digest', packet.deliveryDigest], ['Risk hash', packet.decisionRisks?.hash], ['Snapshot', candidate?.snapshotId], ['Snapshot hash', packet.snapshot?.hash], ['Initial review', issue.initialReview], ['QA review', issue.qaReview], ['Final review', issue.finalReview]]}
      bar={bar}
    >
      <ChangeNotice seen={card.seen} lines={changeLines.length ? changeLines : [t('The delivery changed while you were reading it.')]} />
      <ul className="facts" aria-label={t('Facts')}>
        <li>{t('{passed} of {total} criteria passed').replace('{passed}', String(passed)).replace('{total}', String(issue.criteria.length))}</li>
        <li>{t(reviewsPassed ? 'Both lead reviews passed' : 'Lead reviews are not both passed')}</li>
        <li>{t(commit === 'verified' ? 'Commit verified' : commit === 'artifact' ? 'Delivered as files' : 'Commit not verified')}</li>
        <li>{severities.length ? severities.map((level) => `${counts.open[level]} ${severity(level)}`).join(' · ') : t('No open problems')}</li>
        {counts.unconfirmed ? <li>{t('{count} unconfirmed reports').replace('{count}', String(counts.unconfirmed))}</li> : null}
      </ul>
      {candidate?.summary ? <Section title={t('What the developer says')}><Markdown source={candidate.summary} /></Section> : null}
      <Section title={t('Criteria')}>
        <ul className="criteria">
          {issue.criteria.map((criterion) => {
            const result = qa?.results.find((value) => value.criterionId === criterion);
            return (
              <li key={criterion}>
                <p><span className={`status ${result?.result === 'PASS' ? 'good' : result ? 'bad' : 'neutral'}`}>{t(result ? resultText[result.result]! : 'No result')}</span> {criterion}</p>
                {result?.reason ? <p className="muted">{result.reason}</p> : null}
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title={t('Problems')}>
        <ProblemList problems={problems} />
      </Section>
      {card.data!.tasks ? (
        <Section title={t('Tasks in this delivery')}>
          <ul>{card.data!.tasks.map((task) => <li key={task.key}>{task.title} · {t(task.state)}</li>)}</ul>
        </Section>
      ) : null}
      <Section title={t('Lead reviews')}>
        <ul>
          <li><strong>{t('Initial review')}</strong> {card.data!.initial?.reason ?? t('Not recorded')}</li>
          <li><strong>{t('Final review')}</strong> {card.data!.final?.reason ?? t('Not recorded')}</li>
        </ul>
      </Section>
      {candidate ? (
        <Section title={t('Files')}>
          {candidate.files.length ? (
            <ul className="files">
              {(shownFiles ? candidate.files : candidate.files.slice(0, 30)).map((file) => (
                <FilePreview
                  key={file.path}
                  workspaceId={entry.workspaceId}
                  issueId={entry.issueId}
                  snapshotId={candidate.snapshotId!}
                  path={file.path}
                  size={packet.snapshot?.files.find((value) => value.path === file.path)?.bytes ?? null}
                />
              ))}
            </ul>
          ) : <p className="muted">{t('No files were delivered.')}</p>}
          {candidate.files.length > 30 && !shownFiles ? <button type="button" onClick={() => setShownFiles(true)}>{t('Show more')}</button> : null}
        </Section>
      ) : null}
      {packet.git?.entries.length ? (
        <Section title={t('Commit')}>
          <ul>
            {packet.git.entries.filter((value) => /^https:\/\//.test(value.url)).map((value) => (
              <li key={`${value.repository}-${value.sha}`}><a href={value.url} target="_blank" rel="noopener noreferrer">{value.repository} · {value.sha.slice(0, 8)}</a></li>
            ))}
          </ul>
        </Section>
      ) : null}
    </CardFrame>
  );
}
