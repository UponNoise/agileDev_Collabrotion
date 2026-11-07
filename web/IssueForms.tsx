import type { Issue } from '../src/contracts';
import { ApiError, formKey, harnessName, lines, mutation } from './api';
import type { IssueData, WorkspaceData } from './api';
import { AsyncForm, Field, Modal } from './components';

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
    | 'scope'
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
  if (dialog.kind === 'scope')
    return (
      <Modal title="Edit requirement scope" subtitle={issue.key} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('issue_update', { ...base, ...formKey(data), description: String(data.get('description')) })
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
              dueDate: data.get('due') || null
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
