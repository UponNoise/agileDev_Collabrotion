import { useEffect, useRef, useState } from 'react';
import { command, dateText, errorText, formKey, harnessName, mutation, stateLabel } from './api';
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
    workspace.actors.find((actor) => actor.id === id)?.name ?? (id ? id.slice(0, 8) : 'Unassigned');
  const dialog = (kind: IssueDialog['kind'], extra: Partial<IssueDialog> = {}) => onDialog({ kind, packet, ...extra });
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
        {label}
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
          ? (await command<{ check: unknown }>('qa_check_get', { workspaceId: issue.workspaceId, checkId: id })).check
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
      packet.planning.children.total > 0 &&
      packet.planning.children.done === packet.planning.children.total);
  return (
    <aside className="inspector" aria-label="Issue details">
      <button className="mobile-back text-button" onClick={onBack}>
        <Icon name="back" />
        Back to workspace
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
        <nav className="tabs" aria-label="Issue sections">
          {['Overview', 'Design', 'Evidence', 'Activity'].map((name) => (
            <button
              key={name}
              aria-current={tab === name ? 'page' : undefined}
              onClick={() => {
                setTab(name);
                setEvidence(null);
              }}
            >
              {name}
            </button>
          ))}
        </nav>
      </header>
      <div className="inspector-body">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {tab === 'Overview' ? (
          <>
            <h3>Requirement description</h3>
            <div className="prose">{issue.description || 'No description yet.'}</div>
            <h3>Acceptance criteria</h3>
            {issue.criteria.length ? (
              <ul>
                {issue.criteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">No criteria mapped yet.</p>
            )}
            <dl className="metadata">
              <dt>Lifecycle</dt>
              <dd>{issue.state}</dd>
              <dt>Worker</dt>
              <dd>{actorName(issue.assignee)}</dd>
              <dt>Harness</dt>
              <dd>{harnessName(issue.harness)}</dd>
              <dt>QA reviewer</dt>
              <dd>{actorName(issue.qaAssignee)}</dd>
              <dt>QA harness</dt>
              <dd>{harnessName(issue.qaHarness)}</dd>
              <dt>Planned start</dt>
              <dd>{issue.plannedStart ?? 'Unscheduled'}</dd>
              <dt>Due date</dt>
              <dd>{issue.dueDate ?? 'Unscheduled'}</dd>
              <dt>Iteration</dt>
              <dd>{issue.iteration ?? 'Not set'}</dd>
              <dt>Estimate</dt>
              <dd>
                {issue.estimate
                  ? `${issue.estimate.value} ${issue.estimate.unit} · ${issue.estimate.confidence} confidence`
                  : 'Not estimated'}
              </dd>
              <dt>Delivery mode</dt>
              <dd>{issue.artifactMode ?? 'Not declared'}</dd>
              <dt>Issue version</dt>
              <dd>{issue.version}</dd>
              <dt>Scope revision</dt>
              <dd>{issue.scopeRevision}</dd>
            </dl>
            <section className="gap-panel" aria-label="Issue gaps">
              {packet.planning ? (
                <>
                  <h3>Requirement plan</h3>
                  <p>
                    <Status value={packet.planning.status} /> · {packet.planning.children.done}/
                    {packet.planning.children.total} tasks implemented
                  </p>
                  <p className="muted">
                    Task counts describe delivery status. Parent integration and user acceptance remain separate gates.
                  </p>
                  <button disabled={!online} onClick={() => dialog('decomposition')}>
                    Review decomposition
                  </button>
                </>
              ) : null}
              <h3>Gaps to resolve</h3>
              {packet.readiness.blocking.length ? (
                <ul>
                  {packet.readiness.blocking.map((code) => (
                    <li key={code}>
                      <code>{code}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No implementation-readiness blockers.</p>
              )}
              {!issue.plannedStart ? <p className="muted">SCHEDULE_UNSET · optional</p> : null}
              {packet.closureBlocked.length ? (
                <>
                  <h4>Closure blockers</h4>
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
                Parent: {packet.parent.key} · {packet.parent.title}
              </p>
            ) : null}
          </>
        ) : null}
        {tab === 'Design' ? (
          <>
            {packet.designHistory.length > 1 ? (
              <label className="field">
                <span>Design revision</span>
                <select value={revision || packet.design?.id} onChange={(event) => setRevision(event.target.value)}>
                  {packet.designHistory.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id === packet.design?.id ? 'Current' : 'Historical'} · {item.hash.slice(0, 10)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {design ? (
              <>
                <h3>{historical ? 'Historical design' : 'Proposed design'}</h3>
                <div className="prose">{design.content}</div>
                <details className="scope-details">
                  <summary>Captured requirement scope</summary>
                  <div className="prose">{design.requirementDescription ?? 'Not captured by this older revision.'}</div>
                </details>
                <h3>Acceptance criteria</h3>
                <ul>
                  {design.criteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <dl className="metadata">
                  <dt>Revision</dt>
                  <dd>{historical ? 'Historical' : `r${packet.revision}`}</dd>
                  <dt>Design state</dt>
                  <dd>
                    <Status value={design.status} />
                  </dd>
                  <dt>SHA-256</dt>
                  <dd className="mono">{design.hash}</dd>
                  <dt>Revision ID</dt>
                  <dd className="mono">{design.id}</dd>
                </dl>
                {historical ? (
                  <p className="notice">
                    Historical evidence is retained. Decisions below apply to the current revision only.
                  </p>
                ) : null}
              </>
            ) : (
              <Empty title="Design not written">
                <p>Create a design before asking for human approval.</p>
              </Empty>
            )}
          </>
        ) : null}
        {tab === 'Evidence' ? (
          <>
            {packet.snapshot ? (
              <dl className="metadata">
                <dt>Sealed files</dt>
                <dd>{packet.snapshot.files.length}</dd>
                <dt>Snapshot hash</dt>
                <dd className="mono">{packet.snapshot.hash}</dd>
              </dl>
            ) : (
              <p className="muted">No sealed delivery snapshot.</p>
            )}
            {packet.git ? (
              <section className="evidence-block">
                <h3>Final commit</h3>
                <a className="mono" href={packet.git.url} target="_blank" rel="noreferrer">
                  {packet.git.sha}
                </a>
                <p>
                  <Status value={packet.git.state} />
                </p>
                {packet.git.errorCode ? <p className="error">{packet.git.errorCode}</p> : null}
                <p className="muted">Verified: {dateText(packet.git.verifiedAt)}</p>
              </section>
            ) : null}
            <h3>Captured checks</h3>
            {packet.checks.length ? (
              packet.checks.map((check) => (
                <button className="evidence-row" key={check.id} onClick={() => void openEvidence('check', check.id)}>
                  <span>
                    Check · {check.criteria.join(', ')}
                    <small>
                      Exit {check.exitCode ?? 'not recorded'} · {check.id.slice(0, 8)}
                    </small>
                  </span>
                  <Status value={check.state} />
                </button>
              ))
            ) : (
              <p className="muted">No captured checks yet.</p>
            )}
            <h3>Evidence records</h3>
            {packet.evidence.map((item) => (
              <button className="evidence-row" key={item.id} onClick={() => void openEvidence(item.kind, item.id)}>
                <span>
                  {item.kind.replaceAll('_', ' ')}
                  <small>
                    {item.id.slice(0, 8)} · {dateText(item.createdAt)}
                  </small>
                </span>
                {item.state || item.verdict ? <Status value={item.state ?? item.verdict!} /> : <Icon name="chevron" />}
              </button>
            ))}
            {evidence ? (
              <>
                <h3>Recorded evidence</h3>
                <JsonView value={evidence} />
              </>
            ) : null}
          </>
        ) : null}
        {tab === 'Activity' ? (
          <>
            <h3>Audit history</h3>
            <ol className="activity">
              {history.map((item) => (
                <li key={item.sequence}>
                  <strong>{item.operation.replaceAll('_', ' ')}</strong>
                  <p>{item.actorName}</p>
                  <small>
                    {dateText(item.at)} · event {item.sequence}
                  </small>
                  <details>
                    <summary>Recorded changes</summary>
                    <JsonView value={item.data} />
                  </details>
                </li>
              ))}
            </ol>
            {nextAfter !== null ? (
              <button disabled={loading} onClick={() => void loadHistory()}>
                {loading ? 'Loading…' : 'Load more activity'}
              </button>
            ) : (
              <p className="muted">All available activity loaded.</p>
            )}
          </>
        ) : null}
      </div>
      <footer className="inspector-actions">
        <div className="action-group">
          {!historical && packet.design?.status === 'IN_REVIEW' && !['DONE', 'ABANDONED'].includes(root.state) ? (
            <button className="primary" disabled={!online} onClick={() => dialog('design-review')}>
              Review design
            </button>
          ) : null}
          {!historical && !['DONE', 'ABANDONED'].includes(root.state) ? (
            <button disabled={!online} onClick={() => dialog('design')}>
              {packet.design ? 'Edit design' : 'Write design'}
            </button>
          ) : null}
          {!historical && packet.design?.status === 'DRAFT' ? rootCall('design_submit', 'Request design review') : null}
          {issue.state === 'USER_ACCEPTANCE' && packet.deliveryDigest ? (
            <button className="primary" disabled={!online} onClick={() => dialog('delivery')}>
              Review delivery
            </button>
          ) : null}
          {issue.state === 'USER_ACCEPTANCE' && issue.acceptedDigest
            ? call('delivery_complete', {}, 'Recheck closure')
            : null}
        </div>
        {issue.state === 'LEAD_REVIEW' ? (
          <p className="muted">
            Waiting for the product lead's {issue.stage === 'FINAL' ? 'final' : 'initial'} review through its scoped
            agent connection.
          </p>
        ) : null}
        <details className="more-actions">
          <summary>Plan and lifecycle actions</summary>
          <div className="action-group">
            <button disabled={!online} onClick={() => dialog('grants')}>
              Manage authorization
            </button>
            {packet.planning && tab !== 'Overview' ? (
              <button disabled={!online} onClick={() => dialog('decomposition')}>
                Review decomposition
              </button>
            ) : null}
            {!issue.parentId && !terminal ? (
              <button disabled={!online} onClick={() => dialog('create', { parent: issue })}>
                New task
              </button>
            ) : null}
            {!terminal ? (
              <button disabled={!online} onClick={() => dialog('plan')}>
                Edit plan
              </button>
            ) : null}
            {!terminal ? (
              <button disabled={!online} onClick={() => dialog('scope')}>
                Edit scope
              </button>
            ) : null}
            {canAssign ? (
              <button disabled={!online} onClick={() => dialog('assignment')}>
                Assign worker
              </button>
            ) : null}
            {canAssign && packet.readiness.ready ? (
              <button disabled={!online} onClick={() => dialog('dispatch')}>
                Dispatch worker
              </button>
            ) : null}
            {!['DONE', 'ABANDONED', 'USER_ACCEPTANCE'].includes(issue.state) &&
            !(issue.state === 'LEAD_REVIEW' && issue.stage === 'FINAL') ? (
              <button disabled={!online} onClick={() => dialog('qa')}>
                Configure QA
              </button>
            ) : null}
            {issue.candidate?.snapshotId &&
            issue.artifactMode === 'git' &&
            ['LEAD_REVIEW', 'QA_TEST', 'USER_ACCEPTANCE'].includes(issue.state) ? (
              <button disabled={!online} onClick={() => dialog('git')}>
                Attach final commit
              </button>
            ) : null}
            {packet.git && ['UNAVAILABLE', 'FAILED'].includes(packet.git.state) && issue.state === 'USER_ACCEPTANCE'
              ? call('git_retry', { submissionId: packet.git.id }, 'Retry verification')
              : null}
            {(terminal
              ? (['reopen'] as const)
              : issue.state === 'ON_HOLD'
                ? (['resume', 'abandon'] as const)
                : (['hold', 'abandon'] as const)
            ).map((action) => (
              <button disabled={!online} key={action} onClick={() => dialog('transition', { action })}>
                {action[0].toUpperCase() + action.slice(1)}
              </button>
            ))}
          </div>
        </details>
      </footer>
    </aside>
  );
}
