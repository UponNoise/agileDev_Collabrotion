import { useDateText } from './Preferences';
import { useText } from './Preferences';
import { useEffect, useState } from 'react';
import { AppearanceSettings } from './Preferences';
import type { Actor, Run, Workspace } from '../src/contracts';
import { command, errorText, formKey, harnessName, lines, mutation, stateLabel } from './api';
import type { DisplayIssue, WorkspaceData } from './api';
import { AsyncForm, Empty, Field, Icon, JsonView, Modal, Status } from './components';

export function Backlog({
  data,
  selected,
  onSelect,
  board
}: {
  data: WorkspaceData;
  selected: string | null;
  onSelect(id: string): void;
  board: boolean;
}) {
  const t = useText();
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const name = (id?: string | null) => data.actors.find((actor) => actor.id === id)?.name ?? t('Unassigned');
  const issueTitle = (issue: DisplayIssue) => issue.titleSuffix;
  if (!data.issues.length)
    return (
      <Empty title={t('No matching issues')}>
        <p>{t('Create a requirement or adjust the filters.')}</p>
      </Empty>
    );
  if (board) {
    const columns = [
      { name: 'Not started', states: ['NOT_STARTED'] },
      { name: 'Development', states: ['IN_PROGRESS'] },
      { name: 'Lead review', states: ['LEAD_REVIEW'] },
      { name: 'QA', states: ['QA_TEST'] },
      { name: 'Acceptance', states: ['USER_ACCEPTANCE'] },
      { name: 'Implemented', states: ['DONE'] },
      {
        name: 'Needs attention',
        states: ['LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED', 'ON_HOLD', 'ABANDONED']
      }
    ];
    return (
      <div className="board">
        {columns.map((column) => {
          const items = data.issues.filter((issue) => column.states.includes(issue.state));
          return (
            <section className="board-lane" key={column.name}>
              <h2>
                {t(column.name)}
                <span>{items.length}</span>
              </h2>
              {items.map((issue) => (
                <button
                  key={issue.id}
                  className={`board-issue ${selected === issue.id ? 'selected' : ''}`}
                  onClick={() => onSelect(issue.id)}
                >
                  <small>{issue.key}</small>
                  <strong>{issueTitle(issue)}</strong>
                  <Status value={issue.state} label={stateLabel(issue, data.designs)} />
                  <small>{name(issue.state === 'QA_TEST' ? issue.qaAssignee : issue.assignee)}</small>
                </button>
              ))}
            </section>
          );
        })}
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="issue-table">
        <thead>
          <tr>
            <th>{t('Issue')}</th>
            <th>{t('Status')}</th>
            <th>{t('Owner')}</th>
            <th>{t('Harness')}</th>
          </tr>
        </thead>
        <tbody>
          {data.issues
            .filter((issue) => !issue.parentId || !collapsed.has(issue.parentId))
            .map((issue) => {
              const children = !issue.parentId && data.issues.some((child) => child.parentId === issue.id);
              return (
                <tr
                  key={issue.id}
                  className={`${selected === issue.id ? 'selected' : ''} ${issue.parentId ? 'child-row' : ''}`}
                >
                  <td>
                    <div className="issue-cell">
                      {children ? (
                        <button
                          className={`icon-button expand ${collapsed.has(issue.id) ? '' : 'expanded'}`}
                          aria-label={`${collapsed.has(issue.id) ? t('Expand') : t('Collapse')} ${issue.key}`}
                          onClick={() =>
                            setCollapsed((previous) => {
                              const next = new Set(previous);
                              if (next.has(issue.id)) next.delete(issue.id);
                              else next.add(issue.id);
                              return next;
                            })
                          }
                        >
                          <Icon name="chevron" />
                        </button>
                      ) : (
                        <span className="tree-branch" />
                      )}
                      <button
                        className="issue-link"
                        onClick={() => onSelect(issue.id)}
                        aria-current={selected === issue.id ? 'page' : undefined}
                      >
                        <strong>{issue.key}</strong>
                        <span>{issueTitle(issue)}</span>
                      </button>
                    </div>
                  </td>
                  <td>
                    <Status
                      value={stateLabel(issue, data.designs) === 'Design review' ? 'IN_REVIEW' : issue.state}
                      label={stateLabel(issue, data.designs)}
                    />
                    {issue.scope?.status === 'EXCLUDED' ? (
                      <small className="scope-label">{t('Excluded from delivery')}</small>
                    ) : issue.scope?.status === 'STALE' ? (
                      <small className="scope-label">{t('Scope decision stale')}</small>
                    ) : null}
                  </td>
                  <td>{name(issue.state === 'QA_TEST' ? issue.qaAssignee : issue.assignee)}</td>
                  <td>{harnessName(issue.state === 'QA_TEST' ? issue.qaHarness : issue.harness)}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
export function WorkspaceRegistration({ onRegistered }: { onRegistered(workspace: Workspace): void }) {
  const t = useText();
  return (
    <AsyncForm
      className="settings-form"
      onSave={async (data) => {
        const result = await mutation<{ workspace: Workspace }>('workspace_register', {
          ...formKey(data),
          root: String(data.get('root')),
          name: String(data.get('name')),
          prefix: String(data.get('prefix'))
        });
        onRegistered(result.workspace);
      }}
    >
      <Field label={t('Workspace name')}>
        <input name="name" required maxLength={120} />
      </Field>
      <Field
        label={t('Project directory')}
        hint={t('Use an existing absolute directory. Its contents stay local.')}
      >
        <input name="root" required placeholder="C:\Projects\my-project" />
      </Field>
      <Field label={t('Issue prefix')}>
        <input name="prefix" required pattern="[A-Z][A-Z0-9]{1,9}" maxLength={10} placeholder="APP" />
      </Field>
      <button className="primary" type="submit">
        {t('Register workspace')}
      </button>
    </AsyncForm>
  );
}
export function Settings({
  data,
  onSaved,
  onRegistered
}: {
  data: WorkspaceData;
  onSaved(): void;
  onRegistered(workspace: Workspace): void;
}) {
  const dateText = useDateText();
  const t = useText();
  const [credential, setCredential] = useState<{ actor: Actor; token?: string } | null>(null);
  const [copied, setCopied] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(credential?.token ?? '');
      setCopied('Credential copied.');
    } catch {
      setCopied('Select and copy the credential manually.');
    }
  }
  return (
    <div className="settings">
      <AppearanceSettings />
      <section>
        <h2>{t('Workspace')}</h2>
        <dl className="metadata">
          <dt>{t('Directory')}</dt>
          <dd className="mono">{data.workspace.root}</dd>
          <dt>{t('Workspace ID')}</dt>
          <dd className="mono">{data.workspace.id}</dd>
          <dt>{t('Git binding')}</dt>
          <dd className="mono">{data.workspace.gitBindingId ?? t('Not bound')}</dd>
        </dl>
        <details>
          <summary>{t('Register another workspace')}</summary>
          <WorkspaceRegistration onRegistered={onRegistered} />
        </details>
      </section>
      <section>
        <h2>{t('Agents')}</h2>
        <p className="muted">
          {t('Roles are workflow identities. Enrolling an agent does not start a model run.')}
        </p>
        <ul className="simple-list">
          {data.actors.map((actor) => (
            <li key={actor.id}>
              <span>{actor.name}</span>
              <small>{t(actor.role)}</small>
            </li>
          ))}
        </ul>
        <details>
          <summary>{t('Enroll an agent')}</summary>
          <AsyncForm
            className="settings-form"
            onDone={onSaved}
            onSave={async (form) => {
              const result = await mutation<{ actor: Actor; token?: string }>('actor_enroll', {
                workspaceId: data.workspace.id,
                ...formKey(form),
                name: String(form.get('name')),
                role: String(form.get('role'))
              });
              setCredential(result);
              setCopied('');
            }}
          >
            <Field label={t('Agent name')}>
              <input name="name" required maxLength={120} />
            </Field>
            <Field label={t('Role')}>
              <select name="role">
                <option value="worker">{t('Worker')}</option>
                <option value="qa">{t('Independent QA')}</option>
                <option value="lead">{t('Product lead')}</option>
                <option value="pm">{t('PM')}</option>
              </select>
            </Field>
            <button type="submit">{t('Enroll agent')}</button>
          </AsyncForm>
        </details>
        {credential ? (
          <div className="credential">
            <h3>{credential.actor.name}</h3>
            {credential.token ? (
              <>
                <p>{t('Shown once. Keep this scoped credential private.')}</p>
                <input
                  aria-label={t('New agent credential')}
                  type="password"
                  readOnly
                  value={credential.token}
                />
                <button onClick={() => void copy()}>{t('Copy credential')}</button>
                <button onClick={() => setCredential(null)}>{t('Hide credential')}</button>
                <p role="status">{t(copied)}</p>
              </>
            ) : (
              <p>
                {t(
                  'Replayed enrollment does not return the credential. Enroll a new identity if the original response was lost.'
                )}
              </p>
            )}
          </div>
        ) : null}
      </section>
      <section>
        <h2>{t('Approved test commands')}</h2>
        <p className="muted">
          {t(
            'An independent QA agent selects approved profiles. Commands and arguments are fixed; tests and generated reports belong under .qa.'
          )}
        </p>
        {data.profiles.map((profile) => (
          <details key={profile.id}>
            <summary>
              {profile.name} · {profile.criteria.join(', ')}
            </summary>
            <JsonView value={profile} />
          </details>
        ))}
        <details>
          <summary>{t('Approve a check profile')}</summary>
          <AsyncForm
            className="settings-form"
            onDone={onSaved}
            onSave={(form) =>
              mutation('check_profile_create', {
                workspaceId: data.workspace.id,
                ...formKey(form),
                name: String(form.get('name')),
                command: String(form.get('command')),
                args: lines(form.get('args')),
                criteria: lines(form.get('criteria')),
                timeoutMs: Number(form.get('timeout'))
              })
            }
          >
            <Field label={t('Profile name')}>
              <input name="name" required />
            </Field>
            <Field
              label={t('Native executable')}
              hint={t('Absolute executable path; shell shims are not accepted.')}
            >
              <input name="command" required placeholder="C:\Program Files\nodejs\node.exe" />
            </Field>
            <Field label={t('Arguments')} hint={t('One argument per line, for example .qa/check.mjs.')}>
              <textarea name="args" rows={3} defaultValue=".qa/check.mjs" />
            </Field>
            <Field label={t('Covered criterion IDs')}>
              <textarea name="criteria" required rows={3} />
            </Field>
            <Field label={t('Timeout in milliseconds')}>
              <input name="timeout" type="number" min={100} max={300000} defaultValue={30000} required />
            </Field>
            <button type="submit">{t('Approve profile')}</button>
          </AsyncForm>
        </details>
      </section>
      {data.workspace.commonDir ? (
        <section>
          <h2>{t('GitHub repository binding')}</h2>
          <p className="muted">
            {t(
              'Read the chosen remote from the registered project. A changed approved scope must be reset before rebinding.'
            )}
          </p>
          <AsyncForm
            className="settings-form"
            onDone={onSaved}
            onSave={(form) =>
              mutation('workspace_git_bind', {
                workspaceId: data.workspace.id,
                ...formKey(form),
                expectedBindingId: data.workspace.gitBindingId ?? null,
                remote: String(form.get('remote'))
              })
            }
          >
            <Field label={t('Local Git remote')}>
              <input name="remote" required defaultValue="origin" />
            </Field>
            <button type="submit">{t('Bind GitHub remote')}</button>
          </AsyncForm>
        </section>
      ) : null}
      <section>
        <h2>{t('Harness connections')}</h2>
        <p className="muted">
          {t(
            'Last reported MCP initialization. This does not prove that a connection is currently live or authenticated for inference.'
          )}
        </p>
        {data.connections.length ? (
          <ul className="simple-list">
            {data.connections.map((connection) => (
              <li key={connection.id}>
                <span>
                  {connection.client.name} · {connection.client.version}
                  <small>{dateText(connection.initializedAt)}</small>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            {t(
              'No harness connection reported yet. Use the CLI connection command with an enrolled agent credential.'
            )}
          </p>
        )}
      </section>
    </div>
  );
}
export function Runs({
  workspaceId,
  runId,
  online,
  onSelect
}: {
  workspaceId: string;
  runId?: string | null;
  online: boolean;
  onSelect(id: string): void;
}) {
  const dateText = useDateText();
  const t = useText();
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ runs: Run[]; total: number; nextOffset: number | null } | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Run | null>(null);
  const [targetedRun, setTargetedRun] = useState<Run | null>(null);
  const [targetError, setTargetError] = useState('');
  const [action, setAction] = useState<'interrupt' | 'reconcile' | null>(null);
  useEffect(() => {
    setTargetedRun(null);
    setTargetError('');
    setSelected(null);
    setAction(null);
    if (!runId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await command<{ run: Run }>('run_get', { workspaceId, runId });
        if (active) { setTargetedRun(result.run); setTargetError(''); }
      } catch (failure) { if (active) setTargetError(errorText(failure)); }
      finally { if (active) timer = setTimeout(load, 1000); }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [workspaceId, runId]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await command<typeof data>('ui_runs', { workspaceId, offset });
        if (!cancelled) {
          setData(result);
          setError('');
        }
      } catch (failure) {
        if (!cancelled) setError(errorText(failure));
      } finally {
        if (!cancelled) timer = setTimeout(load, 1000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workspaceId, offset]);
  const selection = selected ?? targetedRun;
  const current = data?.runs.find((run) => run.id === selection?.id) ?? (targetedRun?.id === selection?.id ? targetedRun : selection);
  return (
    <div className="runs">
      {targetError || error ? (
        <p className="error" role="alert">
          {t(targetError || error)}
        </p>
      ) : null}
      {data?.runs.length ? (
        <table>
          <thead>
            <tr>
              <th>{t('Assignment')}</th>
              <th>{t('Harness')}</th>
              <th>{t('Run state')}</th>
              <th>{t('Started')}</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <button className="text-button" onClick={() => setSelected(run)}>
                    {run.kind === 'qa' ? t('QA') : t('Worker')} · {run.id.slice(0, 8)}
                  </button>
                </td>
                <td>{harnessName(run.harness)}</td>
                <td>
                  <Status value={run.state} />
                </td>
                <td>{dateText(run.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title={t('No managed runs')}>
          <p>{t('Assign a ready issue, then dispatch it from the issue details.')}</p>
        </Empty>
      )}
      <div className="pagination">
        <span>
          {data?.total ?? 0}
          {t(' runs')}
        </span>
        <button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>
          {t('Previous')}
        </button>
        <button disabled={data?.nextOffset == null} onClick={() => setOffset(data!.nextOffset!)}>
          {t('Next')}
        </button>
      </div>
      {current ? (
        <section className="run-details">
          <h2>
            {t('Run ')}
            {current.id.slice(0, 8)}
          </h2>
          <p>
            <Status value={current.state} />
          </p>
          <button onClick={() => onSelect(current.issueId)}>{t('Open assigned issue')}</button>
          <dl className="metadata">
            <dt>{t('Provider session')}</dt>
            <dd className="mono">{current.providerSessionId ?? t('Not recorded')}</dd>
            <dt>{t('Execution directory')}</dt>
            <dd className="mono">{current.executionRoot ?? t('Not prepared')}</dd>
            <dt>{t('Recorded PID')}</dt>
            <dd>{current.pid ?? t('Not recorded')}</dd>
            <dt>{t('Error')}</dt>
            <dd>{current.errorCode ?? t('None recorded')}</dd>
            <dt>{t('Run budget')}</dt>
            <dd>{current.budgetMs ? `${current.budgetMs / 1000} ${t('seconds')}` : t('Applied when reserved')}</dd>
          </dl>
          {current.summary ? <pre className="json">{current.summary}</pre> : null}
          {['QUEUED', 'STARTING', 'RUNNING', 'STOPPING'].includes(current.state) ? (
            <button
              disabled={!online}
              onClick={() => {
                setSelected(current);
                setAction('interrupt');
              }}
            >
              {t('Request stop')}
            </button>
          ) : null}
          {current.state === 'UNCERTAIN' ? (
            <button
              disabled={!online}
              onClick={() => {
                setSelected(current);
                setAction('reconcile');
              }}
            >
              {t('Reconcile stopped execution')}
            </button>
          ) : null}
        </section>
      ) : null}
      {action && selected ? (
        <Modal
          title={action === 'interrupt' ? t('Stop managed execution') : t('Reconcile uncertain execution')}
          subtitle={selected.id}
          onClose={() => setAction(null)}
        >
          <AsyncForm
            onDone={() => setAction(null)}
            onSave={(form) =>
              mutation(action === 'interrupt' ? 'run_interrupt' : 'run_reconcile', {
                workspaceId,
                runId: selected.id,
                expectedVersion: selected.version,
                ...formKey(form),
                reason: String(form.get('reason')),
                ...(action === 'reconcile' ? { confirmStopped: true } : {})
              })
            }
          >
            <div className="form-body">
              {action === 'reconcile' ? (
                <>
                  <p>
                    {t(
                      'Inspect and stop the recorded process and related external execution before confirming. A still-existing provider or test PID blocks reconciliation.'
                    )}
                  </p>
                  <p>
                    {t('Recorded PID: ')}
                    {selected.pid ?? t('unavailable')}
                  </p>
                  <label className="check-row">
                    <input type="checkbox" required />
                    <span>
                      {t('I have confirmed that this execution and related processes have stopped.')}
                    </span>
                  </label>
                </>
              ) : (
                <p>
                  {t(
                    'The service requests interruption. STOPPING or UNCERTAIN does not mean the process has stopped.'
                  )}
                </p>
              )}
              <Field label={t('Reason')}>
                <textarea name="reason" required rows={4} />
              </Field>
            </div>
            <footer className="form-footer">
              <button type="button" onClick={() => setAction(null)}>
                {t('Cancel')}
              </button>
              <button type="submit" className="primary">
                {action === 'interrupt' ? t('Request stop') : t('Confirm stopped')}
              </button>
            </footer>
          </AsyncForm>
        </Modal>
      ) : null}
    </div>
  );
}
