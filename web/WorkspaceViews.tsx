import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Actor, GitBinding, Run, Workspace } from '../src/contracts';
import { ApiError, command, errorText, formKey, harnessName, lines, mutation } from './api';
import type { DisplayIssue, InboxEntry, WakeSettingsData, WorkspaceData } from './api';
import { AuditDetails, useCodeText, useSentence } from './CardKit';
import { AsyncForm, Empty, Field, Modal } from './components';
import { openDecisionCard } from './Decisions';
import { DesktopAttentionSettings, useDesktopAttention } from './DesktopAttention';
import { Avatar, ProgressRing, StatusIcon, UiIcon } from './Icons';
import { useDateText, usePreferences, useRoleWords, useText } from './Preferences';
import type { Theme } from './Preferences';
import type { SettingsSection, WorkMode } from './routes';
import { runResultSentence } from './sentences';
import {
  activeRunForIssue,
  actorInitials,
  boardColumns,
  formatElapsed,
  inferAgentHarness,
  isNeedsYou,
  issueIconKind,
  issueStatusForWorkspace,
  matchesFilter,
  requirementProgress
} from './work-model';
import type { WorkData } from './work-model';

function useTick(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function whoActs(issue: DisplayIssue, actors: readonly Actor[], youLabel: string): { name: string | null; isYou: boolean } {
  if (issue.state === 'USER_ACCEPTANCE') return { name: youLabel, isYou: true };
  if (issue.state === 'QA_TEST') {
    return { name: actors.find((actor) => actor.id === issue.qaAssignee)?.name ?? null, isYou: false };
  }
  if (issue.state === 'LEAD_REVIEW') {
    const leads = actors.filter((actor) => actor.role === 'lead');
    return { name: leads.length === 1 ? leads[0]!.name : null, isYou: false };
  }
  return { name: actors.find((actor) => actor.id === issue.assignee)?.name ?? null, isYou: false };
}

function LiveChip({ startedAt, now }: { startedAt: string; now: number }) {
  const elapsed = Math.max(0, now - Date.parse(startedAt));
  return (
    <span className="chip">
      <span className="live" aria-hidden="true" />
      <span className="mono">{formatElapsed(elapsed)}</span>
    </span>
  );
}

export function TaskRow({
  issue,
  workspace,
  entries,
  now,
  onSelect
}: {
  issue: DisplayIssue;
  workspace: WorkData;
  entries: readonly InboxEntry[];
  now: number;
  onSelect(issueId: string): void;
}) {
  const { locale, t } = usePreferences();
  const youChip = locale === 'zh-CN' ? '等你' : 'You';
  const render = useSentence();
  const roleWords = useRoleWords();
  const run = activeRunForIssue(workspace.activeRuns, issue.id);
  const needsYou = entries.some((entry) => entry.issueId === issue.id && isNeedsYou(entry));
  const icon = issueIconKind(issue, run);
  const statusText = render(issueStatusForWorkspace(issue, workspace, entries, roleWords));
  const actor = whoActs(issue, workspace.actors, t('You'));
  const live = run && ['STARTING', 'RUNNING', 'STOPPING'].includes(run.state);
  return (
    <a
      className="row"
      href={`/w/${encodeURIComponent(issue.workspaceId)}/issues/${encodeURIComponent(issue.id)}`}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onSelect(issue.id);
      }}
    >
      <StatusIcon kind={icon.kind} progress={icon.progress} />
      <span className="key mono">{issue.key}</span>
      <span className="grow cut">{issue.titleSuffix}</span>
      {needsYou ? <span className="chip you">{youChip}</span> : null}
      {live ? <LiveChip startedAt={run.startedAt ?? run.createdAt} now={now} /> : null}
      <span className="st">{statusText}</span>
      <Avatar name={actor.name} initials={actor.isYou ? t('You').slice(0, 1) : actor.name ? actorInitials(actor.name) : undefined} isYou={actor.isYou} />
    </a>
  );
}

export function WorkView({
  data,
  entries,
  mode,
  filter,
  online,
  onFilter,
  onMode,
  onSelect,
  onNew,
  onMenu
}: {
  data: WorkData;
  entries: readonly InboxEntry[];
  mode: WorkMode;
  filter: string;
  online: boolean;
  onFilter(value: string): void;
  onMode(mode: WorkMode): void;
  onSelect(issueId: string): void;
  onNew(): void;
  onMenu(): void;
}) {
  const { locale, t } = usePreferences();
  const youChip = locale === 'zh-CN' ? '等你' : 'You';
  const render = useSentence();
  const roleWords = useRoleWords();
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const hasLiveRuns = data.activeRuns.some((run) => ['STARTING', 'RUNNING', 'STOPPING'].includes(run.state));
  const now = useTick(hasLiveRuns);
  const byId = useMemo(() => new Map(data.issues.map((issue) => [issue.id, issue])), [data.issues]);
  const roots = useMemo(() => {
    const top = data.issues.filter((issue) => !issue.parentId);
    return [...top.filter((issue) => issue.state !== 'DONE'), ...top.filter((issue) => issue.state === 'DONE')];
  }, [data.issues]);

  const toggleGroup = (id: string) => {
    setToggled((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const board = mode === 'board';
  const boardData = useMemo(() => (board ? boardColumns(data.issues, filter) : null), [board, data.issues, filter]);

  return (
    <>
      <header className="bar">
        <button type="button" className="icon-btn menu-btn" aria-label={t('Open navigation')} onClick={onMenu}>
          <UiIcon name="menu" />
        </button>
        <h1>{t('Work')}</h1>
        <span className="grow" />
        <label className="search">
          <UiIcon name="search" size={14} />
          <span className="sr-only">{t('Filter')}</span>
          <input
            value={filter}
            placeholder={t('Filter')}
            aria-label={t('Filter')}
            onChange={(event) => onFilter(event.target.value)}
          />
        </label>
        <span className="seg" role="group" aria-label={t('View')}>
          <button type="button" aria-pressed={!board} onClick={() => onMode('list')}>
            <UiIcon name="list" size={14} />
            {t('List')}
          </button>
          <button type="button" aria-pressed={board} onClick={() => onMode('board')}>
            <UiIcon name="board" size={14} />
            {t('Board')}
          </button>
        </span>
        <button type="button" className="btn primary" disabled={!online} onClick={onNew}>
          <UiIcon name="plus" size={14} />
          {t('New requirement')}
        </button>
      </header>
      <div className="scroll">
        {board && boardData ? (
          <div className="board-wrap">
            <div className="board">
              {boardData.columns.map((column) => (
                <section className="col" key={column.id}>
                  <h2 className="col-h">
                    <StatusIcon kind={column.icon} progress={column.progress} />
                    <span>{column.id === 'done' ? render({ key: 'Done', values: {} }) : t(column.labelKey)}</span>
                    <span className="col-count">{column.items.length}</span>
                  </h2>
                  {column.items.map((issue) => {
                    const parent = issue.parentId ? byId.get(issue.parentId) : null;
                    const run = activeRunForIssue(data.activeRuns, issue.id);
                    const live = run && ['STARTING', 'RUNNING', 'STOPPING'].includes(run.state);
                    const needsYou = entries.some((entry) => entry.issueId === issue.id && isNeedsYou(entry));
                    const isRework = ['LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED'].includes(issue.state);
                    const actor = whoActs(issue, data.actors, t('You'));
                    return (
                      <a
                        key={issue.id}
                        className="bcard"
                        href={`/w/${encodeURIComponent(issue.workspaceId)}/issues/${encodeURIComponent(issue.id)}`}
                        onClick={(event) => {
                          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                          event.preventDefault();
                          onSelect(issue.id);
                        }}
                      >
                        <span className="ct">{issue.titleSuffix}</span>
                        {parent ? <span className="par cut">{parent.titleSuffix}</span> : null}
                        <span className="cf">
                          {issue.state === 'LEAD_REVIEW' ? (
                            <span className="chip">{issue.stage === 'FINAL' ? t('Final') : t('Initial')}</span>
                          ) : null}
                          {issue.state === 'USER_ACCEPTANCE' && issue.acceptedDigest ? (
                            <span className="chip ok">{render({ key: 'Accepted', values: {} })}</span>
                          ) : null}
                          {isRework ? <span className="chip rework">{t('Rework')}</span> : null}
                          {needsYou ? <span className="chip you">{youChip}</span> : null}
                          {live ? <LiveChip startedAt={run.startedAt ?? run.createdAt} now={now} /> : null}
                          <Avatar
                            name={actor.name}
                            initials={actor.isYou ? t('You').slice(0, 1) : actor.name ? actorInitials(actor.name) : undefined}
                            isYou={actor.isYou}
                          />
                        </span>
                      </a>
                    );
                  })}
                </section>
              ))}
              {boardData.notOnBoard.length ? (
                <p className="muted board-rest">
                  {t('Not on the board')}:{' '}
                  {boardData.notOnBoard.map((issue, index) => (
                    <span key={issue.id}>
                      {index > 0 ? ', ' : ''}
                      <a
                        className="lnk"
                        href={`/w/${encodeURIComponent(issue.workspaceId)}/issues/${encodeURIComponent(issue.id)}`}
                        onClick={(event) => {
                          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                          event.preventDefault();
                          onSelect(issue.id);
                        }}
                      >
                        {issue.titleSuffix} ({render({ key: issue.state === 'ON_HOLD' ? 'On hold' : 'abandoned', values: {} })})
                      </a>
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="list">
            {(() => {
              const rendered = roots
                .map((req) => {
                  const children = data.issues
                    .filter((child) => child.parentId === req.id)
                    .filter((child) => matchesFilter(child, filter, req.titleSuffix));
                  const selfMatch = matchesFilter(req, filter);
                  if (filter.trim() && !selfMatch && !children.length) return null;
                  const defaultClosed = req.state === 'DONE' && !filter.trim();
                  const closed = defaultClosed ? !toggled.has(req.id) : toggled.has(req.id);
                  const prog = requirementProgress(req.id, data.issues, entries);
                  const needsYou = entries.some((entry) => entry.issueId === req.id && isNeedsYou(entry));
                  const statusText = render(issueStatusForWorkspace(req, data, entries, roleWords));
                  return (
                    <div key={req.id}>
                      <div className={`ghead ${closed ? 'closed' : ''}`}>
                        <button
                          type="button"
                          className="tg"
                          aria-expanded={!closed}
                          aria-label={`${closed ? t('Expand') : t('Collapse')} ${req.titleSuffix}`}
                          onClick={() => toggleGroup(req.id)}
                        >
                          <UiIcon name="chev" size={14} />
                        </button>
                        <a
                          href={`/w/${encodeURIComponent(req.workspaceId)}/issues/${encodeURIComponent(req.id)}`}
                          onClick={(event) => {
                            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                            event.preventDefault();
                            onSelect(req.id);
                          }}
                        >
                          {req.state === 'DONE' ? <StatusIcon kind="done" /> : <ProgressRing done={prog.done} total={prog.total} />}
                          <span className="cut">{req.titleSuffix}</span>
                        </a>
                        {needsYou ? <span className="chip you">{youChip}</span> : null}
                        <span className="gm">{prog.total > 0 ? `${prog.done}/${prog.total}` : statusText}</span>
                      </div>
                      {!closed
                        ? children.map((child) => (
                            <TaskRow
                              key={child.id}
                              issue={child}
                              workspace={data}
                              entries={entries}
                              now={now}
                              onSelect={onSelect}
                            />
                          ))
                        : null}
                    </div>
                  );
                })
                .filter(Boolean);
              if (rendered.length) return rendered;
              return (
                <div className="center">
                  <Empty title={data.issues.length ? t('No matching issues') : t('No requirements yet')}>
                    <p>{data.issues.length ? t('Try another filter.') : t('Create a requirement to get started.')}</p>
                  </Empty>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </>
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
      <button className="btn primary" type="submit">
        {t('Register workspace')}
      </button>
    </AsyncForm>
  );
}

const SECTION_TITLE: Record<SettingsSection, string> = {
  general: 'General',
  notify: 'Notifications',
  workspace: 'Workspace',
  agents: 'Agents',
  checks: 'Test commands',
  runs: 'Runs'
};

const ROLE_LABEL: Record<Actor['role'], string> = {
  human: 'Owner',
  lead: 'Lead',
  pm: 'PM',
  worker: 'Developer',
  qa: 'Independent QA'
};

function GeneralSettings({ onLogout }: { onLogout(): void }) {
  const { locale, theme, zoom, setLocale, setTheme, setZoom, t } = usePreferences();
  const themes: [Theme, string][] = [
    ['system', 'System'],
    ['light', 'Light'],
    ['dark', 'Dark']
  ];
  return (
    <div className="slist">
      <div className="srow">
        <div className="sl">
          <b>{t('Language')}</b>
        </div>
        <span className="seg" role="group" aria-label={t('Language')}>
          <button type="button" aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>
            中文
          </button>
          <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
            English
          </button>
        </span>
      </div>
      <div className="srow">
        <div className="sl">
          <b>{t('Appearance')}</b>
        </div>
        <span className="seg" role="group" aria-label={t('Appearance')}>
          {themes.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)}>
              {t(label)}
            </button>
          ))}
        </span>
      </div>
      <div className="srow srow-wrap">
        <div className="sl">
          <b id="zoom-label">{t('Zoom')}</b>
          <small>{t('Hold Ctrl and scroll; Ctrl+0 resets to 100%.')}</small>
        </div>
        <div className="zoom-controls">
          <button type="button" className="btn sm" aria-label={t('Zoom out')} disabled={zoom <= 50} onClick={() => setZoom(zoom - 5)}>
            −
          </button>
          <input
            type="range"
            min="50"
            max="200"
            step="5"
            value={zoom}
            aria-labelledby="zoom-label"
            aria-valuetext={`${zoom}%`}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          <button type="button" className="btn sm" aria-label={t('Zoom in')} disabled={zoom >= 200} onClick={() => setZoom(zoom + 5)}>
            +
          </button>
          <output className="mono muted" aria-live="polite">{zoom}%</output>
          {zoom !== 100 ? (
            <button type="button" className="btn sm" onClick={() => setZoom(100)}>
              {t('Reset')}
            </button>
          ) : null}
        </div>
      </div>
      <div className="srow">
        <div className="sl">
          <b>{t('Session')}</b>
          <small>{t('Disconnect this browser from the local workspace.')}</small>
        </div>
        <button type="button" className="btn" onClick={onLogout}>
          {t('Sign out')}
        </button>
      </div>
    </div>
  );
}

function WorkspaceSection({
  data,
  onSaved,
  onRegistered
}: {
  data: WorkspaceData;
  onSaved(): void;
  onRegistered(workspace: Workspace): void;
}) {
  const t = useText();
  const [binding, setBinding] = useState<GitBinding | null>(null);
  const [showBind, setShowBind] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const firstIssueId = data.issues[0]?.id ?? null;

  useEffect(() => {
    setBinding(null);
    if (!data.workspace.gitBindingId || !firstIssueId) return;
    let active = true;
    command<{ evidence: GitBinding }>('evidence_get', {
      workspaceId: data.workspace.id,
      issueId: firstIssueId,
      kind: 'git_binding',
      evidenceId: data.workspace.gitBindingId
    })
      .then((result) => {
        if (active) setBinding(result.evidence);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [data.workspace.id, data.workspace.gitBindingId, firstIssueId]);

  const repoText = binding
    ? `${binding.repository} (${binding.remote})`
    : data.workspace.gitBindingId
      ? t('GitHub repository bound')
      : data.workspace.commonDir
        ? t('Not bound; delivered as files.')
        : t('Not a Git directory; delivered as files.');

  return (
    <div className="slist">
      <div className="srow">
        <div className="sl">
          <b>{data.workspace.name}</b>
          <small className="mono">{data.workspace.root}</small>
        </div>
      </div>
      <div className="srow">
        <div className="sl">
          <b>{t('Git repository')}</b>
          <small>{repoText}</small>
        </div>
        {data.workspace.commonDir ? (
          <button type="button" className="btn" onClick={() => setShowBind((value) => !value)}>
            {data.workspace.gitBindingId ? t('Rebind') : t('Bind')}
          </button>
        ) : null}
      </div>
      {showBind && data.workspace.commonDir ? (
        <div className="sform-box">
          <AsyncForm
            className="settings-form"
            onDone={() => {
              setShowBind(false);
              onSaved();
            }}
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
              <input name="remote" required defaultValue={binding?.remote ?? 'origin'} />
            </Field>
            <button type="submit" className="btn primary">
              {t('Bind GitHub remote')}
            </button>
          </AsyncForm>
        </div>
      ) : null}
      <div className="srow">
        <div className="sl">
          <b>{t('Other projects')}</b>
        </div>
        <button type="button" className="btn" onClick={() => setShowAdd((value) => !value)}>
          <UiIcon name="plus" size={14} />
          {t('Add a workspace')}
        </button>
      </div>
      {showAdd ? (
        <div className="sform-box">
          <WorkspaceRegistration
            onRegistered={(workspace) => {
              setShowAdd(false);
              onRegistered(workspace);
            }}
          />
        </div>
      ) : null}
      <AuditDetails
        rows={[
          ['Workspace ID', data.workspace.id],
          ['Issue prefix', data.workspace.prefix],
          ['Git binding', data.workspace.gitBindingId]
        ]}
      />
    </div>
  );
}

function AgentsSection({
  data,
  online,
  onSaved
}: {
  data: WorkspaceData;
  online: boolean;
  onSaved(): void;
}) {
  const t = useText();
  const codeText = useCodeText();
  const dateText = useDateText();
  const [wake, setWake] = useState<WakeSettingsData | null>(null);
  const [wakeBusy, setWakeBusy] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [credential, setCredential] = useState<{ actor: Actor; token?: string } | null>(null);
  const [copied, setCopied] = useState('');

  const loadWake = useCallback(async () => {
    try {
      const result = await command<WakeSettingsData>('wake_settings_get', { workspaceId: data.workspace.id });
      setWake(result);
      setWakeError(null);
    } catch (failure) {
      setWakeError(failure instanceof ApiError ? failure.code : 'SERVICE_UNAVAILABLE');
    }
  }, [data.workspace.id]);

  useEffect(() => {
    void loadWake();
  }, [loadWake]);

  async function toggleWake() {
    if (!wake || wakeBusy || !online) return;
    setWakeBusy(true);
    setWakeError(null);
    try {
      const result = await mutation<{ settings: WakeSettingsData['settings'] }>('wake_settings_update', {
        workspaceId: data.workspace.id,
        expectedVersion: wake.settings.version,
        enabled: !wake.settings.enabled
      });
      setWake((current) => (current ? { ...current, settings: result.settings } : current));
      onSaved();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'VERSION_CONFLICT') {
        await loadWake();
      }
      setWakeError(failure instanceof ApiError ? failure.code : 'SERVICE_UNAVAILABLE');
    } finally {
      setWakeBusy(false);
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(credential?.token ?? '');
      setCopied('Credential copied.');
    } catch {
      setCopied('Select and copy the credential manually.');
    }
  }

  const agents = data.actors.filter((actor) => actor.role !== 'human');
  const modeByHarness = new Map((wake?.modes ?? []).map((mode) => [mode.harness, mode.fresh]));

  return (
    <div className="slist">
      {agents.length ? (
        agents.map((actor) => {
          const harness = inferAgentHarness(actor, data.connections, data.issues);
          const verified = harness ? modeByHarness.get(harness) === 'AVAILABLE' : false;
          return (
            <div className="srow" key={actor.id}>
              <div className="sl">
                <b>{actor.name}</b>
                <small>
                  {t(ROLE_LABEL[actor.role])}
                  {harness ? ` · ${harnessName(harness)}` : ''}
                </small>
              </div>
              <span className={`chip ${verified ? 'ok' : ''}`}>
                {verified ? t('Can be woken') : t('Wake not verified')}
              </span>
            </div>
          );
        })
      ) : (
        <div className="srow">
          <div className="sl">
            <small>{t('No agents enrolled yet.')}</small>
          </div>
        </div>
      )}
      <div className="srow">
        <div className="sl">
          <b>{t('Let agents wake each other')}</b>
          <small>{t("Uses the other agent's quota. At most 3 times per issue per day, 10 minutes each.")}</small>
        </div>
        <button
          type="button"
          className="sw"
          role="switch"
          disabled={!wake || wakeBusy || !online}
          aria-checked={Boolean(wake?.settings.enabled)}
          aria-label={t('Let agents wake each other')}
          onClick={() => void toggleWake()}
        />
      </div>
      {wakeError ? (
        <p className="error" role="alert">
          {codeText(wakeError)}
        </p>
      ) : null}
      <div className="srow">
        <div className="sl" />
        <button type="button" className="btn" disabled={!online} onClick={() => setShowAdd((value) => !value)}>
          <UiIcon name="plus" size={14} />
          {t('Add an agent')}
        </button>
      </div>
      {showAdd ? (
        <div className="sform-box">
          <AsyncForm
            className="settings-form"
            onDone={() => {
              setShowAdd(false);
              onSaved();
            }}
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
                <option value="worker">{t('Developer')}</option>
                <option value="qa">{t('Independent QA')}</option>
                <option value="lead">{t('Lead')}</option>
                <option value="pm">{t('PM')}</option>
              </select>
            </Field>
            <button type="submit" className="btn primary">
              {t('Enroll agent')}
            </button>
          </AsyncForm>
        </div>
      ) : null}
      {credential ? (
        <div className="credential" role="region" aria-label={t('New agent credential')}>
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
              <div className="abar-row">
                <button type="button" className="btn primary" onClick={() => void copyToken()}>
                  {t('Copy credential')}
                </button>
                <button type="button" className="btn" onClick={() => setCredential(null)}>
                  {t('Hide credential')}
                </button>
              </div>
              {copied ? <p role="status">{t(copied)}</p> : null}
            </>
          ) : (
            <p>{t('Replayed enrollment does not return the credential. Enroll a new identity if the original response was lost.')}</p>
          )}
        </div>
      ) : null}
      <AuditDetails
        rows={[
          ...agents.map((actor): [string, string] => [actor.name, actor.id]),
          ...data.connections.map((conn): [string, string] => [
            `${conn.client.name} (${dateText(conn.initializedAt)})`,
            conn.actorId
          ])
        ]}
      />
    </div>
  );
}

function ChecksSection({ data, online, onSaved }: { data: WorkspaceData; online: boolean; onSaved(): void }) {
  const t = useText();
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div className="slist">
      {data.profiles.map((profile) => (
        <div className="srow" key={profile.id}>
          <div className="sl">
            <b>{profile.name}</b>
            <small className="mono">{[profile.command, ...profile.args].join(' ')}</small>
            <small>
              {profile.criteria.join(', ')} · {Math.round(profile.timeoutMs / 1000)} {t('seconds')}
            </small>
          </div>
        </div>
      ))}
      <div className="srow">
        <div className="sl">
          <small>{t('Only these commands count as independent QA evidence.')}</small>
        </div>
        <button type="button" className="btn" disabled={!online} onClick={() => setShowAdd((value) => !value)}>
          <UiIcon name="plus" size={14} />
          {t('Add a command')}
        </button>
      </div>
      {showAdd ? (
        <div className="sform-box">
          <AsyncForm
            className="settings-form"
            onDone={() => {
              setShowAdd(false);
              onSaved();
            }}
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
            <button type="submit" className="btn primary">
              {t('Approve profile')}
            </button>
          </AsyncForm>
        </div>
      ) : null}
      {data.profiles.length ? (
        <AuditDetails rows={data.profiles.map((profile): [string, string] => [profile.name, profile.id])} />
      ) : null}
    </div>
  );
}

const RUN_STATE_LABEL: Record<Run['state'], [string, string]> = {
  QUEUED: ['Queued', ''],
  STARTING: ['Starting', ''],
  RUNNING: ['Running', ''],
  STOPPING: ['Stopping', 'warn'],
  UNCERTAIN: ['Lost', 'crit'],
  SUCCEEDED: ['Completed', 'ok'],
  FAILED: ['Failed', 'crit'],
  CANCELLED: ['Stopped', '']
};

function RunsSection({
  data,
  runId,
  online,
  onSelectIssue
}: {
  data: WorkspaceData;
  runId: string | null;
  online: boolean;
  onSelectIssue(issueId: string): void;
}) {
  const t = useText();
  const render = useSentence();
  const dateText = useDateText();
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ runs: Run[]; total: number; nextOffset: number | null } | null>(null);
  const [targeted, setTargeted] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState<Run | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOffset(0);
  }, [data.workspace.id]);

  useEffect(() => {
    setTargeted(null);
    if (!runId) return;
    let active = true;
    command<{ run: Run }>('run_get', { workspaceId: data.workspace.id, runId })
      .then((result) => {
        if (active) setTargeted(result.run);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [data.workspace.id, runId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await command<{ runs: Run[]; total: number; nextOffset: number | null }>('ui_runs', {
          workspaceId: data.workspace.id,
          offset
        });
        if (active) {
          setPage(result);
          setError('');
        }
      } catch (failure) {
        if (active) setError(errorText(failure));
      } finally {
        if (active) timer = setTimeout(load, 1500);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data.workspace.id, offset]);

  useEffect(() => {
    if (runId && targetRef.current) {
      targetRef.current.scrollIntoView({ block: 'center' });
    }
  }, [runId, page, targeted]);

  const runs = useMemo(() => {
    const list = page?.runs ?? [];
    if (targeted && !list.some((item) => item.id === targeted.id)) return [targeted, ...list];
    return list;
  }, [page, targeted]);

  const issueById = useMemo(() => new Map(data.issues.map((issue) => [issue.id, issue])), [data.issues]);
  const actorById = useMemo(() => new Map(data.actors.map((actor) => [actor.id, actor.name])), [data.actors]);

  const kindLabel = (kind: Run['kind']) =>
    kind === 'consult' ? t('Answering') : kind === 'qa' ? t('Independent QA') : t('Development');

  return (
    <div className="slist">
      {error ? (
        <p className="error" role="alert">
          {t(error)}
        </p>
      ) : null}
      {runs.length ? (
        runs.map((run) => {
          const issue = issueById.get(run.issueId);
          const who = actorById.get(run.actorId) ?? t('Agent');
          const [stateLabel, tone] = RUN_STATE_LABEL[run.state];
          const live = ['QUEUED', 'STARTING', 'RUNNING', 'STOPPING'].includes(run.state);
          const resultLine = run.errorCode
            ? render(runResultSentence(run.errorCode, { harness: harnessName(run.harness) }))
            : null;
          const highlighted = runId === run.id;
          return (
            <div
              key={run.id}
              ref={highlighted ? targetRef : undefined}
              className={`srow ${highlighted ? 'srow-hi' : ''}`}
            >
              <div className="sl">
                <b>
                  <a
                    className="lnk-plain"
                    href={`/w/${encodeURIComponent(data.workspace.id)}/issues/${encodeURIComponent(run.issueId)}`}
                    onClick={(event) => {
                      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      onSelectIssue(run.issueId);
                    }}
                  >
                    {issue ? issue.titleSuffix : t('Open issue')}
                  </a>
                </b>
                <small>
                  {who} · {harnessName(run.harness)} · {kindLabel(run.kind)} · {dateText(run.startedAt ?? run.createdAt)}
                </small>
                {resultLine ? <small>{resultLine}</small> : null}
              </div>
              <span className={`chip ${tone}`}>{t(stateLabel)}</span>
              {live ? (
                <button type="button" className="btn sm" disabled={!online} onClick={() => setStopping(run)}>
                  {t('Stop')}
                </button>
              ) : null}
              {run.state === 'UNCERTAIN' ? (
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={!online}
                  onClick={() => openDecisionCard(data.workspace.id, run.issueId, 'RUN_RECONCILE')}
                >
                  {t('Check the run')}
                </button>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="srow">
          <div className="sl">
            <small>{t('No runs recorded yet.')}</small>
          </div>
        </div>
      )}
      {page && (offset > 0 || page.nextOffset !== null) ? (
        <div className="srow">
          <div className="sl" />
          <div className="abar-row">
            <button type="button" className="btn sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>
              {t('Previous')}
            </button>
            <button type="button" className="btn sm" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>
              {t('Next')}
            </button>
          </div>
        </div>
      ) : null}
      {runs.length ? (
        <AuditDetails
          rows={runs.flatMap((run): [string, string | number | undefined][] => [
            [`${kindLabel(run.kind)} (${dateText(run.createdAt)})`, run.id],
            ...(run.pid ? [[t('Process ID'), run.pid] as [string, number]] : []),
            ...(run.errorCode ? [[t('Error'), run.errorCode] as [string, string]] : [])
          ])}
        />
      ) : null}
      {stopping ? (
        <Modal title={t('Stop run')} onClose={() => setStopping(null)}>
          <AsyncForm
            onDone={() => setStopping(null)}
            onSave={(form) =>
              mutation('run_interrupt', {
                workspaceId: data.workspace.id,
                runId: stopping.id,
                expectedVersion: stopping.version,
                ...formKey(form),
                reason: String(form.get('reason'))
              })
            }
          >
            <div className="form-body">
              <Field label={t('Reason')}>
                <textarea name="reason" required rows={3} autoFocus />
              </Field>
            </div>
            <footer className="form-footer">
              <button type="button" className="btn" onClick={() => setStopping(null)}>
                {t('Cancel')}
              </button>
              <button type="submit" className="btn primary">
                {t('Stop')}
              </button>
            </footer>
          </AsyncForm>
        </Modal>
      ) : null}
    </div>
  );
}

export function SettingsView({
  section,
  data,
  runId,
  online,
  attention,
  onSaved,
  onRegistered,
  onSelectIssue,
  onLogout,
  onMenu
}: {
  section: SettingsSection;
  data: WorkspaceData | null;
  runId: string | null;
  online: boolean;
  attention: ReturnType<typeof useDesktopAttention>;
  onSaved(): void;
  onRegistered(workspace: Workspace): void;
  onSelectIssue(issueId: string): void;
  onLogout(): void;
  onMenu(): void;
}) {
  const t = useText();
  return (
    <>
      <header className="bar">
        <button type="button" className="icon-btn menu-btn" aria-label={t('Open navigation')} onClick={onMenu}>
          <UiIcon name="menu" />
        </button>
        <h1>{t('Settings')}</h1>
      </header>
      <div className="scroll">
        <div className="set">
          <h2>{t(SECTION_TITLE[section])}</h2>
          {section === 'general' ? <GeneralSettings onLogout={onLogout} /> : null}
          {section === 'notify' ? <DesktopAttentionSettings attention={attention} /> : null}
          {section === 'workspace' ? (
            data ? (
              <WorkspaceSection data={data} onSaved={onSaved} onRegistered={onRegistered} />
            ) : (
              <WorkspaceRegistration onRegistered={onRegistered} />
            )
          ) : null}
          {section === 'agents' ? (
            data ? (
              <AgentsSection data={data} online={online} onSaved={onSaved} />
            ) : (
              <p className="muted">{t('Create a workspace first.')}</p>
            )
          ) : null}
          {section === 'checks' ? (
            data ? (
              <ChecksSection data={data} online={online} onSaved={onSaved} />
            ) : (
              <p className="muted">{t('Create a workspace first.')}</p>
            )
          ) : null}
          {section === 'runs' ? (
            data ? (
              <RunsSection data={data} runId={runId} online={online} onSelectIssue={onSelectIssue} />
            ) : (
              <p className="muted">{t('Create a workspace first.')}</p>
            )
          ) : null}
        </div>
      </div>
    </>
  );
}
