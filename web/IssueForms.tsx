import { useEffect, useState } from 'react';
import type { Grant, Issue } from '../src/contracts';
import { ApiError, command, dateText, errorText, formKey, harnessName, lines, mutation } from './api';
import type { IssueData, WorkspaceData } from './api';
import { AsyncForm, Field, Modal, Status } from './components';
import { PlanningForm } from './Planning';
import { ScopeReview } from './ScopeReview';

export type IssueDialog = {
  id: string;
  kind:
    | 'create'
    | 'design'
    | 'design-review'
    | 'delivery'
    | 'assignment'
    | 'qa'
    | 'transition'
    | 'dispatch'
    | 'git'
    | 'grants'
    | 'decomposition'
    | 'scope'
    | 'scope-decision'
    | 'plan';
  packet?: IssueData;
  parent?: Issue;
  action?: 'hold' | 'resume' | 'abandon' | 'reopen';
};
export function IssueForm({
  dialog,
  workspace,
  onClose,
  onSaved
}: {
  dialog: IssueDialog;
  workspace: WorkspaceData;
  onClose(): void;
  onSaved(): void;
}) {
  const packet = dialog.packet;
  const issue = packet?.issue;
  const root = packet?.parent ?? issue;
  const base = issue
    ? { workspaceId: issue.workspaceId, issueId: issue.id, expectedVersion: issue.version }
    : { workspaceId: workspace.workspace.id };
  const done = () => {
    onSaved();
    onClose();
  };
  const footer = (label: string) => (
    <footer className="form-footer">
      <button type="button" onClick={onClose}>
        Cancel
      </button>
      <button className="primary" type="submit">
        {label}
      </button>
    </footer>
  );
  if (dialog.kind === 'create')
    return (
      <Modal title={dialog.parent ? 'New task' : 'New issue'} subtitle={dialog.parent?.title} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('issue_create', {
              workspaceId: workspace.workspace.id,
              ...formKey(data),
              ...(dialog.parent ? { parentId: dialog.parent.id, expectedParentVersion: dialog.parent.version } : {}),
              title: String(data.get('title')),
              description: String(data.get('description')),
              criteria: lines(data.get('criteria')),
              ...(!dialog.parent && data.get('mode') === 'artifact'
                ? { artifactMode: 'artifact', artifactReason: String(data.get('reason')) }
                : {})
            })
          }
        >
          <div className="form-body">
            <p className="notice">New issues start as Not started. Assignment and dates are optional.</p>
            <Field
              label="Title"
              hint={
                dialog.parent
                  ? 'Use [Type] Area: action -> outcome. The parent prefix is added automatically.'
                  : undefined
              }
            >
              <input
                name="title"
                maxLength={300}
                required
                placeholder={
                  dialog.parent ? '[Feature] Area: action -> outcome' : 'What should this requirement achieve?'
                }
              />
            </Field>
            <Field label="Requirement description">
              <textarea name="description" rows={5} />
            </Field>
            <Field
              label="Acceptance criteria"
              hint="One criterion ID per line. Tasks reference the parent design criteria."
            >
              <textarea name="criteria" rows={3} />
            </Field>
            {!dialog.parent ? (
              <>
                <Field label="Delivery mode">
                  <select name="mode" defaultValue={workspace.workspace.commonDir ? 'git' : 'artifact'}>
                    <option value="git" disabled={!workspace.workspace.commonDir}>
                      Git commit
                    </option>
                    <option value="artifact">Document or artifact</option>
                  </select>
                </Field>
                <Field label="Artifact reason" hint="Required when using artifact mode in a Git workspace.">
                  <input
                    name="reason"
                    defaultValue={workspace.workspace.commonDir ? '' : 'Non-Git workspace delivery'}
                  />
                </Field>
              </>
            ) : null}
          </div>
          {footer(dialog.parent ? 'Create task' : 'Create issue')}
        </AsyncForm>
      </Modal>
    );
  if (!packet || !issue || !root) return null;
  if (dialog.kind === 'decomposition') return <PlanningForm packet={packet} onClose={onClose} onSaved={onSaved} />;
  if (dialog.kind === 'scope-decision') return <ScopeReview packet={packet} onClose={onClose} onSaved={onSaved} />;
  if (dialog.kind === 'grants')
    return <GrantForm packet={packet} workspace={workspace} onClose={onClose} onSaved={onSaved} />;
  if (dialog.kind === 'scope')
    return (
      <Modal title="Edit requirement scope" subtitle={issue.key} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('issue_update', {
              ...base,
              ...formKey(data),
              description: String(data.get('description')),
              ...(issue.parentId ? { criteria: lines(data.get('criteria')) } : {})
            })
          }
        >
          <div className="form-body">
            <p className="notice">
              Scope changes invalidate current delivery evidence. A top-level requirement also receives a new draft
              design. Active execution must be reconciled first.
            </p>
            <Field label="Requirement description">
              <textarea name="description" required maxLength={65536} rows={8} defaultValue={issue.description} />
            </Field>
            {issue.parentId ? (
              <Field label="Mapped parent criteria" hint="One approved parent criterion ID per line.">
                <textarea name="criteria" rows={3} defaultValue={issue.criteria.join('\n')} />
              </Field>
            ) : null}
          </div>
          {footer('Save scope')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'plan')
    return (
      <Modal title="Edit plan" subtitle={issue.key} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('issue_update', {
              ...base,
              ...formKey(data),
              title: String(data.get('title')),
              priority: Number(data.get('priority')),
              plannedStart: data.get('start') || null,
              dueDate: data.get('due') || null,
              iteration: data.get('iteration') || null,
              estimate: data.get('estimate')
                ? {
                    value: Number(data.get('estimate')),
                    unit: String(data.get('unit')),
                    confidence: String(data.get('confidence'))
                  }
                : null
            })
          }
        >
          <div className="form-body">
            <Field label="Title">
              <input name="title" required maxLength={300} defaultValue={issue.titleSuffix} />
            </Field>
            <Field label="Priority">
              <select name="priority" defaultValue={issue.priority}>
                {[0, 1, 2, 3, 4].map((value) => (
                  <option value={value} key={value}>
                    {value === 0 ? '0 · Highest' : String(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Planned start">
              <input type="date" name="start" defaultValue={issue.plannedStart ?? ''} />
            </Field>
            <Field label="Due date">
              <input type="date" name="due" defaultValue={issue.dueDate ?? ''} />
            </Field>
            <Field label="Iteration">
              <input name="iteration" maxLength={120} defaultValue={issue.iteration ?? ''} />
            </Field>
            <Field label="Estimate" hint="Optional forecast, not measured effort.">
              <input
                name="estimate"
                type="number"
                min="0.01"
                max="100000"
                step="any"
                defaultValue={issue.estimate?.value ?? ''}
              />
            </Field>
            <Field label="Estimate unit">
              <select name="unit" defaultValue={issue.estimate?.unit ?? 'hours'}>
                <option value="hours">Hours</option>
                <option value="points">Points</option>
              </select>
            </Field>
            <Field label="Estimate confidence">
              <select name="confidence" defaultValue={issue.estimate?.confidence ?? 'low'}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
            <p className="muted">These metadata fields preserve current artifact approvals.</p>
          </div>
          {footer('Save plan')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'design')
    return (
      <Modal title="Edit design" subtitle={`${root.key} · ${root.title}`} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('design_set', {
              workspaceId: issue.workspaceId,
              issueId: root.id,
              expectedVersion: root.version,
              ...formKey(data),
              content: String(data.get('content')),
              criteria: lines(data.get('criteria'))
            })
          }
        >
          <div className="form-body">
            <p className="notice">
              Saving creates a new revision and invalidates affected approvals. Active execution must be reconciled
              first.
            </p>
            <Field label="Proposed design">
              <textarea name="content" required rows={10} defaultValue={packet.design?.content ?? ''} />
            </Field>
            <Field label="Acceptance criteria" hint="One criterion ID per line.">
              <textarea
                name="criteria"
                required
                rows={4}
                defaultValue={(packet.design?.criteria ?? root.criteria).join('\n')}
              />
            </Field>
          </div>
          {footer('Save draft')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'design-review' && packet.design)
    return (
      <Modal title="Review design" subtitle={`${root.key} · ${root.title}`} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('design_decide', {
              workspaceId: issue.workspaceId,
              issueId: root.id,
              expectedVersion: root.version,
              ...formKey(data),
              designId: packet.design!.id,
              decision: String(data.get('decision')),
              reason: String(data.get('reason'))
            })
          }
        >
          <div className="form-body">
            <p className="notice">Your decision applies only to this revision.</p>
            <dl className="metadata">
              <dt>Revision</dt>
              <dd>r{packet.revision}</dd>
              <dt>SHA-256</dt>
              <dd className="mono">{packet.design.hash}</dd>
            </dl>
            <h3>Requirement scope</h3>
            <div className="prose">
              {packet.design.requirementDescription ??
                'This older revision has no captured requirement scope. Create a new revision before approval.'}
            </div>
            <h3>Proposed design</h3>
            <div className="prose">{packet.design.content}</div>
            <h3>Acceptance criteria</h3>
            <ul>
              {packet.design.criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Field label="Decision reason">
              <textarea name="reason" required rows={4} placeholder="Explain your decision" />
            </Field>
          </div>
          <footer className="form-footer">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <span className="footer-actions">
              <button type="submit" name="decision" value="CHANGES_REQUESTED">
                Request changes
              </button>
              <button className="primary" type="submit" name="decision" value="APPROVED">
                Approve design
              </button>
            </span>
          </footer>
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'delivery')
    return (
      <Modal title="Review delivery" subtitle={`${issue.key} · ${issue.title}`} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('delivery_decide', {
              ...base,
              ...formKey(data),
              candidateId: issue.candidate!.id,
              digest: packet.deliveryDigest,
              decision: String(data.get('decision')),
              reason: String(data.get('reason'))
            })
          }
        >
          <div className="form-body">
            <p className="notice">
              Your decision applies only to this reviewed snapshot. Acceptance is saved if closure is still blocked.
            </p>
            <DeliveryEvidence packet={packet} />
            <Field label="Decision reason">
              <textarea name="reason" required rows={4} placeholder="Explain your acceptance or requested changes" />
            </Field>
          </div>
          <footer className="form-footer">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <span className="footer-actions">
              <button type="submit" name="decision" value="REJECT">
                Request rework
              </button>
              <button
                type="submit"
                className="primary"
                name="decision"
                value="ACCEPT"
                disabled={!packet.deliveryDigest}
              >
                Accept delivery
              </button>
            </span>
          </footer>
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'assignment')
    return (
      <Modal title="Assign worker" subtitle={issue.key} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('issue_assign', {
              ...base,
              ...formKey(data),
              actorId: String(data.get('actorId')),
              harness: String(data.get('harness'))
            })
          }
        >
          <div className="form-body">
            <Field label="Worker">
              <select name="actorId" required defaultValue={issue.assignee ?? ''}>
                <option value="" disabled>
                  Select an enrolled worker
                </option>
                {workspace.actors
                  .filter((a) => a.role === 'worker')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Harness">
              <select name="harness" defaultValue={issue.harness ?? 'codex'}>
                <option value="codex">Codex</option>
                <option value="dsh">DSH</option>
                <option value="claude-code">Claude Code</option>
              </select>
            </Field>
            <p className="muted">Create logical agents in Settings. Assignment does not start a model run.</p>
          </div>
          {footer('Save assignment')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'qa')
    return (
      <Modal title="Configure independent QA" subtitle={issue.key} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) => {
            const profiles = data.getAll('profiles').map(String);
            if (!profiles.length)
              throw new ApiError('CHECK_REQUIRED', 'Select at least one approved check profile', 400);
            return mutation('qa_configure', {
              ...base,
              ...formKey(data),
              actorId: String(data.get('actorId')),
              harness: String(data.get('harness')),
              checkProfileIds: profiles
            });
          }}
        >
          <div className="form-body">
            <Field label="QA reviewer">
              <select name="actorId" required defaultValue={issue.qaAssignee ?? ''}>
                <option value="" disabled>
                  Select an independent reviewer
                </option>
                {workspace.actors
                  .filter((a) => a.role === 'qa')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="QA harness">
              <select name="harness" defaultValue={issue.qaHarness ?? 'dsh'}>
                <option value="codex">Codex</option>
                <option value="dsh">DSH</option>
                <option value="claude-code">Claude Code</option>
              </select>
            </Field>
            <h3>Approved check profiles</h3>
            {workspace.profiles.map((profile) => (
              <label className="check-row" key={profile.id}>
                <input
                  type="checkbox"
                  name="profiles"
                  value={profile.id}
                  defaultChecked={issue.checkProfileIds?.includes(profile.id)}
                />
                <span>
                  {profile.name}
                  <small>{profile.criteria.join(', ')}</small>
                </span>
              </label>
            ))}
            {!workspace.profiles.length ? <p className="muted">Approve a test command in Settings first.</p> : null}
            <p className="muted">Configuring QA while this issue waits in QA testing queues a real reviewer run.</p>
          </div>
          {footer('Save QA configuration')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'transition')
    return (
      <Modal
        title={`${dialog.action?.[0].toUpperCase()}${dialog.action?.slice(1)} issue`}
        subtitle={issue.key}
        onClose={onClose}
      >
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('issue_transition', {
              ...base,
              ...formKey(data),
              action: dialog.action,
              reason: String(data.get('reason'))
            })
          }
        >
          <div className="form-body">
            <p className="muted">
              This records a lifecycle decision. Stopping or uncertain execution is tracked separately.
            </p>
            <Field label="Reason">
              <textarea name="reason" rows={4} required />
            </Field>
          </div>
          {footer('Confirm decision')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'dispatch')
    return (
      <Modal title="Dispatch worker" subtitle={issue.key} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('work_dispatch', {
              ...base,
              ...formKey(data),
              designId: packet.design?.id,
              scopeRevision: issue.scopeRevision
            })
          }
        >
          <div className="form-body">
            <p>
              Starts a real {harnessName(issue.harness)} run using its configured account. The service prepares an
              isolated execution directory.
            </p>
            <p className="notice">
              Only approved, assigned, unblocked work can start. Queued does not mean running or delivered.
            </p>
          </div>
          {footer(`Dispatch ${harnessName(issue.harness)}`)}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'git')
    return (
      <Modal title="Attach final commit" subtitle={issue.key} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('git_submit', {
              ...base,
              ...formKey(data),
              candidateId: issue.candidate!.id,
              commitUrl: String(data.get('url'))
            })
          }
        >
          <div className="form-body">
            <p className="notice">
              The full commit must belong to the owner-bound repository and match the complete reviewed snapshot.
              Changing the mapping invalidates delivery acceptance.
            </p>
            <Field label="GitHub commit URL">
              <input
                name="url"
                type="url"
                required
                defaultValue={packet.git?.url}
                placeholder="https://github.com/owner/repository/commit/FULL_SHA"
              />
            </Field>
          </div>
          {footer('Queue verification')}
        </AsyncForm>
      </Modal>
    );
  return null;
}

function DeliveryEvidence({ packet }: { packet: IssueData }) {
  const issue = packet.issue;
  return (
    <>
      <dl className="metadata">
        <dt>Digest</dt>
        <dd className="mono">{packet.deliveryDigest}</dd>
        <dt>Snapshot SHA-256</dt>
        <dd className="mono">{packet.snapshot?.hash ?? 'Unavailable'}</dd>
        <dt>Initial lead</dt>
        <dd className="mono">{issue.initialReview}</dd>
        <dt>Independent QA</dt>
        <dd className="mono">{issue.qaReview}</dd>
        <dt>Final lead</dt>
        <dd className="mono">{issue.finalReview}</dd>
        <dt>{issue.artifactMode === 'artifact' ? 'Artifact mode' : 'Commit'}</dt>
        <dd>
          {issue.artifactMode === 'artifact' ? (
            (issue.artifactReason ?? 'Reviewed artifact delivery')
          ) : packet.git ? (
            <a href={packet.git.url} target="_blank" rel="noreferrer">
              {packet.git.sha}
            </a>
          ) : (
            'No verified commit attached'
          )}
        </dd>
      </dl>
      <h3>Worker handoff</h3>
      <div className="prose">{issue.candidate?.summary}</div>
      {issue.candidate?.integration ? (
        <details>
          <summary>Accepted child manifest ({issue.candidate.integration.children.length} children)</summary>
          <dl className="metadata">
            <dt>Plan scope hash</dt>
            <dd className="mono">{issue.candidate.integration.planScopeHash}</dd>
            <dt>Integration hash</dt>
            <dd className="mono">{issue.candidate.integration.hash}</dd>
          </dl>
          {issue.candidate.integration.children.map((child) => (
            <section className="evidence-block" key={child.issueId}>
              <a href={`/w/${issue.workspaceId}/issues/${child.issueId}`}>Open accepted child</a>
              <dl className="metadata">
                <dt>Candidate</dt>
                <dd className="mono">{child.candidateId}</dd>
                <dt>Snapshot</dt>
                <dd className="mono">{child.snapshotId}</dd>
                <dt>Digest</dt>
                <dd className="mono">{child.digest}</dd>
              </dl>
              {child.commitUrl ? (
                <a href={child.commitUrl} target="_blank" rel="noreferrer">
                  Verified child commit
                </a>
              ) : null}
            </section>
          ))}
          {issue.candidate.integration.excluded?.map(child => <section className="evidence-block" key={child.issueId}>
            <a href={`/w/${issue.workspaceId}/issues/${child.issueId}`}>Excluded abandoned task</a>
            <dl className="metadata"><dt>Human decision</dt><dd className="mono">{child.decisionId}</dd><dt>Decision hash</dt><dd className="mono">{child.decisionHash}</dd><dt>Replacement tasks</dt><dd>{child.replacementIds.length ? child.replacementIds.map(id => <a key={id} href={`/w/${issue.workspaceId}/issues/${id}`}>{id} </a>) : 'Excluded without a named replacement; approved criteria remain required'}</dd></dl>
          </section>)}
        </details>
      ) : null}
      <details>
        <summary>Full manifest ({packet.snapshot?.files.length ?? 0} files)</summary>
        <pre className="json">
          {packet.snapshot?.files.map((file) => `${file.mode} ${file.path}\n${file.hash}`).join('\n\n')}
        </pre>
      </details>
      {packet.closureBlocked.length ? (
        <>
          <h3>Closure checks</h3>
          <ul>
            {packet.closureBlocked.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function GrantForm({
  packet,
  workspace,
  onClose,
  onSaved
}: {
  packet: IssueData;
  workspace: WorkspaceData;
  onClose(): void;
  onSaved(): void;
}) {
  const issue = packet.issue;
  const [action, setAction] = useState<Grant['action']>(
    issue.state === 'USER_ACCEPTANCE'
      ? 'complete'
      : issue.state === 'ON_HOLD'
        ? 'resume'
        : ['DONE', 'ABANDONED'].includes(issue.state)
          ? 'reopen'
          : 'hold'
  );
  const [openedAt] = useState(Date.now);
  const [section, setSection] = useState('create');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{
    grants: (Grant & { status: string })[];
    total: number;
    nextOffset: number | null;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPage(null);
    setError('');
    command<{ grants: (Grant & { status: string })[]; total: number; nextOffset: number | null }>('grant_list', {
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      offset
    })
      .then((result) => {
        if (active) setPage(result);
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [issue.id, issue.workspaceId, offset]);
  const done = () => {
    onSaved();
    onClose();
  };
  return (
    <Modal title="Human authorization" subtitle={`${issue.key} · ${issue.title}`} onClose={onClose}>
      <nav className="tabs" aria-label="Authorization sections">
        <button aria-current={section === 'create' ? 'page' : undefined} onClick={() => setSection('create')}>
          Create authorization
        </button>
        <button aria-current={section === 'history' ? 'page' : undefined} onClick={() => setSection('history')}>
          Grant history
        </button>
      </nav>
      <div hidden={section !== 'create'}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('grant_create', {
              workspaceId: issue.workspaceId,
              issueId: issue.id,
              expectedVersion: issue.version,
              ...formKey(data),
              granteeId: String(data.get('granteeId')),
              action,
              scopeHash: packet.authorizationScopeHash,
              expiresAt: new Date(openedAt + Number(data.get('minutes')) * 60000).toISOString(),
              maxUses: Number(data.get('uses')),
              reason: String(data.get('reason')),
              ...(action === 'complete' ? { candidateId: issue.candidate?.id, digest: packet.deliveryDigest } : {})
            })
          }
        >
          <div className="form-body">
            <p className="notice">
              Authorize one agent and one action on this exact issue. A parent hold also pauses descendant work; direct
              child actions require separate grants. Scope changes invalidate unused authority.
            </p>
            <h3>Authorized scope</h3>
            <div className="prose">{issue.description || 'Draft scope is empty.'}</div>
            <dl className="metadata">
              <dt>Scope revision</dt>
              <dd>{issue.scopeRevision}</dd>
              <dt>Design revision</dt>
              <dd className="mono">{packet.design?.id ?? 'No design yet'}</dd>
              <dt>Issue / child scope hash</dt>
              <dd className="mono">{packet.authorizationScopeHash}</dd>
            </dl>
            <Field label="Delegate to">
              <select name="granteeId" required defaultValue="">
                <option disabled value="">
                  Select a lead or PM
                </option>
                {workspace.actors
                  .filter((actor) => ['lead', 'pm'].includes(actor.role))
                  .map((actor) => (
                    <option key={actor.id} value={actor.id}>
                      {actor.name} ({actor.role})
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Allowed action">
              <select
                name="action"
                value={action}
                onChange={(event) => setAction(event.target.value as Grant['action'])}
              >
                {(['hold', 'resume', 'abandon', 'reopen', 'complete'] as const).map((value) => (
                  <option
                    key={value}
                    value={value}
                    disabled={value === 'complete' && (issue.state !== 'USER_ACCEPTANCE' || !packet.deliveryDigest)}
                  >
                    {value === 'complete'
                      ? 'Accept this snapshot and close when all guards pass'
                      : value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Expires after">
              <select name="minutes" defaultValue="60">
                <option value="15">15 minutes</option>
                <option value="60">1 hour</option>
                <option value="1440">1 day</option>
                <option value="10080">7 days</option>
              </select>
            </Field>
            <Field label="Maximum uses">
              <input name="uses" type="number" min="1" max="10" required defaultValue="1" />
            </Field>
            {action === 'complete' ? (
              <>
                <p className="notice">
                  This authorizes acceptance of the exact delivery below. The agent must still satisfy all closure
                  checks before the grant is consumed.
                </p>
                <DeliveryEvidence packet={packet} />
              </>
            ) : null}
            <Field label="Authorization reason">
              <textarea name="reason" required rows={3} />
            </Field>
          </div>
          <footer className="form-footer">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={action === 'complete' && !packet.deliveryDigest}>
              Create authorization
            </button>
          </footer>
        </AsyncForm>
      </div>
      <section className="form-body" hidden={section !== 'history'}>
        <h3>Recorded grants</h3>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {page ? (
          <>
            <p className="muted">
              {page.total} grants · Showing {page.grants.length ? offset + 1 : 0}–{offset + page.grants.length}
            </p>
            {page.grants.map((grant) => (
              <section className="evidence-block" key={grant.id}>
                <h3>
                  {grant.action} ·{' '}
                  {workspace.actors.find((actor) => actor.id === grant.granteeId)?.name ?? grant.granteeId}
                </h3>
                <p>
                  <Status value={grant.status} /> · {grant.uses}/{grant.maxUses} uses
                </p>
                <p className="muted">Expires {dateText(grant.expiresAt)}</p>
                <p>{grant.reason}</p>
                <p className="mono">{grant.id}</p>
                {grant.status === 'AVAILABLE' ? (
                  <AsyncForm
                    onDone={done}
                    onSave={(data) =>
                      mutation('grant_revoke', {
                        workspaceId: issue.workspaceId,
                        issueId: issue.id,
                        expectedVersion: issue.version,
                        ...formKey(data),
                        grantId: grant.id,
                        expectedGrantVersion: grant.version,
                        reason: String(data.get('reason'))
                      })
                    }
                  >
                    <Field label={`Revocation reason for ${grant.id}`}>
                      <input name="reason" required />
                    </Field>
                    <button type="submit">Revoke authorization</button>
                  </AsyncForm>
                ) : null}
              </section>
            ))}
            <div className="action-group">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>
                Previous grants
              </button>
              <button disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>
                Next grants
              </button>
            </div>
          </>
        ) : !error ? (
          <p className="muted">Loading grants…</p>
        ) : null}
      </section>
    </Modal>
  );
}
