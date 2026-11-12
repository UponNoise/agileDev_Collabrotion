import { useDateText } from './Preferences';
import { useText } from './Preferences';
import { useEffect, useRef, useState } from 'react';
import type { Grant, Issue } from '../src/contracts';
import { ApiError, command, errorText, formKey, harnessName, lines, mutation } from './api';
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
    | 'execution-recovery'
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
  const t = useText();
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
        {t('Cancel')}
      </button>
      <button className="primary" type="submit">
        {t(label)}
      </button>
    </footer>
  );
  if (dialog.kind === 'create')
    return (
      <Modal
        title={dialog.parent ? t('New task') : t('New issue')}
        subtitle={dialog.parent?.title}
        onClose={onClose}
      >
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('issue_create', {
              workspaceId: workspace.workspace.id,
              ...formKey(data),
              ...(dialog.parent
                ? { parentId: dialog.parent.id, expectedParentVersion: dialog.parent.version }
                : {}),
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
            <p className="notice">
              {t('New issues start as Not started. Assignment and dates are optional.')}
            </p>
            <Field
              label={t('Title')}
              hint={
                dialog.parent
                  ? t('Use [Type] Area: action -> outcome. The parent prefix is added automatically.')
                  : undefined
              }
            >
              <input
                name="title"
                maxLength={300}
                required
                placeholder={
                  dialog.parent
                    ? t('[Feature] Area: action -> outcome')
                    : t('What should this requirement achieve?')
                }
              />
            </Field>
            <Field label={t('Requirement description')}>
              <textarea name="description" rows={5} />
            </Field>
            <Field
              label={t('Acceptance criteria')}
              hint={t('One criterion ID per line. Tasks reference the parent design criteria.')}
            >
              <textarea name="criteria" rows={3} />
            </Field>
            {!dialog.parent ? (
              <>
                <Field label={t('Delivery mode')}>
                  <select name="mode" defaultValue={workspace.workspace.commonDir ? 'git' : 'artifact'}>
                    <option value="git" disabled={!workspace.workspace.commonDir}>
                      {t('Git commit')}
                    </option>
                    <option value="artifact">{t('Document or artifact')}</option>
                  </select>
                </Field>
                <Field
                  label={t('Artifact reason')}
                  hint={t('Required when using artifact mode in a Git workspace.')}
                >
                  <input
                    name="reason"
                    defaultValue={workspace.workspace.commonDir ? '' : 'Non-Git workspace delivery'}
                  />
                </Field>
              </>
            ) : null}
          </div>
          {footer(dialog.parent ? t('Create task') : t('Create issue'))}
        </AsyncForm>
      </Modal>
    );
  if (!packet || !issue || !root) return null;
  if (dialog.kind === 'decomposition')
    return <PlanningForm packet={packet} onClose={onClose} onSaved={onSaved} />;
  if (dialog.kind === 'scope-decision')
    return <ScopeReview packet={packet} onClose={onClose} onSaved={onSaved} />;
  if (dialog.kind === 'execution-recovery')
    return (
      <Modal
        title={t('Reconcile unbound execution')}
        subtitle={`${issue.key} · ${issue.titleSuffix}`}
        onClose={onClose}
      >
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('work_reconcile', {
              ...base,
              ...formKey(data),
              fence: packet.executionRecovery.fence,
              candidateId: packet.executionRecovery.candidateId,
              confirmStopped: data.has('confirmStopped'),
              reason: String(data.get('reason'))
            })
          }
        >
          <div className="form-body">
            <p className="notice">
              {t(
                'This older work has no managed execution binding. Inspect and stop its external worker before confirming. Recovery clears current ownership and reviews, keeps historical evidence, and requires a fresh isolated dispatch. An effective hold remains.'
              )}
            </p>
            <p className="prose">{issue.description}</p>
            <dl className="metadata">
              <dt>{t('Lifecycle')}</dt>
              <dd>{issue.state}</dd>
              <dt>{t('Lease fence')}</dt>
              <dd>{packet.executionRecovery.fence}</dd>
              <dt>{t('Lease owner')}</dt>
              <dd className="mono">{issue.lease?.actorId ?? t('No current lease')}</dd>
              <dt>{t('Candidate')}</dt>
              <dd className="mono">{packet.executionRecovery.candidateId ?? t('No current candidate')}</dd>
              <dt>{t('Prior handoff')}</dt>
              <dd className="prose">{issue.candidate?.summary ?? t('None recorded')}</dd>
            </dl>
            <Field
              label={t('I verified the old external worker has stopped')}
              hint={t(
                'The service has no provider identity for this legacy work. This records your confirmation rather than an automatic process check.'
              )}
            >
              <input type="checkbox" name="confirmStopped" required />
            </Field>
            <Field label={t('Recovery reason')}>
              <textarea name="reason" rows={4} required />
            </Field>
          </div>
          {footer('Confirm stopped and reset')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'grants')
    return <GrantForm packet={packet} workspace={workspace} onClose={onClose} onSaved={onSaved} />;
  if (dialog.kind === 'scope')
    return (
      <Modal title={t('Edit requirement scope')} subtitle={issue.key} onClose={onClose}>
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
              {t(
                'Scope changes invalidate current delivery evidence. A top-level requirement also receives a new draft design. Active execution must be reconciled first.'
              )}
            </p>
            <Field label={t('Requirement description')}>
              <textarea
                name="description"
                required
                maxLength={65536}
                rows={8}
                defaultValue={issue.description}
              />
            </Field>
            {issue.parentId ? (
              <Field
                label={t('Mapped parent criteria')}
                hint={t('One approved parent criterion ID per line.')}
              >
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
      <Modal title={t('Edit plan')} subtitle={issue.key} onClose={onClose}>
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
            <Field label={t('Title')}>
              <input name="title" required maxLength={300} defaultValue={issue.titleSuffix} />
            </Field>
            <Field label={t('Priority')}>
              <select name="priority" defaultValue={issue.priority}>
                {[0, 1, 2, 3, 4].map((value) => (
                  <option value={value} key={value}>
                    {value === 0 ? t('0 · Highest') : String(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Planned start')}>
              <input type="date" name="start" defaultValue={issue.plannedStart ?? ''} />
            </Field>
            <Field label={t('Due date')}>
              <input type="date" name="due" defaultValue={issue.dueDate ?? ''} />
            </Field>
            <Field label={t('Iteration ID')} hint={t('Saving this plan preserves iteration membership.')}>
              <input readOnly value={issue.iterationId ?? t('Not set')} />
            </Field>
            <Field label={t('Legacy iteration label')} hint={t('Historical labels are read-only and do not create iteration records.')}>
              <input readOnly value={issue.legacyIterationLabel ?? issue.iteration ?? t('Not set')} />
            </Field>
            <Field label={t('Estimate')} hint={t('Optional forecast, not measured effort.')}>
              <input
                name="estimate"
                type="number"
                min="0.01"
                max="100000"
                step="any"
                defaultValue={issue.estimate?.value ?? ''}
              />
            </Field>
            <Field label={t('Estimate unit')}>
              <select name="unit" defaultValue={issue.estimate?.unit ?? 'hours'}>
                <option value="hours">{t('Hours')}</option>
                <option value="points">{t('Points')}</option>
              </select>
            </Field>
            <Field label={t('Estimate confidence')}>
              <select name="confidence" defaultValue={issue.estimate?.confidence ?? 'low'}>
                <option value="low">{t('Low')}</option>
                <option value="medium">{t('Medium')}</option>
                <option value="high">{t('High')}</option>
              </select>
            </Field>
            <p className="muted">{t('These metadata fields preserve current artifact approvals.')}</p>
          </div>
          {footer('Save plan')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'design')
    return (
      <Modal title={t('Edit design')} subtitle={`${root.key} · ${root.title}`} onClose={onClose}>
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
              {t(
                'Saving creates a new revision and invalidates affected approvals. Active execution must be reconciled first.'
              )}
            </p>
            <Field label={t('Proposed design')}>
              <textarea name="content" required rows={10} defaultValue={packet.design?.content ?? ''} />
            </Field>
            <Field label={t('Acceptance criteria')} hint={t('One criterion ID per line.')}>
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
      <Modal title={t('Review design')} subtitle={`${root.key} · ${root.title}`} onClose={onClose}>
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
            <p className="notice">{t('Your decision applies only to this revision.')}</p>
            <dl className="metadata">
              <dt>{t('Revision')}</dt>
              <dd>r{packet.revision}</dd>
              <dt>SHA-256</dt>
              <dd className="mono">{packet.design.hash}</dd>
            </dl>
            <h3>{t('Requirement scope')}</h3>
            <div className="prose">
              {packet.design.requirementDescription ??
                t(
                  'This older revision has no captured requirement scope. Create a new revision before approval.'
                )}
            </div>
            <h3>{t('Proposed design')}</h3>
            <div className="prose">{packet.design.content}</div>
            <h3>{t('Acceptance criteria')}</h3>
            <ul>
              {packet.design.criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Field label={t('Decision reason')}>
              <textarea name="reason" required rows={4} placeholder={t('Explain your decision')} />
            </Field>
          </div>
          <footer className="form-footer">
            <button type="button" onClick={onClose}>
              {t('Cancel')}
            </button>
            <span className="footer-actions">
              <button type="submit" name="decision" value="CHANGES_REQUESTED">
                {t('Request changes')}
              </button>
              <button className="primary" type="submit" name="decision" value="APPROVED">
                {t('Approve design')}
              </button>
            </span>
          </footer>
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'delivery')
    return <DeliveryReview packet={packet} onClose={onClose} onSaved={onSaved} />;
  if (dialog.kind === 'assignment')
    return (
      <Modal title={t('Assign worker')} subtitle={issue.key} onClose={onClose}>
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
            <Field label={t('Worker')}>
              <select name="actorId" required defaultValue={issue.assignee ?? ''}>
                <option value="" disabled>
                  {t('Select an enrolled worker')}
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
            <Field label={t('Harness')}>
              <select name="harness" defaultValue={issue.harness ?? 'codex'}>
                <option value="codex">Codex</option>
                <option value="dsh">DSH</option>
                <option value="claude-code">Claude Code</option>
              </select>
            </Field>
            <p className="muted">
              {t('Create logical agents in Settings. Assignment does not start a model run.')}
            </p>
          </div>
          {footer('Save assignment')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'qa')
    return (
      <Modal title={t('Configure independent QA')} subtitle={issue.key} onClose={onClose}>
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
            <Field label={t('QA reviewer')}>
              <select name="actorId" required defaultValue={issue.qaAssignee ?? ''}>
                <option value="" disabled>
                  {t('Select an independent reviewer')}
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
            <Field label={t('QA harness')}>
              <select name="harness" defaultValue={issue.qaHarness ?? 'dsh'}>
                <option value="codex">Codex</option>
                <option value="dsh">DSH</option>
                <option value="claude-code">Claude Code</option>
              </select>
            </Field>
            <h3>{t('Approved check profiles')}</h3>
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
            {!workspace.profiles.length ? (
              <p className="muted">{t('Approve a test command in Settings first.')}</p>
            ) : null}
            <p className="muted">
              {t('Configuring QA while this issue waits in QA testing queues a real reviewer run.')}
            </p>
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
              {t('This records a lifecycle decision. Stopping or uncertain execution is tracked separately.')}
            </p>
            <Field label={t('Reason')}>
              <textarea name="reason" rows={4} required />
            </Field>
          </div>
          {footer('Confirm decision')}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'dispatch')
    return (
      <Modal title={t('Dispatch worker')} subtitle={issue.key} onClose={onClose}>
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
              {t('Starts a real ')}
              {harnessName(issue.harness)}
              {t(' run using its configured account. The service prepares an isolated execution directory.')}
            </p>
            <p className="notice">
              {t(
                'Only approved, assigned, unblocked work can start. Queued does not mean running or delivered.'
              )}
            </p>
          </div>
          {footer(`Dispatch ${harnessName(issue.harness)}`)}
        </AsyncForm>
      </Modal>
    );
  if (dialog.kind === 'git')
    return (
      <Modal title={t('Attach final commits')} subtitle={issue.key} onClose={onClose}>
        <AsyncForm
          onDone={done}
          onSave={(data) =>
            mutation('git_submit', {
              ...base,
              ...formKey(data),
              candidateId: issue.candidate!.id,
              commitUrl: String(data.get('url')),
              additionalCommits: String(data.get('additional') ?? '')
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const separator = line.search(/\s+/);
                  return { repository: line.slice(0, separator), commitUrl: line.slice(separator + 1) };
                })
                .filter((entry) => entry.repository && entry.commitUrl)
            })
          }
        >
          <div className="form-body">
            <p className="notice">
              {t(
                'The full commit must belong to the owner-bound repository and match the complete reviewed snapshot. Changing the mapping invalidates delivery acceptance.'
              )}
            </p>
            <Field label={t('Primary GitHub commit URL')}>
              <input
                name="url"
                type="url"
                required
                defaultValue={packet.git?.entries[0]?.url}
                placeholder="https://github.com/owner/repository/commit/FULL_SHA"
              />
            </Field>
            <Field
              label={t('Additional changed repositories')}
              hint={t(
                'Optional. One entry per line: owner/repository followed by its canonical commit URL. Recorded as reference-only evidence; multi-repository closure stays blocked.'
              )}
            >
              <textarea
                name="additional"
                rows={3}
                placeholder={'owner/repo https://github.com/owner/repo/commit/FULL_SHA'}
              />
            </Field>
          </div>
          {footer('Queue verification')}
        </AsyncForm>
      </Modal>
    );
  return null;
}

const rejectionClasses = ['DEFECT', 'SCOPE_CHANGE', 'CLARIFICATION'] as const;
const findingSeverities = ['BLOCKER', 'MAJOR', 'MINOR', 'INFO'] as const;
interface RejectionFinding {
  id: string;
  severity: typeof findingSeverities[number] | '';
  criterionIds: string[];
  reproduce: string;
  expected: string;
  actual: string;
}
const emptyFinding = (): RejectionFinding => ({ id: crypto.randomUUID(), severity: '', criterionIds: [], reproduce: '', expected: '', actual: '' });

function DeliveryReview({ packet, onClose, onSaved }: { packet: IssueData; onClose(): void; onSaved(): void }) {
  const t = useText();
  const issue = packet.issue;
  const [rejecting, setRejecting] = useState(false);
  const [classification, setClassification] = useState<typeof rejectionClasses[number] | ''>('');
  const [findings, setFindings] = useState<RejectionFinding[]>(() => [emptyFinding()]);
  const [reason, setReason] = useState('');
  const classificationInput = useRef<HTMLSelectElement>(null);
  const acceptButton = useRef<HTMLButtonElement>(null);
  const wasRejecting = useRef(false);
  useEffect(() => {
    if (rejecting) classificationInput.current?.focus();
    else if (wasRejecting.current) acceptButton.current?.focus();
    wasRejecting.current = rejecting;
  }, [rejecting]);
  const updateFinding = (id: string, change: Partial<RejectionFinding>) => setFindings(previous => previous.map(finding => finding.id === id ? { ...finding, ...change } : finding));
  return <Modal title={t('Review delivery')} subtitle={`${issue.key} · ${issue.title}`} onClose={onClose}>
    <AsyncForm onDone={() => { onSaved(); onClose(); }} onSave={data => {
      const decision = String(data.get('decision'));
      const base = { workspaceId: issue.workspaceId, issueId: issue.id, expectedVersion: issue.version, ...formKey(data), candidateId: issue.candidate?.id, digest: packet.deliveryDigest, decision, reason: String(data.get('reason')) };
      if (decision === 'ACCEPT') return mutation('delivery_decide', base);
      if (decision !== 'REJECT' || !classification || !rejectionClasses.includes(classification)) throw new ApiError('REJECTION_CLASS_REQUIRED', 'Choose a rejection classification explicitly.', 400);
      if (classification !== 'DEFECT') return mutation('delivery_decide', { ...base, classification });
      if (findings.length < 1 || findings.length > 20 || findings.some(finding => !finding.severity || !findingSeverities.includes(finding.severity) || !finding.reproduce.trim() || !finding.expected.trim() || !finding.actual.trim())) throw new ApiError('DEFECT_INPUT_REQUIRED', 'Provide 1 to 20 defects with severity, reproduction, expected and actual behavior.', 400);
      if (findings.some(finding => finding.criterionIds.some(id => !issue.criteria.includes(id)))) throw new ApiError('CRITERIA_UNMAPPED', 'Select only criteria from this issue.', 400);
      return mutation('delivery_decide', { ...base, classification, findings: findings.map(({ severity, criterionIds, reproduce, expected, actual }) => ({ severity, criterionIds, reproduce: reproduce.trim(), expected: expected.trim(), actual: actual.trim() })) });
    }}>
      <div className="form-body">
        <p className="notice">{t('Your decision applies only to this reviewed snapshot. Acceptance is saved if closure is still blocked.')}</p>
        <DeliveryEvidence packet={packet} />
        <Field label={t('Decision reason')}><textarea name="reason" required rows={4} value={reason} onChange={event => setReason(event.target.value)} placeholder={t('Explain your acceptance or requested changes')} /></Field>
        {rejecting ? <section aria-labelledby="rejection-heading">
          <h3 id="rejection-heading">{t('Classify requested rework')}</h3>
          <Field label={t('Rejection classification')}>
            <select ref={classificationInput} required value={classification} onChange={event => setClassification(event.target.value as typeof classification)}>
              <option value="" disabled>{t('Choose a classification')}</option>
              <option value="DEFECT">{t('Defect in this delivery')}</option>
              <option value="SCOPE_CHANGE">{t('Requirement scope change')}</option>
              <option value="CLARIFICATION">{t('Clarification or feedback')}</option>
            </select>
          </Field>
          {classification === 'SCOPE_CHANGE' ? <p className="notice">{t('Rework will require a different current design approved after this rejection. This does not create or approve a design.')}</p> : classification === 'CLARIFICATION' ? <p className="muted">{t('This records actionable feedback without creating a defect or requiring a new design approval.')}</p> : classification === 'DEFECT' ? <>
            <p className="muted">{t('Record 1 to 20 defects observed on this exact delivery. Affected criteria are optional; select only criteria listed on this issue.')}</p>
            {findings.map((finding, index) => <fieldset className="rejection-finding" key={finding.id}>
              <legend>{t('Defect {number}').replace('{number}', String(index + 1))}</legend>
              <Field label={t('Severity')}><select required value={finding.severity} onChange={event => updateFinding(finding.id, { severity: event.target.value as RejectionFinding['severity'] })}>
                <option value="" disabled>{t('Choose a severity')}</option>
                {findingSeverities.map(severity => <option value={severity} key={severity}>{t(severity)}</option>)}
              </select></Field>
              <fieldset><legend>{t('Affected criteria (optional)')}</legend>
                {issue.criteria.map(id => <label className="check-row" key={id}><input type="checkbox" checked={finding.criterionIds.includes(id)} onChange={event => updateFinding(finding.id, { criterionIds: event.target.checked ? [...finding.criterionIds, id] : finding.criterionIds.filter(value => value !== id) })} /><span>{id}</span></label>)}
              </fieldset>
              <Field label={t('Reproduction steps')}><textarea required maxLength={65536} rows={3} value={finding.reproduce} onChange={event => updateFinding(finding.id, { reproduce: event.target.value })} /></Field>
              <Field label={t('Expected behavior')}><textarea required maxLength={65536} rows={3} value={finding.expected} onChange={event => updateFinding(finding.id, { expected: event.target.value })} /></Field>
              <Field label={t('Actual behavior')}><textarea required maxLength={65536} rows={3} value={finding.actual} onChange={event => updateFinding(finding.id, { actual: event.target.value })} /></Field>
              <button type="button" disabled={findings.length === 1} aria-label={t('Remove defect {number}').replace('{number}', String(index + 1))} onClick={() => setFindings(previous => previous.filter(value => value.id !== finding.id))}>{t('Remove defect')}</button>
            </fieldset>)}
            <button type="button" disabled={findings.length >= 20} onClick={() => setFindings(previous => [...previous, emptyFinding()])}>{t('Add defect')}</button>
          </> : null}
          <p className="muted">{t('If a response is lost, retry this unchanged form for the same reviewed delivery. Changed evidence must be reviewed separately.')}</p>
        </section> : null}
      </div>
      <footer className="form-footer">
        <button type="button" onClick={onClose}>{t('Cancel')}</button>
        <span className="footer-actions">{rejecting ? <>
          <button type="button" onClick={() => setRejecting(false)}>{t('Back to acceptance')}</button>
          <button type="submit" name="decision" value="REJECT" disabled={!packet.deliveryDigest}>{t('Confirm rejection')}</button>
        </> : <>
          <button type="button" onClick={() => setRejecting(true)}>{t('Request rework')}</button>
          <button ref={acceptButton} type="submit" className="primary" name="decision" value="ACCEPT" disabled={!packet.deliveryDigest}>{t('Accept delivery')}</button>
        </>}</span>
      </footer>
    </AsyncForm>
  </Modal>;
}

function DeliveryEvidence({ packet }: { packet: IssueData }) {
  const t = useText();
  const issue = packet.issue;
  return (
    <>
      <dl className="metadata">
        <dt>{t('Digest')}</dt>
        <dd className="mono">{packet.deliveryDigest}</dd>
        <dt>{t('Snapshot SHA-256')}</dt>
        <dd className="mono">{packet.snapshot?.hash ?? t('Unavailable')}</dd>
        <dt>{t('Initial lead')}</dt>
        <dd className="mono">{issue.initialReview}</dd>
        <dt>{t('Independent QA')}</dt>
        <dd className="mono">{issue.qaReview}</dd>
        <dt>{t('Final lead')}</dt>
        <dd className="mono">{issue.finalReview}</dd>
        <dt>{issue.artifactMode === 'artifact' ? t('Artifact mode') : t('Commit')}</dt>
        <dd>
          {issue.artifactMode === 'artifact' ? (
            (issue.artifactReason ?? t('Reviewed artifact delivery'))
          ) : packet.git ? (
            packet.git.entries.map((entry, index) => (
              <a key={`${entry.repository}-${entry.sha}`} className="mono" href={entry.url} target="_blank" rel="noreferrer">
                {entry.repository} @ {entry.sha.slice(0, 8)}
                {index > 0 || entry.attempt?.evidenceRole === 'reference' ? t(' (reference-only)') : ''}
              </a>
            ))
          ) : (
            'No verified commit attached'
          )}
        </dd>
      </dl>
      <h3>{t('Worker handoff')}</h3>
      <div className="prose">{issue.candidate?.summary}</div>
      {issue.candidate?.integration ? (
        <details>
          <summary>
            {t('Accepted child manifest (')}
            {issue.candidate.integration.children.length}
            {t(' children)')}
          </summary>
          <dl className="metadata">
            <dt>{t('Plan scope hash')}</dt>
            <dd className="mono">{issue.candidate.integration.planScopeHash}</dd>
            <dt>{t('Integration hash')}</dt>
            <dd className="mono">{issue.candidate.integration.hash}</dd>
          </dl>
          {issue.candidate.integration.children.map((child) => (
            <section className="evidence-block" key={child.issueId}>
              <a href={`/w/${issue.workspaceId}/issues/${child.issueId}`}>{t('Open accepted child')}</a>
              <dl className="metadata">
                <dt>{t('Candidate')}</dt>
                <dd className="mono">{child.candidateId}</dd>
                <dt>{t('Snapshot')}</dt>
                <dd className="mono">{child.snapshotId}</dd>
                <dt>{t('Digest')}</dt>
                <dd className="mono">{child.digest}</dd>
              </dl>
              {child.commitUrl ? (
                <a href={child.commitUrl} target="_blank" rel="noreferrer">
                  {t('Verified child commit')}
                </a>
              ) : null}
            </section>
          ))}
          {issue.candidate.integration.excluded?.map((child) => (
            <section className="evidence-block" key={child.issueId}>
              <a href={`/w/${issue.workspaceId}/issues/${child.issueId}`}>{t('Excluded abandoned task')}</a>
              <dl className="metadata">
                <dt>{t('Human decision')}</dt>
                <dd className="mono">{child.decisionId}</dd>
                <dt>{t('Decision hash')}</dt>
                <dd className="mono">{child.decisionHash}</dd>
                <dt>{t('Replacement tasks')}</dt>
                <dd>
                  {child.replacementIds.length
                    ? child.replacementIds.map((id) => (
                        <a key={id} href={`/w/${issue.workspaceId}/issues/${id}`}>
                          {id}{' '}
                        </a>
                      ))
                    : t('Excluded without a named replacement; approved criteria remain required')}
                </dd>
              </dl>
            </section>
          ))}
        </details>
      ) : null}
      <details>
        <summary>
          {t('Full manifest (')}
          {packet.snapshot?.files.length ?? 0}
          {t(' files)')}
        </summary>
        <pre className="json">
          {packet.snapshot?.files.map((file) => `${file.mode} ${file.path}\n${file.hash}`).join('\n\n')}
        </pre>
      </details>
      {packet.closureBlocked.length ? (
        <>
          <h3>{t('Closure checks')}</h3>
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
  const dateText = useDateText();
  const t = useText();
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
    command<{ grants: (Grant & { status: string })[]; total: number; nextOffset: number | null }>(
      'grant_list',
      {
        workspaceId: issue.workspaceId,
        issueId: issue.id,
        offset
      }
    )
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
    <Modal title={t('Human authorization')} subtitle={`${issue.key} · ${issue.title}`} onClose={onClose}>
      <nav className="tabs" aria-label={t('Authorization sections')}>
        <button aria-current={section === 'create' ? 'page' : undefined} onClick={() => setSection('create')}>
          {t('Create authorization')}
        </button>
        <button
          aria-current={section === 'history' ? 'page' : undefined}
          onClick={() => setSection('history')}
        >
          {t('Grant history')}
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
              ...(action === 'complete'
                ? { candidateId: issue.candidate?.id, digest: packet.deliveryDigest }
                : {})
            })
          }
        >
          <div className="form-body">
            <p className="notice">
              {t(
                'Authorize one agent and one action on this exact issue. A parent hold also pauses descendant work; direct child actions require separate grants. Scope changes invalidate unused authority.'
              )}
            </p>
            <h3>{t('Authorized scope')}</h3>
            <div className="prose">{issue.description || t('Draft scope is empty.')}</div>
            <dl className="metadata">
              <dt>{t('Scope revision')}</dt>
              <dd>{issue.scopeRevision}</dd>
              <dt>{t('Design revision')}</dt>
              <dd className="mono">{packet.design?.id ?? t('No design yet')}</dd>
              <dt>{t('Issue / child scope hash')}</dt>
              <dd className="mono">{packet.authorizationScopeHash}</dd>
            </dl>
            <Field label={t('Delegate to')}>
              <select name="granteeId" required defaultValue="">
                <option disabled value="">
                  {t('Select a lead or PM')}
                </option>
                {workspace.actors
                  .filter((actor) => ['lead', 'pm'].includes(actor.role))
                  .map((actor) => (
                    <option key={actor.id} value={actor.id}>
                      {actor.name} ({t(actor.role)})
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t('Allowed action')}>
              <select
                name="action"
                value={action}
                onChange={(event) => setAction(event.target.value as Grant['action'])}
              >
                {(['hold', 'resume', 'abandon', 'reopen', 'complete'] as const).map((value) => (
                  <option
                    key={value}
                    value={value}
                    disabled={
                      value === 'complete' && (issue.state !== 'USER_ACCEPTANCE' || !packet.deliveryDigest)
                    }
                  >
                    {value === 'complete'
                      ? t('Accept this snapshot and close when all guards pass')
                      : t(value[0].toUpperCase() + value.slice(1))}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Expires after')}>
              <select name="minutes" defaultValue="60">
                <option value="15">{t('15 minutes')}</option>
                <option value="60">{t('1 hour')}</option>
                <option value="1440">{t('1 day')}</option>
                <option value="10080">{t('7 days')}</option>
              </select>
            </Field>
            <Field label={t('Maximum uses')}>
              <input name="uses" type="number" min="1" max="10" required defaultValue="1" />
            </Field>
            {action === 'complete' ? (
              <>
                <p className="notice">
                  {t(
                    'This authorizes acceptance of the exact delivery below. The agent must still satisfy all closure checks before the grant is consumed.'
                  )}
                </p>
                <DeliveryEvidence packet={packet} />
              </>
            ) : null}
            <Field label={t('Authorization reason')}>
              <textarea name="reason" required rows={3} />
            </Field>
          </div>
          <footer className="form-footer">
            <button type="button" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button
              className="primary"
              type="submit"
              disabled={action === 'complete' && !packet.deliveryDigest}
            >
              {t('Create authorization')}
            </button>
          </footer>
        </AsyncForm>
      </div>
      <section className="form-body" hidden={section !== 'history'}>
        <h3>{t('Recorded grants')}</h3>
        {error ? (
          <p className="error" role="alert">
            {t(error)}
          </p>
        ) : null}
        {page ? (
          <>
            <p className="muted">
              {page.total}
              {t(' grants · Showing ')}
              {page.grants.length ? offset + 1 : 0}–{offset + page.grants.length}
            </p>
            {page.grants.map((grant) => (
              <section className="evidence-block" key={grant.id}>
                <h3>
                  {grant.action} ·{' '}
                  {workspace.actors.find((actor) => actor.id === grant.granteeId)?.name ?? grant.granteeId}
                </h3>
                <p>
                  <Status value={grant.status} /> · {grant.uses}/{grant.maxUses}
                  {t(' uses')}
                </p>
                <p className="muted">
                  {t('Expires ')}
                  {dateText(grant.expiresAt)}
                </p>
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
                    <Field label={`${t('Revocation reason')} ${grant.id}`}>
                      <input name="reason" required />
                    </Field>
                    <button type="submit">{t('Revoke authorization')}</button>
                  </AsyncForm>
                ) : null}
              </section>
            ))}
            <div className="action-group">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>
                {t('Previous grants')}
              </button>
              <button disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>
                {t('Next grants')}
              </button>
            </div>
          </>
        ) : !error ? (
          <p className="muted">{t('Loading grants…')}</p>
        ) : null}
      </section>
    </Modal>
  );
}
