import { useDateText } from './Preferences';
import { useText } from './Preferences';
import { useEffect, useRef, useState } from 'react';
import { command, errorText, formKey, harnessName, mutation, stateLabel } from './api';
import type { IssueData, WorkspaceData } from './api';
import { AsyncForm, Empty, Icon, JsonView, Status } from './components';
import type { IssueDialog } from './IssueForms';

export function IssuePanel({
  packet,
  workspace,
  online,
  onDialog,
  onRefresh,
  onBack
}: {
  packet: IssueData;
  workspace: WorkspaceData;
  online: boolean;
  onDialog(dialog: Omit<IssueDialog, 'id'>): void;
  onRefresh(): void;
  onBack(): void;
}) {
  const dateText = useDateText();
  const t = useText();
  const [tab, setTab] = useState(packet.design?.status === 'IN_REVIEW' ? 'Design' : 'Overview');
  const [revision, setRevision] = useState('');
  const [evidence, setEvidence] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(packet.history);
  const [nextAfter, setNextAfter] = useState(packet.nextAfter);
  const lastSequence = useRef(0);
  const [loading, setLoading] = useState(false);
  const issue = packet.issue;
  const root = packet.parent ?? issue;
  const design = packet.designHistory.find((d) => d.id === revision) ?? packet.design;
  const historical = !!design && design.id !== packet.design?.id;
  const actorName = (id?: string | null) =>
    workspace.actors.find((actor) => actor.id === id)?.name ?? (id ? id.slice(0, 8) : t('Unassigned'));
  const dialog = (kind: IssueDialog['kind'], extra: Partial<IssueDialog> = {}) =>
    onDialog({ kind, packet, ...extra });
  const call = (operation: string, input: object, label: string, primary = false) => (
    <AsyncForm
      className="inline-form"
      onDone={onRefresh}
      onSave={(data) =>
        mutation(operation, {
          workspaceId: issue.workspaceId,
          issueId: issue.id,
          expectedVersion: issue.version,
          ...input,
          ...formKey(data)
        })
      }
    >
      <button type="submit" className={primary ? 'primary' : ''} disabled={!online}>
        {t(label)}
      </button>
    </AsyncForm>
  );
  const rootCall = (operation: string, label: string) =>
    call(operation, { issueId: root.id, expectedVersion: root.version }, label);
  useEffect(() => {
    setHistory((previous) => {
      const combined = [
        ...new Map([...previous, ...packet.history].map((item) => [item.sequence, item])).values()
      ].sort((a, b) => a.sequence - b.sequence);
      lastSequence.current = combined.at(-1)?.sequence ?? 0;
      return combined;
    });
    if (packet.nextAfter !== null)
      setNextAfter((previous) => Math.max(previous ?? 0, packet.nextAfter!, lastSequence.current));
  }, [packet.history, packet.nextAfter]);
  async function loadHistory() {
    if (nextAfter === null) return;
    setLoading(true);
    setError('');
    try {
      const next = await command<IssueData>('ui_issue', {
        workspaceId: issue.workspaceId,
        issueId: issue.id,
        after: nextAfter
      });
      setHistory((previous) =>
        [...new Map([...previous, ...next.history].map((item) => [item.sequence, item])).values()].sort(
          (a, b) => a.sequence - b.sequence
        )
      );
      setNextAfter(next.nextAfter);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLoading(false);
    }
  }
  async function openEvidence(kind: string, id: string) {
    setError('');
    try {
      setEvidence(
        kind === 'check'
          ? (
              await command<{ check: unknown }>('qa_check_get', {
                workspaceId: issue.workspaceId,
                checkId: id
              })
            ).check
          : (
              await command<{ evidence: unknown }>('evidence_get', {
                workspaceId: issue.workspaceId,
                issueId: issue.id,
                kind,
                evidenceId: id
              })
            ).evidence
      );
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  const terminal = ['DONE', 'ABANDONED'].includes(issue.state);
  const canAssign =
    issue.state === 'NOT_STARTED' ||
    issue.state.endsWith('REJECTED') ||
    (!issue.parentId &&
      issue.state === 'IN_PROGRESS' &&
      !issue.candidate &&
      !issue.lease &&
      !!packet.planning?.ready &&
      packet.planning.children.inScope > 0 &&
      packet.planning.children.done === packet.planning.children.inScope);
  return (
    <aside className="inspector" aria-label={t('Issue details')}>
      <button className="mobile-back text-button" onClick={onBack}>
        <Icon name="back" />
        {t('Back to workspace')}
      </button>
      <header className="issue-heading">
        <div className="issue-kicker">
          <span>{issue.key}</span>
          <Status
            value={stateLabel(issue, workspace.designs) === 'Design review' ? 'IN_REVIEW' : issue.state}
            label={stateLabel(issue, workspace.designs)}
          />
        </div>
        <h2>{issue.title}</h2>
        <nav className="tabs" aria-label={t('Issue sections')}>
          {['Overview', 'Design', 'Evidence', 'Activity'].map((name) => (
            <button
              key={name}
              aria-current={tab === name ? 'page' : undefined}
              onClick={() => {
                setTab(name);
                setEvidence(null);
              }}
            >
              {t(name)}
            </button>
          ))}
        </nav>
      </header>
      <div className="inspector-body">
        {error ? (
          <p className="error" role="alert">
            {t(error)}
          </p>
        ) : null}
        {tab === 'Overview' ? (
          <>
            <h3>{t('Requirement description')}</h3>
            <div className="prose">{issue.description || t('No description yet.')}</div>
            <h3>{t('Acceptance criteria')}</h3>
            {issue.criteria.length ? (
              <ul>
                {issue.criteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('No criteria mapped yet.')}</p>
            )}
            <dl className="metadata">
              <dt>{t('Lifecycle')}</dt>
              <dd>{issue.state}</dd>
              <dt>{t('Worker')}</dt>
              <dd>{actorName(issue.assignee)}</dd>
              <dt>{t('Harness')}</dt>
              <dd>{harnessName(issue.harness)}</dd>
              <dt>{t('QA reviewer')}</dt>
              <dd>{actorName(issue.qaAssignee)}</dd>
              <dt>{t('QA harness')}</dt>
              <dd>{harnessName(issue.qaHarness)}</dd>
              <dt>{t('Planned start')}</dt>
              <dd>{issue.plannedStart ?? t('Unscheduled')}</dd>
              <dt>{t('Due date')}</dt>
              <dd>{issue.dueDate ?? t('Unscheduled')}</dd>
              <dt>{t('Iteration ID')}</dt>
              <dd className="mono">{issue.iterationId ?? t('Not set')}</dd>
              {issue.legacyIterationLabel ?? issue.iteration ? <>
                <dt>{t('Legacy iteration label')}</dt>
                <dd>{issue.legacyIterationLabel ?? issue.iteration}</dd>
              </> : null}
              <dt>{t('Estimate')}</dt>
              <dd>
                {issue.estimate
                  ? `${issue.estimate.value} ${t(issue.estimate.unit)} · ${t(issue.estimate.confidence)} ${t('confidence')}`
                  : t('Not estimated')}
              </dd>
              <dt>{t('Delivery mode')}</dt>
              <dd>{issue.artifactMode ?? t('Not declared')}</dd>
              <dt>{t('Issue version')}</dt>
              <dd>{issue.version}</dd>
              <dt>{t('Scope revision')}</dt>
              <dd>{issue.scopeRevision}</dd>
              {issue.scope ? (
                <>
                  <dt>{t('Delivery scope')}</dt>
                  <dd>
                    <Status value={issue.scope.status} />
                    {issue.scope.decisionId ? <span>{t(' · Human decision recorded')}</span> : null}
                  </dd>
                </>
              ) : null}
            </dl>
            <section className="gap-panel" aria-label={t('Issue gaps')}>
              {packet.planning ? (
                <>
                  <h3>{t('Requirement plan')}</h3>
                  <p>
                    <Status value={packet.planning.status} /> · {packet.planning.children.done}/
                    {packet.planning.children.inScope}
                    {t(' in-scope tasks implemented · ')}
                    {packet.planning.children.excluded}
                    {t(' excluded · ')}
                    {packet.planning.children.abandoned}
                    {t(' unresolved abandoned · ')}
                    {packet.planning.children.staleExclusions}
                    {t(' stale exclusions')}
                  </p>
                  <p className="muted">
                    {t(
                      'Task counts describe delivery status. Parent integration and user acceptance remain separate gates.'
                    )}
                  </p>
                  <button disabled={!online} onClick={() => dialog('decomposition')}>
                    {t('Review decomposition')}
                  </button>
                </>
              ) : null}
              <h3>{t('Gaps to resolve')}</h3>
              {packet.readiness.blocking.length ? (
                <ul>
                  {packet.readiness.blocking.map((code) => (
                    <li key={code}>
                      <code>{code}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{t('No implementation-readiness blockers.')}</p>
              )}
              {!issue.plannedStart ? <p className="muted">{t('SCHEDULE_UNSET · optional')}</p> : null}
              {packet.closureBlocked.length ? (
                <>
                  <h4>{t('Closure blockers')}</h4>
                  <ul>
                    {packet.closureBlocked.map((code) => (
                      <li key={code}>
                        <code>{code}</code>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
            {packet.parent ? (
              <p className="muted">
                {t('Parent: ')}
                {packet.parent.key} · {packet.parent.title}
              </p>
            ) : null}
          </>
        ) : null}
        {tab === 'Design' ? (
          <>
            {packet.designHistory.length > 1 ? (
              <label className="field">
                <span>{t('Design revision')}</span>
                <select
                  value={revision || packet.design?.id}
                  onChange={(event) => setRevision(event.target.value)}
                >
                  {packet.designHistory.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id === packet.design?.id ? t('Current') : t('Historical')} ·{' '}
                      {item.hash.slice(0, 10)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {design ? (
              <>
                <h3>{historical ? t('Historical design') : t('Proposed design')}</h3>
                <div className="prose">{design.content}</div>
                <details className="scope-details">
                  <summary>{t('Captured requirement scope')}</summary>
                  <div className="prose">
                    {design.requirementDescription ?? t('Not captured by this older revision.')}
                  </div>
                </details>
                <h3>{t('Acceptance criteria')}</h3>
                <ul>
                  {design.criteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <dl className="metadata">
                  <dt>{t('Revision')}</dt>
                  <dd>{historical ? t('Historical') : `r${packet.revision}`}</dd>
                  <dt>{t('Design state')}</dt>
                  <dd>
                    <Status value={design.status} />
                  </dd>
                  <dt>SHA-256</dt>
                  <dd className="mono">{design.hash}</dd>
                  <dt>{t('Revision ID')}</dt>
                  <dd className="mono">{design.id}</dd>
                </dl>
                {historical ? (
                  <p className="notice">
                    {t(
                      'Historical evidence is retained. Decisions below apply to the current revision only.'
                    )}
                  </p>
                ) : null}
              </>
            ) : (
              <Empty title={t('Design not written')}>
                <p>{t('Create a design before asking for human approval.')}</p>
              </Empty>
            )}
          </>
        ) : null}
        {tab === 'Evidence' ? (
          <>
            {packet.snapshot ? (
              <dl className="metadata">
                <dt>{t('Sealed files')}</dt>
                <dd>{packet.snapshot.files.length}</dd>
                <dt>{t('Snapshot hash')}</dt>
                <dd className="mono">{packet.snapshot.hash}</dd>
              </dl>
            ) : (
              <p className="muted">{t('No sealed delivery snapshot.')}</p>
            )}
            {packet.git ? (
              (() => {
                const git = packet.git;
                return (
                  <section className="evidence-block">
                    <h3>{t('Final commits')}</h3>
                    {git.entries.map((entry, index) => (
                      <div className="evidence-row" key={`${entry.repository}-${entry.sha}`}>
                        <span>
                          <a className="mono" href={entry.url} target="_blank" rel="noreferrer">
                            {entry.repository} @ {entry.sha}
                          </a>
                          {index > 0 || entry.attempt?.evidenceRole === 'reference' ? (
                            <p className="muted">{t('Reference-only evidence; not snapshot closure proof.')}</p>
                          ) : null}
                          {entry.attempt?.errorCode ? <p className="error">{entry.attempt.errorCode}</p> : null}
                        </span>
                        <Status value={entry.attempt?.state ?? git.state} />
                      </div>
                    ))}
                    <p>
                      <Status value={git.state} />
                    </p>
                    {git.errorCode ? <p className="error">{git.errorCode}</p> : null}
                    <p className="muted">
                      {t('Verified: ')}
                      {dateText(git.verifiedAt)}
                    </p>
                  </section>
                );
              })()
            ) : null}
            <h3>{t('Captured checks')}</h3>
            {packet.checks.length ? (
              packet.checks.map((check) => (
                <button
                  className="evidence-row"
                  key={check.id}
                  onClick={() => void openEvidence('check', check.id)}
                >
                  <span>
                    {t('Check · ')}
                    {check.criteria.join(', ')}
                    <small>
                      {t('Exit ')}
                      {check.exitCode ?? t('not recorded')} · {check.id.slice(0, 8)}
                    </small>
                  </span>
                  <Status value={check.state} />
                </button>
              ))
            ) : (
              <p className="muted">{t('No captured checks yet.')}</p>
            )}
            <h3>{t('Evidence records')}</h3>
            {packet.evidence.map((item) => (
              <button
                className="evidence-row"
                key={item.id}
                onClick={() => void openEvidence(item.kind, item.id)}
              >
                <span>
                  {item.kind.replaceAll('_', ' ')}
                  <small>
                    {item.id.slice(0, 8)} · {dateText(item.createdAt)}
                  </small>
                </span>
                {item.state || item.verdict ? (
                  <Status value={item.state ?? item.verdict!} />
                ) : (
                  <Icon name="chevron" />
                )}
              </button>
            ))}
            {evidence ? (
              <>
                <h3>{t('Recorded evidence')}</h3>
                <JsonView value={evidence} />
              </>
            ) : null}
          </>
        ) : null}
        {tab === 'Activity' ? (
          <>
            <h3>{t('Audit history')}</h3>
            <ol className="activity">
              {history.map((item) => (
                <li key={item.sequence}>
                  <strong>{item.operation.replaceAll('_', ' ')}</strong>
                  <p>{item.actorName}</p>
                  <small>
                    {dateText(item.at)}
                    {t(' · event ')}
                    {item.sequence}
                  </small>
                  <details>
                    <summary>{t('Recorded changes')}</summary>
                    <JsonView value={item.data} />
                  </details>
                </li>
              ))}
            </ol>
            {nextAfter !== null ? (
              <button disabled={loading} onClick={() => void loadHistory()}>
                {loading ? t('Loading…') : t('Load more activity')}
              </button>
            ) : (
              <p className="muted">{t('All available activity loaded.')}</p>
            )}
          </>
        ) : null}
      </div>
      <footer className="inspector-actions">
        <div className="action-group">
          {!historical &&
          packet.design?.status === 'IN_REVIEW' &&
          !['DONE', 'ABANDONED'].includes(root.state) ? (
            <button className="primary" disabled={!online} onClick={() => dialog('design-review')}>
              {t('Review design')}
            </button>
          ) : null}
          {!historical && !['DONE', 'ABANDONED'].includes(root.state) ? (
            <button disabled={!online} onClick={() => dialog('design')}>
              {packet.design ? t('Edit design') : t('Write design')}
            </button>
          ) : null}
          {!historical && packet.design?.status === 'DRAFT'
            ? rootCall('design_submit', 'Request design review')
            : null}
          {issue.state === 'USER_ACCEPTANCE' && packet.deliveryDigest ? (
            <button className="primary" disabled={!online} onClick={() => dialog('delivery')}>
              {t('Review delivery')}
            </button>
          ) : null}
          {issue.state === 'USER_ACCEPTANCE' && issue.acceptedDigest
            ? call('delivery_complete', {}, 'Recheck closure')
            : null}
        </div>
        {issue.state === 'LEAD_REVIEW' ? (
          <p className="muted">
            {t("Waiting for the product lead's ")}
            {issue.stage === 'FINAL' ? t('final') : t('initial')}
            {t(' review through its scoped agent connection.')}
          </p>
        ) : null}
        <details className="more-actions">
          <summary>{t('Plan and lifecycle actions')}</summary>
          <div className="action-group">
            <button disabled={!online} onClick={() => dialog('grants')}>
              {t('Manage authorization')}
            </button>
            {packet.executionRecovery.required && issue.state !== 'DONE' ? (
              <button disabled={!online} onClick={() => dialog('execution-recovery')}>
                {t('Reconcile unbound execution')}
              </button>
            ) : null}
            {issue.parentId &&
            (issue.state === 'ABANDONED' || (issue.scopeDecisionId && issue.scope?.action !== 'RESTORE')) ? (
              <button disabled={!online} onClick={() => dialog('scope-decision')}>
                {t('Review delivery scope')}
              </button>
            ) : null}
            {packet.planning && tab !== 'Overview' ? (
              <button disabled={!online} onClick={() => dialog('decomposition')}>
                {t('Review decomposition')}
              </button>
            ) : null}
            {!issue.parentId && !terminal ? (
              <button disabled={!online} onClick={() => dialog('create', { parent: issue })}>
                {t('New task')}
              </button>
            ) : null}
            {!terminal ? (
              <button disabled={!online} onClick={() => dialog('plan')}>
                {t('Edit plan')}
              </button>
            ) : null}
            {!terminal ? (
              <button disabled={!online} onClick={() => dialog('scope')}>
                {t('Edit scope')}
              </button>
            ) : null}
            {canAssign ? (
              <button disabled={!online} onClick={() => dialog('assignment')}>
                {t('Assign worker')}
              </button>
            ) : null}
            {canAssign && packet.readiness.ready ? (
              <button disabled={!online} onClick={() => dialog('dispatch')}>
                {t('Dispatch worker')}
              </button>
            ) : null}
            {!['DONE', 'ABANDONED', 'USER_ACCEPTANCE'].includes(issue.state) &&
            !(issue.state === 'LEAD_REVIEW' && issue.stage === 'FINAL') ? (
              <button disabled={!online} onClick={() => dialog('qa')}>
                {t('Configure QA')}
              </button>
            ) : null}
            {issue.candidate?.snapshotId &&
            issue.artifactMode === 'git' &&
            ['LEAD_REVIEW', 'QA_TEST', 'USER_ACCEPTANCE'].includes(issue.state) ? (
              <button disabled={!online} onClick={() => dialog('git')}>
                {t('Attach final commit')}
              </button>
            ) : null}
            {packet.git &&
            ['UNAVAILABLE', 'FAILED'].includes(packet.git.state) &&
            issue.state === 'USER_ACCEPTANCE'
              ? call('git_retry', { submissionId: packet.git.id }, 'Retry verification')
              : null}
            {(terminal
              ? (['reopen'] as const)
              : issue.state === 'ON_HOLD'
                ? (['resume', 'abandon'] as const)
                : (['hold', 'abandon'] as const)
            )
              .filter(
                (action) => action !== 'reopen' || !issue.scopeDecisionId || issue.scope?.action === 'RESTORE'
              )
              .map((action) => (
                <button disabled={!online} key={action} onClick={() => dialog('transition', { action })}>
                  {t(action[0].toUpperCase() + action.slice(1))}
                </button>
              ))}
          </div>
        </details>
      </footer>
    </aside>
  );
}
