import { useEffect, useState } from 'react';
import { command, dateText, errorText, formKey, lines, mutation } from './api';
import type { IssueData, PlanData } from './api';
import { AsyncForm, Field, Modal, Status } from './components';

export function PlanningForm({ packet, onClose, onSaved }: { packet: IssueData; onClose(): void; onSaved(): void }) {
  const root = packet.parent ?? packet.issue;
  const [data, setData] = useState<PlanData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    command<PlanData>('plan_get', { workspaceId: root.workspaceId, issueId: root.id, view: 'full', limit: 100 })
      .then((result) => {
        if (active) setData(result);
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [root.id, root.workspaceId]);
  return (
    <Modal title="Requirement decomposition" subtitle={`${root.key} · ${root.title}`} onClose={onClose}>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {!data && !error ? <p className="muted">Loading the current plan and task versions…</p> : null}
      {data ? (
        <AsyncForm
          onDone={() => {
            onSaved();
            onClose();
          }}
          onSave={(form) =>
            mutation('plan_apply', {
              workspaceId: root.workspaceId,
              issueId: root.id,
              expectedVersion: data.issue.version,
              expectedPlanId: data.plan?.id ?? null,
              designId: data.issue.designId,
              ...formKey(form),
              mode: String(form.get('mode')),
              reason: String(form.get('reason')),
              tasks: data.children.map((child, index) => ({
                ref: `task${index}`,
                issueId: child.id,
                expectedVersion: child.version,
                title: child.titleSuffix,
                description: child.description,
                criteria: lines(form.get(`criteria:${child.id}`)),
                dependencies: (child.state === 'NOT_STARTED' || child.state.endsWith('REJECTED')
                  ? form.getAll(`dependencies:${child.id}`).map(String)
                  : child.dependencies
                ).map((issueId) => ({ issueId }))
              })),
              integrationCriteria: form.getAll('integration').map(String),
              overlapReasons: Object.fromEntries(
                data.coverage.criteria
                  .map((row) => [row.criterionId, String(form.get(`overlap:${row.criterionId}`) ?? '').trim()])
                  .filter(([, reason]) => reason)
              )
            })
          }
        >
          <div className="form-body">
            <p className="notice">
              Save an incomplete draft or activate complete coverage of the approved design. These actions do not start
              model runs. Create tasks in the workspace first; all existing tasks stay in the plan.
            </p>
            <p>
              <Status value={data.coverage.status} /> · {data.coverage.children.done}/{data.coverage.children.total}{' '}
              tasks implemented
            </p>
            {data.coverage.blocking.length ? (
              <ul>
                {data.coverage.blocking.map((code) => (
                  <li key={code}>
                    <code>{code}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Current criterion coverage is ready. Integration acceptance remains separate.</p>
            )}
            <h3>Task ownership and dependencies</h3>
            {!data.children.length ? (
              <p className="muted">Add at least one task before activating the decomposition.</p>
            ) : null}
            {data.children.map((child) => {
              const editable = child.state === 'NOT_STARTED' || child.state.endsWith('REJECTED');
              const choices = [
                ...data.children
                  .filter((other) => other.id !== child.id)
                  .map((other) => ({ id: other.id, label: `${other.key} · ${other.titleSuffix}` })),
                ...child.dependencies
                  .filter((id) => !data.children.some((other) => other.id === id))
                  .map((id) => ({ id, label: `External requirement/task · ${id}` }))
              ];
              return (
                <details className="evidence-block" key={child.id} open={data.children.length < 4}>
                  <summary>
                    {child.key} · {child.titleSuffix}
                  </summary>
                  <p className="prose">{child.description || 'Draft scope is empty. Use Edit scope on the task.'}</p>
                  <Field
                    label={`Criteria for ${child.key}`}
                    hint="One parent criterion ID per line. Active and completed scope is read-only."
                  >
                    <textarea
                      name={`criteria:${child.id}`}
                      rows={2}
                      readOnly={!editable}
                      defaultValue={child.criteria.join('\n')}
                    />
                  </Field>
                  <Field
                    label={`Dependencies for ${child.key}`}
                    hint="Select tasks that must finish first. Use Ctrl or Command to select multiple."
                  >
                    <select
                      name={`dependencies:${child.id}`}
                      multiple
                      size={Math.min(4, Math.max(2, choices.length))}
                      disabled={!editable}
                      defaultValue={child.dependencies}
                    >
                      {choices.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </details>
              );
            })}
            <h3>Integration-only criteria and intentional overlap</h3>
            {data.coverage.criteria.map((row) => (
              <section className="evidence-block" key={row.criterionId}>
                <h3>{row.criterionId}</h3>
                <p className="muted">Current task owners: {row.tasks.map((task) => task.key).join(', ') || 'None'}</p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    name="integration"
                    value={row.criterionId}
                    defaultChecked={data.plan?.integrationCriteria.includes(row.criterionId)}
                  />
                  <span>Explicit integration coverage</span>
                </label>
                <Field
                  label={`Overlap reason for ${row.criterionId}`}
                  hint="Required if more than one task or integration check owns this criterion."
                >
                  <input
                    name={`overlap:${row.criterionId}`}
                    defaultValue={data.plan?.overlapReasons[row.criterionId] ?? ''}
                  />
                </Field>
              </section>
            ))}
            {data.history.length ? (
              <details>
                <summary>Previous plan revisions ({data.history.length} recent)</summary>
                {data.history.map((plan) => (
                  <p key={plan.id}>
                    <Status value={plan.mode} /> · {dateText(plan.createdAt)}
                    <br />
                    <span className="mono">{plan.id}</span>
                  </p>
                ))}
              </details>
            ) : null}
            <Field label="Planning reason">
              <textarea name="reason" rows={3} required placeholder="Explain this decomposition or amendment" />
            </Field>
          </div>
          <footer className="form-footer">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <span className="footer-actions">
              <button type="submit" name="mode" value="DRAFT">
                Save draft
              </button>
              <button type="submit" name="mode" value="READY" className="primary">
                Activate plan
              </button>
            </span>
          </footer>
        </AsyncForm>
      ) : null}
    </Modal>
  );
}
