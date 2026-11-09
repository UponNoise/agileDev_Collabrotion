import { useText } from './Preferences';
import { useDeferredValue, useEffect, useState } from 'react';
import type { Actor, Workspace } from '../src/contracts';
import { ApiError, command, errorText, request, setCsrf } from './api';
import type { IssueData, View, WorkspaceData } from './api';
import { AsyncForm, Empty, Field, Icon, OnlineContext } from './components';
import { IssueForm } from './IssueForms';
import type { IssueDialog } from './IssueForms';
import { IssuePanel } from './IssuePanel';
import { Backlog, Runs, Settings, WorkspaceRegistration } from './WorkspaceViews';

const labels: Record<View, string> = {
  backlog: 'Backlog',
  board: 'Board',
  reviews: 'Reviews',
  runs: 'Runs',
  settings: 'Settings'
};
function route() {
  const match = location.pathname.match(/^\/w\/([^/]+)\/issues\/([^/]+)$/);
  const query = new URLSearchParams(location.search);
  const view = query.get('view') as View;
  return {
    workspaceId: match?.[1] ?? query.get('workspace'),
    issueId: match?.[2] ?? null,
    view: view in labels ? view : ('backlog' as View)
  };
}
function Login({ connected }: { connected(actor: Actor, csrf: string): void }) {
  const t = useText();
  return (
    <main className="login">
      <div className="login-content">
        <div className="brand">
          <span />
          AgileDev
        </div>
        <h1>{t('Connect to your workspace')}</h1>
        <p>
          {t('Run ')}
          <code>node dist/cli.js ui</code>
          {t(' in your local installation, then enter the one-use code.')}
        </p>
        <AsyncForm
          onSave={async (form) => {
            const result = await request<{ actor: Actor; csrf: string }>('/api/ui/login', {
              code: String(form.get('code'))
            });
            connected(result.actor, result.csrf);
          }}
        >
          <Field label={t('Pairing code')}>
            <input
              name="code"
              type="password"
              required
              autoComplete="one-time-code"
              maxLength={100}
              spellCheck={false}
            />
          </Field>
          <button type="submit" className="primary">
            {t('Connect workspace')}
          </button>
        </AsyncForm>
        <p className="muted">
          {t('The code expires after five minutes. Keep it private and out of the URL.')}
        </p>
      </div>
    </main>
  );
}
export function App() {
  const t = useText();
  const [actor, setActor] = useState<Actor | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [fatal, setFatal] = useState('');
  const [locationState, setLocation] = useState(route);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [packet, setPacket] = useState<IssueData | null>(null);
  const [detailError, setDetailError] = useState('');
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);
  const [state, setState] = useState('');
  const [offset, setOffset] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncError, setSyncError] = useState('');
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<IssueDialog | null>(null);
  const workspaceId = locationState.workspaceId ?? workspaces[0]?.id ?? null;
  const view = locationState.view;
  function navigate(workspace: string | null, issue: string | null, nextView: View = view) {
    const url =
      issue && workspace
        ? `/w/${workspace}/issues/${issue}?view=${nextView}`
        : `/?${new URLSearchParams({ ...(workspace ? { workspace } : {}), view: nextView })}`;
    history.pushState(null, '', url);
    setLocation(route());
    setMenu(false);
  }
  function connected(next: Actor, csrf: string) {
    setCsrf(csrf);
    setActor(next);
    setFatal('');
    setOnline(true);
  }
  const saved = () => setRefresh((previous) => previous + 1);
  const expired = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setCsrf(null);
      setActor(null);
      return true;
    }
    return false;
  };
  useEffect(() => {
    const pop = () => setLocation(route());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    let active = true;
    request<{ authenticated: boolean; actor?: Actor; csrf?: string }>('/api/ui/status')
      .then((result) => {
        if (active && result.authenticated) connected(result.actor!, result.csrf!);
      })
      .catch((error) => {
        if (active) setFatal(errorText(error));
      })
      .finally(() => {
        if (active) setInitializing(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!actor) return;
    let active = true;
    command<{ workspaces: Workspace[] }>('workspace_list', {})
      .then((result) => {
        if (active) {
          setWorkspaces(result.workspaces);
          setFatal('');
        }
      })
      .catch((error) => {
        if (active && !expired(error)) setFatal(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [actor, refresh]);
  useEffect(() => {
    if (!actor || !workspaceId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let cursor: number | undefined;
    const load = async () => {
      try {
        const result = await command<WorkspaceData & { unchanged?: boolean }>('ui_workspace', {
          workspaceId,
          search: query,
          ...(state ? { state } : {}),
          view: view === 'reviews' ? 'reviews' : 'backlog',
          offset,
          afterCursor: cursor
        });
        if (!active) return;
        if (!result.unchanged) setData(result);
        cursor = result.cursor;
        setOnline(true);
        setSyncError('');
      } catch (error) {
        if (active && !expired(error)) {
          setOnline(false);
          setSyncError(errorText(error));
        }
      } finally {
        if (active) timer = setTimeout(load, 1000);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [actor, workspaceId, query, state, view, offset, refresh]);
  useEffect(() => {
    if (!actor || !workspaceId || !locationState.issueId) {
      setPacket(null);
      return;
    }
    let active = true;
    setDetailError('');
    command<IssueData>('ui_issue', { workspaceId, issueId: locationState.issueId })
      .then((result) => {
        if (active) setPacket(result);
      })
      .catch((error) => {
        if (active && !expired(error)) setDetailError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [actor, workspaceId, locationState.issueId, data?.cursor, refresh]);
  async function logout() {
    try {
      await request('/api/ui/logout', {});
      setCsrf(null);
      setActor(null);
      setDialog(null);
    } catch (error) {
      setFatal(errorText(error));
    }
  }
  function registered(workspace: Workspace) {
    saved();
    navigate(workspace.id, null, 'backlog');
    setSearch('');
    setState('');
    setOffset(0);
  }
  function openDialog(next: Omit<IssueDialog, 'id'>) {
    setDialog({ ...next, id: crypto.randomUUID() });
  }
  const current = data?.workspace.id === workspaceId ? data : null;
  const selected =
    packet?.issue.id === locationState.issueId && packet?.issue.workspaceId === workspaceId ? packet : null;
  const split = ['backlog', 'board', 'reviews'].includes(view);
  if (initializing)
    return (
      <main className="login">
        <p role="status">{t('Connecting to the local workspace…')}</p>
      </main>
    );
  if (!actor)
    return (
      <>
        {fatal ? (
          <p className="connection-banner" role="alert">
            {t(fatal)}
          </p>
        ) : null}
        <Login connected={connected} />
      </>
    );
  return (
    <OnlineContext.Provider value={online}>
      <div className={`app ${locationState.issueId && split ? 'has-selection' : ''}`}>
        <a className="skip-link" href="#main">
          {t('Skip to workspace')}
        </a>
        <header className="mobile-header">
          <button
            className="icon-button"
            aria-label={t('Toggle navigation')}
            aria-expanded={menu}
            onClick={() => setMenu((previous) => !previous)}
          >
            <Icon name="menu" />
          </button>
          <span>AgileDev</span>
        </header>
        <aside className={`sidebar ${menu ? 'menu-open' : ''}`}>
          <div className="brand">
            <span />
            AgileDev
          </div>
          <label className="workspace-picker">
            <span className="sr-only">{t('Workspace')}</span>
            <select
              value={workspaceId ?? ''}
              onChange={(event) => {
                navigate(event.target.value, null, 'backlog');
                setSearch('');
                setState('');
                setOffset(0);
              }}
            >
              <option value="" disabled>
                {t('Select workspace')}
              </option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <nav aria-label={t('Workspace navigation')}>
            {(Object.keys(labels) as View[]).map((name) => (
              <button
                key={name}
                aria-current={view === name ? 'page' : undefined}
                onClick={() => {
                  navigate(workspaceId, null, name);
                  setSearch('');
                  setState('');
                  setOffset(0);
                }}
              >
                <Icon name={name} />
                {t(labels[name])}
              </button>
            ))}
          </nav>
          <footer>
            <p>{t('Local workspace')}</p>
            <button className="text-button" onClick={() => void logout()}>
              {t('Sign out')}
            </button>
          </footer>
        </aside>
        <div className="workspace-shell">
          {!online ? (
            <div className="connection-banner" role="alert">
              {t('Disconnected. Changes are paused; reconnecting…')}
              <small>{t(syncError)}</small>
            </div>
          ) : null}
          {fatal ? (
            <p className="error" role="alert">
              {t(fatal)}
            </p>
          ) : null}
          {!workspaceId ? (
            <main id="main" className="first-workspace">
              <h1>{t('Create your first workspace')}</h1>
              <p>{t('Register a project directory to start planning requirements.')}</p>
              <WorkspaceRegistration onRegistered={registered} />
            </main>
          ) : current ? (
            <div className={`workspace-layout ${split && locationState.issueId ? 'with-inspector' : ''}`}>
              <main id="main" className="workspace-main">
                <header className="workspace-heading">
                  <div>
                    <h1>
                      {view === 'backlog'
                        ? t('Workspace backlog')
                        : view === 'board'
                          ? t('Workspace board')
                          : view === 'reviews'
                            ? t('Review queue')
                            : view === 'runs'
                              ? t('Managed runs')
                              : t('Workspace settings')}
                    </h1>
                    <p>
                      {view === 'reviews'
                        ? t('Design, lead, QA, and delivery decisions stay separate.')
                        : view === 'runs'
                          ? t('Queued, running, and uncertain are distinct execution states.')
                          : view === 'settings'
                            ? t('Manage local bindings, scoped identities, and approved checks.')
                            : t('Plan work. Review evidence. Keep every handoff visible.')}
                    </p>
                  </div>
                  {split ? (
                    <button
                      className="primary"
                      disabled={!online}
                      onClick={() => openDialog({ kind: 'create' })}
                    >
                      {t('New issue')}
                    </button>
                  ) : null}
                </header>
                {split ? (
                  <>
                    <div className="workspace-tools">
                      <label className="search">
                        <Icon name="search" />
                        <span className="sr-only">{t('Search title or key')}</span>
                        <input
                          placeholder={t('Search title or key')}
                          value={search}
                          onChange={(event) => {
                            setSearch(event.target.value);
                            setOffset(0);
                          }}
                        />
                      </label>
                      <label>
                        <span className="sr-only">{t('Issue state')}</span>
                        <select
                          aria-label={t('Issue state')}
                          value={state}
                          onChange={(event) => {
                            setState(event.target.value);
                            setOffset(0);
                          }}
                        >
                          <option value="">{t('All states')}</option>
                          {[
                            'NOT_STARTED',
                            'IN_PROGRESS',
                            'LEAD_REVIEW',
                            'QA_TEST',
                            'USER_ACCEPTANCE',
                            'LEAD_REJECTED',
                            'QA_REJECTED',
                            'USER_REJECTED',
                            'ON_HOLD',
                            'ABANDONED',
                            'DONE'
                          ].map((value) => (
                            <option value={value} key={value}>
                              {t(value.replaceAll('_', ' ').toLowerCase())}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <Backlog
                      data={current}
                      selected={locationState.issueId}
                      onSelect={(id) => navigate(workspaceId, id)}
                      board={view === 'board'}
                    />
                    <footer className="pagination">
                      <span>
                        {current.total} {current.total === 1 ? t('issue') : t('issues')}
                        {current.total > 20 ? ` · ${t('page {page}').replace('{page}', String(offset / 20 + 1))}` : ''}
                      </span>
                      <button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>
                        {t('Previous')}
                      </button>
                      <button
                        disabled={current.nextOffset === null}
                        onClick={() => setOffset(current.nextOffset!)}
                      >
                        {t('Next')}
                      </button>
                    </footer>
                  </>
                ) : null}
                {view === 'settings' ? (
                  <Settings data={current} onSaved={saved} onRegistered={registered} />
                ) : null}
                {view === 'runs' ? (
                  <Runs
                    key={workspaceId}
                    workspaceId={workspaceId}
                    online={online}
                    onSelect={(id) => navigate(workspaceId, id, 'backlog')}
                  />
                ) : null}
              </main>
              {split && locationState.issueId ? (
                selected ? (
                  <IssuePanel
                    key={selected.issue.id}
                    packet={selected}
                    workspace={current}
                    online={online}
                    onDialog={openDialog}
                    onRefresh={saved}
                    onBack={() => navigate(workspaceId, null)}
                  />
                ) : (
                  <aside className="inspector loading">
                    <p role={detailError ? 'alert' : 'status'}>
                      {detailError || t('Loading issue details…')}
                    </p>
                    <button onClick={() => navigate(workspaceId, null)}>{t('Back to workspace')}</button>
                  </aside>
                )
              ) : null}
            </div>
          ) : (
            <main id="main" className="workspace-main">
              <Empty title={syncError ? t('Workspace unavailable') : t('Loading workspace')}>
                <p>{syncError || t('Reading committed local records…')}</p>
              </Empty>
            </main>
          )}
        </div>
        {dialog && current ? (
          <IssueForm
            key={dialog.id}
            dialog={dialog}
            workspace={current}
            onSaved={saved}
            onClose={() => setDialog((previous) => (previous?.id === dialog.id ? null : previous))}
          />
        ) : null}
      </div>
    </OnlineContext.Provider>
  );
}
