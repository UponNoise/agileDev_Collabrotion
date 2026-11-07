import { useEffect, useState } from 'react';
import type { Actor, Run, Workspace } from '../src/contracts';
import { command, dateText, errorText, formKey, harnessName, lines, mutation, stateLabel } from './api';
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
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const name = (id?: string | null) => data.actors.find((actor) => actor.id === id)?.name ?? 'Unassigned';
  const issueTitle = (issue: DisplayIssue) => issue.titleSuffix;
  if (!data.issues.length)
    return (
      <Empty title="No matching issues">
        <p>Create a requirement or adjust the filters.</p>
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
      { name: 'Needs attention', states: ['LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED', 'ON_HOLD', 'ABANDONED'] }
    ];
    return (
      <div className="board">
        {columns.map((column) => {
          const items = data.issues.filter((issue) => column.states.includes(issue.state));
          return (
            <section className="board-lane" key={column.name}>
              <h2>
                {column.name}
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
            <th>Issue</th>
            <th>Status</th>
            <th>Owner</th>
            <th>Harness</th>
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
                          aria-label={`${collapsed.has(issue.id) ? 'Expand' : 'Collapse'} ${issue.key}`}
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
                    {issue.scope?.status === 'EXCLUDED' ? <small className="scope-label">Excluded from delivery</small> : issue.scope?.status === 'STALE' ? <small className="scope-label">Scope decision stale</small> : null}
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
      <Field label="Workspace name">
        <input name="name" required maxLength={120} />
      </Field>
      <Field label="Project directory" hint="Use an existing absolute directory. Its contents stay local.">
        <input name="root" required placeholder="C:\Projects\my-project" />
      </Field>
      <Field label="Issue prefix">
        <input name="prefix" required pattern="[A-Z][A-Z0-9]{1,9}" maxLength={10} placeholder="APP" />
      </Field>
      <button className="primary" type="submit">
        Register workspace
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
      <section>
        <h2>Workspace</h2>
        <dl className="metadata">
          <dt>Directory</dt>
          <dd className="mono">{data.workspace.root}</dd>
          <dt>Workspace ID</dt>
          <dd className="mono">{data.workspace.id}</dd>
          <dt>Git binding</dt>
          <dd className="mono">{data.workspace.gitBindingId ?? 'Not bound'}</dd>
        </dl>
        <details>
          <summary>Register another workspace</summary>
          <WorkspaceRegistration onRegistered={onRegistered} />
        </details>
      </section>
      <section>
        <h2>Agents</h2>
        <p className="muted">Roles are workflow identities. Enrolling an agent does not start a model run.</p>
        <ul className="simple-list">
          {data.actors.map((actor) => (
            <li key={actor.id}>
              <span>{actor.name}</span>
              <small>{actor.role}</small>
            </li>
          ))}
        </ul>
        <details>
          <summary>Enroll an agent</summary>
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
            <Field label="Agent name">
              <input name="name" required maxLength={120} />
            </Field>
            <Field label="Role">
              <select name="role">
                <option value="worker">Worker</option>
                <option value="qa">Independent QA</option>
                <option value="lead">Product lead</option>
                <option value="pm">PM</option>
              </select>
            </Field>
            <button type="submit">Enroll agent</button>
          </AsyncForm>
        </details>
        {credential ? (
          <div className="credential">
            <h3>{credential.actor.name}</h3>
            {credential.token ? (
              <>
                <p>Shown once. Keep this scoped credential private.</p>
                <input aria-label="New agent credential" type="password" readOnly value={credential.token} />
                <button onClick={() => void copy()}>Copy credential</button>
                <button onClick={() => setCredential(null)}>Hide credential</button>
                <p role="status">{copied}</p>
              </>
            ) : (
              <p>
                Replayed enrollment does not return the credential. Enroll a new identity if the original response was
                lost.
              </p>
            )}
          </div>
        ) : null}
      </section>
      <section>
        <h2>Approved test commands</h2>
        <p className="muted">
          An independent QA agent selects approved profiles. Commands and arguments are fixed; tests and generated
          reports belong under .qa.
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
          <summary>Approve a check profile</summary>
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
            <Field label="Profile name">
              <input name="name" required />
            </Field>
            <Field label="Native executable" hint="Absolute executable path; shell shims are not accepted.">
              <input name="command" required placeholder="C:\Program Files\nodejs\node.exe" />
            </Field>
            <Field label="Arguments" hint="One argument per line, for example .qa/check.mjs.">
              <textarea name="args" rows={3} defaultValue=".qa/check.mjs" />
            </Field>
            <Field label="Covered criterion IDs">
              <textarea name="criteria" required rows={3} />
            </Field>
            <Field label="Timeout in milliseconds">
              <input name="timeout" type="number" min={100} max={300000} defaultValue={30000} required />
            </Field>
            <button type="submit">Approve profile</button>
          </AsyncForm>
        </details>
      </section>
      {data.workspace.commonDir ? (
        <section>
          <h2>GitHub repository binding</h2>
          <p className="muted">
            Read the chosen remote from the registered project. A changed approved scope must be reset before rebinding.
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
            <Field label="Local Git remote">
              <input name="remote" required defaultValue="origin" />
            </Field>
            <button type="submit">Bind GitHub remote</button>
          </AsyncForm>
        </section>
      ) : null}
      <section>
        <h2>Harness connections</h2>
        <p className="muted">
          Last reported MCP initialization. This does not prove that a connection is currently live or authenticated for
          inference.
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
            No harness connection reported yet. Use the CLI connection command with an enrolled agent credential.
          </p>
        )}
      </section>
    </div>
  );
}
export function Runs({
  workspaceId,
  online,
  onSelect
}: {
  workspaceId: string;
  online: boolean;
  onSelect(id: string): void;
}) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ runs: Run[]; total: number; nextOffset: number | null } | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Run | null>(null);
  const [action, setAction] = useState<'interrupt' | 'reconcile' | null>(null);
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
  const current = data?.runs.find((run) => run.id === selected?.id) ?? selected;
  return (
    <div className="runs">
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {data?.runs.length ? (
        <table>
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Harness</th>
              <th>Run state</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <button className="text-button" onClick={() => setSelected(run)}>
                    {run.kind === 'qa' ? 'QA' : 'Worker'} · {run.id.slice(0, 8)}
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
        <Empty title="No managed runs">
          <p>Assign a ready issue, then dispatch it from the issue details.</p>
        </Empty>
      )}
      <div className="pagination">
        <span>{data?.total ?? 0} runs</span>
        <button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>
          Previous
        </button>
        <button disabled={data?.nextOffset == null} onClick={() => setOffset(data!.nextOffset!)}>
          Next
        </button>
      </div>
      {current ? (
        <section className="run-details">
          <h2>Run {current.id.slice(0, 8)}</h2>
          <p>
            <Status value={current.state} />
          </p>
          <button onClick={() => onSelect(current.issueId)}>Open assigned issue</button>
          <dl className="metadata">
            <dt>Provider session</dt>
            <dd className="mono">{current.providerSessionId ?? 'Not recorded'}</dd>
            <dt>Execution directory</dt>
            <dd className="mono">{current.executionRoot ?? 'Not prepared'}</dd>
            <dt>Recorded PID</dt>
            <dd>{current.pid ?? 'Not recorded'}</dd>
            <dt>Error</dt>
            <dd>{current.errorCode ?? 'None recorded'}</dd>
            <dt>Run budget</dt>
            <dd>{current.budgetMs ? `${current.budgetMs / 1000} seconds` : 'Applied when reserved'}</dd>
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
              Request stop
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
              Reconcile stopped execution
            </button>
          ) : null}
        </section>
      ) : null}
      {action && selected ? (
        <Modal
          title={action === 'interrupt' ? 'Stop managed execution' : 'Reconcile uncertain execution'}
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
                    Inspect and stop the recorded process and related external execution before confirming. A
                    still-existing provider or test PID blocks reconciliation.
                  </p>
                  <p>Recorded PID: {selected.pid ?? 'unavailable'}</p>
                  <label className="check-row">
                    <input type="checkbox" required />
                    <span>I have confirmed that this execution and related processes have stopped.</span>
                  </label>
                </>
              ) : (
                <p>The service requests interruption. STOPPING or UNCERTAIN does not mean the process has stopped.</p>
              )}
              <Field label="Reason">
                <textarea name="reason" required rows={4} />
              </Field>
            </div>
            <footer className="form-footer">
              <button type="button" onClick={() => setAction(null)}>
                Cancel
              </button>
              <button type="submit" className="primary">
                {action === 'interrupt' ? 'Request stop' : 'Confirm stopped'}
              </button>
            </footer>
          </AsyncForm>
        </Modal>
      ) : null}
    </div>
  );
}
