import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Actor, Workspace } from '../src/contracts';
import { ApiError, command, errorText, request, setCsrf } from './api';
import type { IssueData, UiStatus, WorkspaceData } from './api';
import { useCodeText, useSentence } from './CardKit';
import { AsyncForm, Empty, Field, Modal, OnlineContext } from './components';
import { DecisionPane, DecisionRailList, useDecisionInbox, useDecisionSelection } from './Decisions';
import { useDesktopAttention } from './DesktopAttention';
import { ProgressRing, StatusIcon, UiIcon } from './Icons';
import type { UiIconName } from './Icons';
import { IssueForm } from './IssueForms';
import type { IssueDialog } from './IssueForms';
import { IssuePanel } from './IssuePanel';
import { useText } from './Preferences';
import { parseLocation, resolveLegacyRedirect, routeUrl } from './routes';
import type { AppRoute, LegacyLink, SettingsSection } from './routes';
import { isNeedsYou, issueIconKind, requirementProgress } from './work-model';
import type { WorkData } from './work-model';
import { SettingsView, WorkspaceRegistration, WorkView } from './WorkspaceViews';

const SETTINGS_NAV: readonly [SettingsSection, UiIconName, string][] = [
  ['general', 'globe', 'General'],
  ['notify', 'bell', 'Notifications'],
  ['workspace', 'folder', 'Workspace'],
  ['agents', 'agent', 'Agents'],
  ['checks', 'test', 'Test commands'],
  ['runs', 'run', 'Runs']
];

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));
}

function Login({ connected, ownerClaimed }: { connected(actor: Actor, csrf: string): void; ownerClaimed: boolean }) {
  const t = useText();
  return (
    <main className="login">
      <div className="login-content">
        <div className="login-brand">
          <span className="logo">A</span>
          <span>AgileDev</span>
        </div>
        <h1>{t('Connect to your workspace')}</h1>
        <p className="dim">
          {ownerClaimed ? t('Open the AgileDev desktop app, then go to Settings → General → Open in a browser to get a one-use code.') : <>
            {t('Run ')}<code>node dist/cli.js ui</code>{t(' in your local installation, then enter the one-use code.')}
          </>}
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
              autoFocus
              autoComplete="one-time-code"
              maxLength={100}
              spellCheck={false}
            />
          </Field>
          <button type="submit" className="btn primary login-btn">
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

interface PaletteItem {
  id: string;
  label: string;
  meta?: string;
  icon: UiIconName;
  run(): void;
}

function CommandPalette({
  items,
  onClose
}: {
  items: readonly PaletteItem[];
  onClose(): void;
}) {
  const t = useText();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 12);
    return items
      .filter((item) => `${item.label} ${item.meta ?? ''}`.toLowerCase().includes(q))
      .slice(0, 12);
  }, [items, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dlg pal"
        role="dialog"
        aria-modal="true"
        aria-label={t('Search')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelected((index) => (filtered.length ? (index + 1) % filtered.length : 0));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelected((index) => (filtered.length ? (index - 1 + filtered.length) % filtered.length : 0));
          } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            const chosen = filtered[selected];
            if (chosen) {
              onClose();
              chosen.run();
            }
          }
        }}
      >
        <div className="pal-in">
          <UiIcon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('Search issues and actions')}
            aria-label={t('Search issues and actions')}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="pal-l" role="listbox" aria-label={t('Results')}>
          {filtered.length ? (
            filtered.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="pal-i"
                role="option"
                aria-selected={index === selected}
                onMouseEnter={() => setSelected(index)}
                onClick={() => {
                  onClose();
                  item.run();
                }}
              >
                <UiIcon name={item.icon} size={15} />
                <span className="cut">{item.label}</span>
                {item.meta ? <span className="mono muted pal-meta">{item.meta}</span> : null}
              </button>
            ))
          ) : (
            <p className="muted pal-empty">{t('No results')}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ShortcutsModal({ onClose }: { onClose(): void }) {
  const t = useText();
  const rows: [string, string][] = [
    ['J / K', 'Next / previous entry'],
    ['Ctrl ↵', 'Run main action'],
    ['R', 'Open reason field'],
    ['G D / W / S', 'Go to Decisions / Work / Settings'],
    ['C', 'New requirement'],
    ['Ctrl K', 'Search'],
    ['?', 'Shortcuts'],
    ['Esc', 'Close or cancel']
  ];
  return (
    <Modal title={t('Shortcuts')} onClose={onClose}>
      <div className="keys">
        {rows.map(([keys, label]) => (
          <div className="keys-row" key={keys}>
            <span className="kbd">{keys}</span>
            <span>{t(label)}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function App() {
  const t = useText();
  const renderSentenceText = useSentence();
  const codeText = useCodeText();
  const [actor, setActor] = useState<Actor | null>(null);
  const [ownerClaimed, setOwnerClaimed] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [fatal, setFatal] = useState('');
  const [parsed, setParsed] = useState(() => parseLocation(location.pathname, location.search));
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<WorkData | null>(null);
  const [packet, setPacket] = useState<IssueData | null>(null);
  const [detailError, setDetailError] = useState('');
  const [workFilter, setWorkFilter] = useState('');
  const [inboxLimit, setInboxLimit] = useState(20);
  const [online, setOnline] = useState(true);
  const wasOnlineRef = useRef(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [wsPopOpen, setWsPopOpen] = useState(false);
  const [wsPopPos, setWsPopPos] = useState<{ x: number; y: number } | null>(null);
  const wsBtnRef = useRef<HTMLButtonElement>(null);
  const wsPopRef = useRef<HTMLDivElement>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dialog, setDialog] = useState<IssueDialog | null>(null);
  const gPressedAt = useRef(-Infinity);

  const toggleNavigation = useCallback(() => {
    drawerTrigger.current = document.activeElement as HTMLElement | null;
    setMenuOpen((open) => !open);
  }, []);

  useEffect(() => {
    if (menuOpen) wsBtnRef.current?.focus();
  }, [menuOpen]);

  const currentRoute: AppRoute = parsed.route;
  const legacy: LegacyLink | null = parsed.legacy;
  const workspaceId = currentRoute.workspaceId ?? workspaces[0]?.id ?? null;
  const workOpen = currentRoute.dest === 'work';

  const inbox = useDecisionInbox(actor, refresh, inboxLimit);

  const navigate = useCallback((next: AppRoute, replace = false) => {
    const url = routeUrl(next);
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    setParsed({ route: next, legacy: null });
    setMenuOpen(false);
    setWsPopOpen(false);
  }, []);

  const connected = useCallback((next: Actor, csrf: string) => {
    setCsrf(csrf);
    setActor(next);
    setFatal('');
    setOnline(true);
    wasOnlineRef.current = true;
  }, []);

  const saved = useCallback(() => setRefresh((previous) => previous + 1), []);

  const expired = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setCsrf(null);
      setActor(null);
      void request<UiStatus>('/api/ui/status').then(status => setOwnerClaimed(status.ownerClaimed), () => {});
      return true;
    }
    return false;
  }, []);

  const markOnline = useCallback(() => {
    if (!wasOnlineRef.current) {
      wasOnlineRef.current = true;
      setOnline(true);
      setRefresh((previous) => previous + 1);
    } else {
      setOnline(true);
    }
  }, []);

  const markOffline = useCallback(() => {
    wasOnlineRef.current = false;
    setOnline(false);
  }, []);

  // Resolve legacy links (?view=reviews, ?view=runs&run=, ?view=backlog, stale issue query params)
  useEffect(() => {
    if (!legacy) return;
    if (legacy.kind === 'backlog' || legacy.kind === 'issue-view') {
      navigate(resolveLegacyRedirect(legacy, []), true);
      return;
    }
    if (!actor) return;
    const needsInbox = (legacy.kind === 'reviews' && Boolean(legacy.issueId)) || (legacy.kind === 'runs' && Boolean(legacy.runId));
    if (needsInbox && (!inbox.data || inbox.error)) return;
    const next = resolveLegacyRedirect(legacy, inbox.data?.entries ?? []);
    if (needsInbox && !(next.dest === 'decisions' && next.entryId) && inbox.data?.nextOffset != null) {
      if (inbox.data.nextOffset >= inboxLimit) setInboxLimit(inbox.data.nextOffset + 20);
      return;
    }
    navigate(next, true);
  }, [legacy, actor, inbox.data, inbox.error, inboxLimit, navigate]);

  // Monitor inbox errors for auth expiry and connectivity
  useEffect(() => {
    if (expired(inbox.error)) return;
    if (inbox.error && !(inbox.error instanceof ApiError)) {
      markOffline();
    } else if (inbox.data && !inbox.error) {
      if (!workspaceId) markOnline();
    }
  }, [inbox.error, inbox.data, workspaceId, markOnline, markOffline, expired]);

  const attentionCount = actor ? inbox.global?.summary.attention : undefined;
  const desktopAttention = useDesktopAttention({
    authenticated: Boolean(actor),
    blockingCount: attentionCount,
    stale: inbox.loading || Boolean(inbox.error),
    openDecisions: () => {
      navigate({ dest: 'decisions', workspaceId, entryId: null, issueId: null, kind: null });
      saved();
    }
  });

  useEffect(() => {
    const prefix = attentionCount && attentionCount > 0 ? `(${attentionCount}) ` : '';
    document.title = `${prefix}${t('AgileDev')}`;
  }, [attentionCount, t]);

  useEffect(() => {
    const pop = () => setParsed(parseLocation(location.pathname, location.search));
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  // Bootstrap session check
  useEffect(() => {
    let active = true;
    request<UiStatus>('/api/ui/status')
      .then((result) => {
        if (!active) return;
        setOwnerClaimed(result.ownerClaimed);
        if (result.authenticated) connected(result.actor!, result.csrf!);
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
  }, [connected]);

  // Load workspace list
  useEffect(() => {
    if (!actor) {
      setWorkspaces([]);
      setWorkspacesLoaded(false);
      return;
    }
    let active = true;
    command<{ workspaces: Workspace[] }>('workspace_list', {})
      .then((result) => {
        if (active) {
          setWorkspaces(result.workspaces);
          setWorkspacesLoaded(true);
          setFatal('');
        }
      })
      .catch((error) => {
        if (active && !expired(error)) {
          setWorkspacesLoaded(true);
          setFatal(error instanceof ApiError ? codeText(error.code) : errorText(error));
        }
      });
    return () => {
      active = false;
    };
  }, [actor, refresh, expired, codeText]);

  // Poll workspace snapshot (paginating full issue list, resetting cursor on disconnect for AC26)
  useEffect(() => {
    if (!actor || !workspaceId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let cursor: number | undefined;
    const load = async () => {
      try {
        const first = await command<WorkspaceData & { unchanged?: boolean }>('ui_workspace', {
          workspaceId,
          search: '',
          view: 'backlog',
          offset: 0,
          limit: 100,
          afterCursor: cursor
        });
        if (!active) return;
        if (!first.unchanged) {
          const allIssues = [...first.issues];
          let nextOffset = first.nextOffset;
          let pages = 0;
          while (active && nextOffset !== null && pages < 9) {
            const page = await command<WorkspaceData>('ui_workspace', {
              workspaceId,
              search: '',
              view: 'backlog',
              offset: nextOffset,
              limit: 100
            });
            allIssues.push(...page.issues);
            nextOffset = page.nextOffset;
            pages += 1;
          }
          const blockersByIssue = new Map<string, string[]>();
          if (active && workOpen) {
            const { gaps } = await command<{ gaps: { issueId: string; code: string; severity: string }[] }>(
              'gap_list',
              { workspaceId }
            );
            for (const { issueId, code, severity } of gaps) {
              if (severity !== 'blocking') continue;
              const blockers = blockersByIssue.get(issueId);
              if (blockers) blockers.push(code);
              else blockersByIssue.set(issueId, [code]);
            }
          }
          if (active) setData({ ...first, issues: allIssues, nextOffset, blockersByIssue });
        }
        cursor = first.cursor;
        markOnline();
      } catch (error) {
        if (active && !expired(error)) {
          cursor = undefined;
          markOffline();
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
  }, [actor, workspaceId, workOpen, refresh, expired, markOnline, markOffline]);

  const activeIssueId = currentRoute.dest === 'work' ? currentRoute.issueId : null;

  // Load selected issue packet
  useEffect(() => {
    if (!actor || !workspaceId || !activeIssueId) {
      setPacket(null);
      return;
    }
    let active = true;
    setDetailError('');
    command<IssueData>('ui_issue', { workspaceId, issueId: activeIssueId, limit: 100 })
      .then((result) => {
        if (active) setPacket(result);
      })
      .catch((error) => {
        if (active && !expired(error)) {
          setDetailError(error instanceof ApiError ? codeText(error.code) : errorText(error));
        }
      });
    return () => {
      active = false;
    };
  }, [actor, workspaceId, activeIssueId, data?.cursor, refresh, expired, codeText]);

  const decisionSelection = useDecisionSelection(
    inbox.data,
    currentRoute.dest === 'decisions'
      ? { entryId: currentRoute.entryId, issueId: currentRoute.issueId, kind: currentRoute.kind }
      : { entryId: null, issueId: null, kind: null },
    currentRoute.dest === 'decisions',
    useCallback(
      (entry) => {
        navigate(
          { dest: 'decisions', workspaceId: entry.workspaceId, entryId: entry.id, issueId: entry.issueId, kind: entry.kind },
          false
        );
      },
      [navigate]
    )
  );

  // Close workspace popover on outside click / Escape
  useEffect(() => {
    if (!wsPopOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wsPopRef.current?.contains(target) || wsBtnRef.current?.contains(target)) return;
      setWsPopOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setWsPopOpen(false);
        wsBtnRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [wsPopOpen]);

  const currentWorkspaceData = data?.workspace.id === workspaceId ? data : null;
  const openDialog = useCallback((next: Omit<IssueDialog, 'id'>) => {
    setDialog({ ...next, id: crypto.randomUUID() });
  }, []);

  // Global keyboard shortcuts (Section 8)
  useEffect(() => {
    if (!actor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (mod && key === 'k') {
        event.preventDefault();
        setShortcutsOpen(false);
        setWsPopOpen(false);
        setMenuOpen(false);
        setPaletteOpen((open) => !open);
        return;
      }

      if (event.key === 'Escape') {
        if (paletteOpen) {
          event.preventDefault();
          setPaletteOpen(false);
          return;
        }
        if (shortcutsOpen) {
          event.preventDefault();
          setShortcutsOpen(false);
          return;
        }
        if (wsPopOpen) {
          event.preventDefault();
          setWsPopOpen(false);
          return;
        }
        if (menuOpen) {
          event.preventDefault();
          setMenuOpen(false);
          drawerTrigger.current?.focus();
          return;
        }
        return;
      }

      if (paletteOpen || shortcutsOpen || dialog || mod || event.altKey || isTypingTarget(event.target)) return;

      const now = performance.now();
      if (now - gPressedAt.current < 900 && (key === 'd' || key === 'w' || key === 's')) {
        gPressedAt.current = -Infinity;
        event.preventDefault();
        if (key === 'd') navigate({ dest: 'decisions', workspaceId, entryId: null, issueId: null, kind: null });
        else if (key === 'w') navigate({ dest: 'work', workspaceId, mode: 'list', issueId: null });
        else navigate({ dest: 'settings', workspaceId, section: 'general', runId: null });
        return;
      }
      if (key === 'g') {
        gPressedAt.current = now;
        return;
      }
      gPressedAt.current = -Infinity;
      if (key === 'c') {
        if (currentWorkspaceData && online) {
          event.preventDefault();
          openDialog({ kind: 'create' });
        }
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (currentRoute.dest === 'decisions' && (key === 'j' || key === 'k')) {
        event.preventDefault();
        decisionSelection.step(key === 'j' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    actor,
    paletteOpen,
    shortcutsOpen,
    wsPopOpen,
    menuOpen,
    dialog,
    workspaceId,
    currentWorkspaceData,
    online,
    currentRoute.dest,
    decisionSelection,
    navigate,
    openDialog
  ]);

  async function logout() {
    try {
      await request('/api/ui/logout', {});
      setCsrf(null);
      setActor(null);
      setDialog(null);
      setWsPopOpen(false);
      setPaletteOpen(false);
      setShortcutsOpen(false);
    } catch (error) {
      setFatal(errorText(error));
    }
  }

  function registered(workspace: Workspace) {
    saved();
    navigate({ dest: 'work', workspaceId: workspace.id, mode: 'list', issueId: null });
    setWorkFilter('');
  }

  const allEntries = inbox.data?.entries ?? [];
  const activeWorkspace = workspaces.find((ws) => ws.id === workspaceId) ?? null;
  const selectedPacket =
    packet?.issue.id === activeIssueId && packet?.issue.workspaceId === workspaceId ? packet : null;
  const liveRunCount = currentWorkspaceData
    ? currentWorkspaceData.activeRuns.filter((run) => ['QUEUED', 'STARTING', 'RUNNING'].includes(run.state)).length
    : 0;

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    if (currentWorkspaceData) {
      for (const issue of currentWorkspaceData.issues) {
        items.push({
          id: `issue:${issue.id}`,
          label: issue.titleSuffix,
          meta: issue.key,
          icon: issue.parentId ? 'work' : 'doc',
          run: () => navigate({ dest: 'work', workspaceId: issue.workspaceId, mode: 'list', issueId: issue.id })
        });
      }
    }
    items.push(
      {
        id: 'nav:decisions',
        label: t('Decisions'),
        icon: 'inbox',
        run: () => navigate({ dest: 'decisions', workspaceId, entryId: null, issueId: null, kind: null })
      },
      {
        id: 'nav:work',
        label: t('Work'),
        icon: 'work',
        run: () => navigate({ dest: 'work', workspaceId, mode: 'list', issueId: null })
      },
      {
        id: 'nav:board',
        label: t('Board'),
        icon: 'board',
        run: () => navigate({ dest: 'work', workspaceId, mode: 'board', issueId: null })
      },
      ...SETTINGS_NAV.map(([sec, icon, label]) => ({
        id: `nav:settings:${sec}`,
        label: `${t('Settings')}: ${t(label)}`,
        icon,
        run: () => navigate({ dest: 'settings', workspaceId, section: sec, runId: null })
      }))
    );
    if (currentWorkspaceData && online) {
      items.push({
        id: 'act:new',
        label: t('New requirement'),
        icon: 'plus',
        run: () => openDialog({ kind: 'create' })
      });
    }
    items.push({
      id: 'act:keys',
      label: t('Shortcuts'),
      icon: 'kbd',
      run: () => setShortcutsOpen(true)
    });
    return items;
  }, [currentWorkspaceData, workspaceId, online, navigate, openDialog, t]);

  if (initializing) {
    return (
      <main className="login">
        <p role="status">{t('Connecting to the local workspace…')}</p>
      </main>
    );
  }

  if (!actor) {
    return (
      <>
        {fatal ? (
          <p className="connection-banner" role="alert">
            {t(fatal)}
          </p>
        ) : null}
        <Login connected={connected} ownerClaimed={ownerClaimed} />
      </>
    );
  }

  const toggleWsMenu = () => {
    if (wsPopOpen) {
      setWsPopOpen(false);
      return;
    }
    const rect = wsBtnRef.current?.getBoundingClientRect();
    if (rect) {
      setWsPopPos({ x: Math.max(8, rect.left), y: rect.bottom + 6 });
    }
    setWsPopOpen(true);
  };

  // Contextual Work rail requirements list
  const renderWorkRail = () => {
    if (!currentWorkspaceData) return null;
    const attentionIssueIds = new Set(allEntries.filter((entry) => entry.issueId && isNeedsYou(entry)).map((entry) => entry.issueId));
    const hasAttention = (reqId: string) =>
      attentionIssueIds.has(reqId) ||
      currentWorkspaceData.issues.some((child) => child.parentId === reqId && attentionIssueIds.has(child.id));
    const roots = currentWorkspaceData.issues.filter((issue) => !issue.parentId);
    const openRoots = roots.filter((issue) => issue.state !== 'DONE');
    const doneRoots = roots.filter((issue) => issue.state === 'DONE');
    const selectedIssueObj = activeIssueId
      ? currentWorkspaceData.issues.find((issue) => issue.id === activeIssueId) ?? null
      : null;

    const reqLink = (req: WorkspaceData['issues'][number]) => {
      const prog = requirementProgress(req.id, currentWorkspaceData.issues, allEntries);
      const isCurrent = Boolean(
        activeIssueId && (activeIssueId === req.id || selectedIssueObj?.parentId === req.id)
      );
      const needs = hasAttention(req.id);
      const icon = issueIconKind(req, null);
      return (
        <a
          key={req.id}
          className="req"
          href={`/w/${encodeURIComponent(req.workspaceId)}/issues/${encodeURIComponent(req.id)}`}
          aria-current={isCurrent ? 'true' : undefined}
          onClick={(event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate({ dest: 'work', workspaceId: req.workspaceId, mode: 'list', issueId: req.id });
          }}
        >
          {req.state === 'DONE' ? (
            <StatusIcon kind="done" />
          ) : prog.total > 0 ? (
            <ProgressRing done={prog.done} total={prog.total} />
          ) : (
            <StatusIcon kind={icon.kind} progress={icon.progress} />
          )}
          <span className="cut">{req.titleSuffix}</span>
          {needs ? (
            <>
              <span className="you-dot" title={t('Waiting for you')} aria-hidden="true" />
              <span className="sr-only">{t('Waiting for you')}</span>
            </>
          ) : null}
        </a>
      );
    };

    return (
      <>
        <a
          className="req"
          href={routeUrl({ dest: 'work', workspaceId, mode: currentRoute.dest === 'work' ? currentRoute.mode : 'list', issueId: null })}
          aria-current={!activeIssueId ? 'true' : undefined}
          onClick={(event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate({ dest: 'work', workspaceId, mode: currentRoute.dest === 'work' ? currentRoute.mode : 'list', issueId: null });
          }}
        >
          <UiIcon name="work" size={15} />
          <span className="cut">{t('All')}</span>
        </a>
        {openRoots.length ? <div className="ctx-h">{t('Requirements')}</div> : null}
        {openRoots.map(reqLink)}
        {doneRoots.length ? <div className="ctx-h">{renderSentenceText({ key: 'Done', values: {} })}</div> : null}
        {doneRoots.map(reqLink)}
      </>
    );
  };

  const renderSettingsRail = () => {
    const activeSection: SettingsSection = currentRoute.dest === 'settings' ? currentRoute.section : 'general';
    return SETTINGS_NAV.map(([sec, icon, label]) => (
      <a
        key={sec}
        className="req"
        href={routeUrl({ dest: 'settings', workspaceId, section: sec, runId: null })}
        aria-current={activeSection === sec ? 'true' : undefined}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate({ dest: 'settings', workspaceId, section: sec, runId: null });
        }}
      >
        <UiIcon name={icon} size={15} />
        <span className="cut">{t(label)}</span>
      </a>
    ));
  };

  return (
    <OnlineContext.Provider value={online}>
      <a className="skip-link" href="#main">
        {t('Skip to main content')}
      </a>
      <div className={`shell ${menuOpen ? 'menu' : ''}`}>
        <aside className="rail" aria-label={t('Navigation')}>
          <div className="rail-top">
            <button
              ref={wsBtnRef}
              type="button"
              className="ws"
              aria-haspopup="menu"
              aria-expanded={wsPopOpen}
              onClick={toggleWsMenu}
            >
              <span className="logo">A</span>
              <span className="cut">{activeWorkspace?.name ?? 'AgileDev'}</span>
              <UiIcon name="chevd" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title={`${t('Search')} (Ctrl K)`}
              aria-label={t('Search')}
              onClick={() => setPaletteOpen(true)}
            >
              <UiIcon name="search" />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={!currentWorkspaceData || !online}
              title={`${t('New requirement')} (C)`}
              aria-label={t('New requirement')}
              onClick={() => openDialog({ kind: 'create' })}
            >
              <UiIcon name="plus" />
            </button>
          </div>

          <nav className="nav" aria-label={t('Main')}>
            <a
              href={routeUrl({ dest: 'decisions', workspaceId, entryId: null, issueId: null, kind: null })}
              aria-current={currentRoute.dest === 'decisions' ? 'page' : undefined}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigate({ dest: 'decisions', workspaceId, entryId: null, issueId: null, kind: null });
              }}
            >
              <UiIcon name="inbox" />
              <span>{t('Decisions')}</span>
              {attentionCount && attentionCount > 0 ? (
                <span
                  className="n"
                  aria-live="polite"
                  aria-label={t('{count} waiting for you').replace('{count}', String(attentionCount))}
                >
                  {attentionCount}
                </span>
              ) : null}
            </a>
            <a
              href={routeUrl({ dest: 'work', workspaceId, mode: 'list', issueId: null })}
              aria-current={currentRoute.dest === 'work' ? 'page' : undefined}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigate({ dest: 'work', workspaceId, mode: 'list', issueId: null });
              }}
            >
              <UiIcon name="work" />
              <span>{t('Work')}</span>
            </a>
            <a
              href={routeUrl({ dest: 'settings', workspaceId, section: 'general', runId: null })}
              aria-current={currentRoute.dest === 'settings' ? 'page' : undefined}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigate({ dest: 'settings', workspaceId, section: 'general', runId: null });
              }}
            >
              <UiIcon name="gear" />
              <span>{t('Settings')}</span>
            </a>
          </nav>

          <div className="ctx">
            {currentRoute.dest === 'decisions' ? (
              <DecisionRailList
                feed={inbox}
                selection={decisionSelection}
                workspaces={workspaces}
                onMore={() => setInboxLimit((value) => value + 20)}
                onSelected={() => setMenuOpen(false)}
              />
            ) : currentRoute.dest === 'work' ? (
              renderWorkRail()
            ) : (
              renderSettingsRail()
            )}
          </div>

          {!online ? (
            <div className="offline" role="alert">
              <UiIcon name="off" size={15} />
              <span>{t('Disconnected. Reconnecting…')}</span>
            </div>
          ) : null}
        </aside>

        <div className="scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />

        <main id="main" className="main" tabIndex={-1}>
          {fatal ? (
            <p className="error main-alert" role="alert">
              {t(fatal)}
            </p>
          ) : null}

          {currentRoute.dest === 'decisions' ? (
            <DecisionPane
              feed={inbox}
              selection={decisionSelection}
              activeWorkspaceId={workspaceId}
              liveRunCount={liveRunCount}
              onMenu={toggleNavigation}
              onOpenIssue={(wsId, issueId) => navigate({ dest: 'work', workspaceId: wsId, mode: 'list', issueId })}
              onOpenWork={() => navigate({ dest: 'work', workspaceId, mode: 'list', issueId: null })}
              onRetry={saved}
            />
          ) : currentRoute.dest === 'settings' ? (
            <SettingsView
              section={currentRoute.section}
              data={currentWorkspaceData}
              runId={currentRoute.runId}
              online={online}
              attention={desktopAttention}
              ownerClaimed={ownerClaimed}
              desktopSession={actor.channel === 'desktop'}
              onSaved={saved}
              onRegistered={registered}
              onSelectIssue={(issueId) =>
                navigate({ dest: 'work', workspaceId: workspaceId!, mode: 'list', issueId })
              }
              onLogout={() => void logout()}
              onMenu={toggleNavigation}
            />
          ) : !workspaceId && workspacesLoaded ? (
            <>
              <header className="bar">
                <button
                  type="button"
                  className="icon-btn menu-btn"
                  aria-label={t('Open navigation')}
                  onClick={toggleNavigation}
                >
                  <UiIcon name="menu" />
                </button>
                <h1>{t('Work')}</h1>
              </header>
              <div className="scroll">
                <div className="set">
                  <h2>{t('Create your first workspace')}</h2>
                  <p className="dim">{t('Register a project directory to start planning requirements.')}</p>
                  <WorkspaceRegistration onRegistered={registered} />
                </div>
              </div>
            </>
          ) : currentWorkspaceData ? (
            activeIssueId ? (
              selectedPacket ? (
                <IssuePanel
                  key={selectedPacket.issue.id}
                  packet={selectedPacket}
                  workspace={currentWorkspaceData}
                  entries={allEntries}
                  online={online}
                  onDialog={openDialog}
                  onRefresh={saved}
                  onBack={() => navigate({ dest: 'work', workspaceId, mode: 'list', issueId: null })}
                  onSelectIssue={(issueId) =>
                    navigate({ dest: 'work', workspaceId: workspaceId!, mode: 'list', issueId })
                  }
                  onMenu={toggleNavigation}
                />
              ) : (
                <>
                  <header className="bar">
                    <button
                      type="button"
                      className="icon-btn menu-btn"
                      aria-label={t('Open navigation')}
                      onClick={toggleNavigation}
                    >
                      <UiIcon name="menu" />
                    </button>
                    <div className="crumb">
                      <a
                        href={routeUrl({ dest: 'work', workspaceId, mode: 'list', issueId: null })}
                        onClick={(event) => {
                          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                          event.preventDefault();
                          navigate({ dest: 'work', workspaceId, mode: 'list', issueId: null });
                        }}
                      >
                        {t('Work')}
                      </a>
                    </div>
                  </header>
                  <div className="scroll">
                    <div className="center">
                      <div className="empty" role={detailError ? 'alert' : 'status'}>
                        <p>{detailError || t('Loading issue details…')}</p>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => navigate({ dest: 'work', workspaceId, mode: 'list', issueId: null })}
                        >
                          {t('Back to workspace')}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )
            ) : (
              <WorkView
                data={currentWorkspaceData}
                entries={allEntries}
                mode={currentRoute.mode}
                filter={workFilter}
                online={online}
                onFilter={setWorkFilter}
                onMode={(mode) => navigate({ dest: 'work', workspaceId, mode, issueId: null })}
                onSelect={(issueId) => navigate({ dest: 'work', workspaceId: workspaceId!, mode: 'list', issueId })}
                onNew={() => openDialog({ kind: 'create' })}
                onMenu={toggleNavigation}
              />
            )
          ) : (
            <>
              <header className="bar">
                <button
                  type="button"
                  className="icon-btn menu-btn"
                  aria-label={t('Open navigation')}
                  onClick={toggleNavigation}
                >
                  <UiIcon name="menu" />
                </button>
                <h1>{t('Work')}</h1>
              </header>
              <div className="scroll">
                <div className="center">
                  <Empty title={!online ? t('Workspace unavailable') : t('Loading workspace')}>
                    <p>{!online ? t('Disconnected. Reconnecting…') : t('Reading committed local records…')}</p>
                  </Empty>
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {wsPopOpen && wsPopPos ? (
        <div
          ref={wsPopRef}
          className="pop"
          role="menu"
          aria-label={t('Workspace')}
          style={{ left: `${wsPopPos.x}px`, top: `${wsPopPos.y}px` }}
        >
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setWorkFilter('');
                if (currentRoute.dest === 'work') {
                  navigate({ dest: 'work', workspaceId: ws.id, mode: currentRoute.mode, issueId: null });
                } else if (currentRoute.dest === 'settings') {
                  navigate({ dest: 'settings', workspaceId: ws.id, section: currentRoute.section, runId: null });
                } else {
                  navigate({ dest: 'decisions', workspaceId: ws.id, entryId: currentRoute.entryId, issueId: currentRoute.issueId, kind: currentRoute.kind });
                }
              }}
            >
              <span className="cut">{ws.name}</span>
              {ws.id === workspaceId ? (
                <span className="ck">
                  <UiIcon name="check" size={15} />
                </span>
              ) : null}
            </button>
          ))}
          {workspaces.length ? <hr /> : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => navigate({ dest: 'settings', workspaceId, section: 'workspace', runId: null })}
          >
            <UiIcon name="plus" size={15} />
            <span>{t('Add a workspace')}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => setShortcutsOpen(true)}>
            <UiIcon name="kbd" size={15} />
            <span>{t('Shortcuts')}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void logout()}>
            <UiIcon name="signout" size={15} />
            <span>{t('Sign out')}</span>
          </button>
        </div>
      ) : null}

      {paletteOpen ? <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} /> : null}
      {shortcutsOpen ? <ShortcutsModal onClose={() => setShortcutsOpen(false)} /> : null}

      {dialog && currentWorkspaceData ? (
        <IssueForm
          key={dialog.id}
          dialog={dialog}
          workspace={currentWorkspaceData}
          onSaved={saved}
          onCreated={(issue) => {
            if (!issue.parentId) {
              navigate({ dest: 'work', workspaceId: issue.workspaceId, mode: 'list', issueId: issue.id });
            }
          }}
          onReload={(nextPacket) => {
            setDialog((previous) =>
              previous?.id === dialog.id
                ? { ...previous, id: crypto.randomUUID(), packet: nextPacket, refreshed: true }
                : previous
            );
            saved();
          }}
          onClose={() => setDialog((previous) => (previous?.id === dialog.id ? null : previous))}
        />
      ) : null}
    </OnlineContext.Provider>
  );
}
