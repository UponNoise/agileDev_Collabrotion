import type { InboxKind } from '../src/contracts';
import type { InboxEntry } from './api';

export type Destination = 'decisions' | 'work' | 'settings';
export type WorkMode = 'list' | 'board';
export type SettingsSection = 'general' | 'notify' | 'workspace' | 'agents' | 'checks' | 'runs';

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'general',
  'notify',
  'workspace',
  'agents',
  'checks',
  'runs'
];

export type AppRoute =
  | {
      dest: 'decisions';
      workspaceId: string | null;
      entryId: string | null;
      issueId: string | null;
      kind: InboxKind | null;
    }
  | {
      dest: 'work';
      workspaceId: string | null;
      mode: WorkMode;
      issueId: string | null;
    }
  | {
      dest: 'settings';
      workspaceId: string | null;
      section: SettingsSection;
      runId: string | null;
    };

export type LegacyLink =
  | { kind: 'reviews'; workspaceId: string | null; issueId: string | null }
  | { kind: 'runs'; workspaceId: string | null; runId: string | null }
  | { kind: 'backlog'; workspaceId: string | null; issueId: string | null }
  | { kind: 'issue-view'; workspaceId: string; issueId: string };

export interface ParsedLocation {
  route: AppRoute;
  legacy: LegacyLink | null;
}

const INBOX_KINDS = new Set<string>([
  'DESIGN_REVIEW',
  'DELIVERY_ACCEPTANCE',
  'SCOPE_DECISION',
  'RUN_RECONCILE',
  'CLOSURE_BLOCKED',
  'DEFECT_TRIAGE',
  'AGENT_QUESTION',
  'JOIN_REQUEST'
]);

function isSettingsSection(value: string | null): value is SettingsSection {
  return value !== null && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

function asInboxKind(value: string | null): InboxKind | null {
  return value && INBOX_KINDS.has(value) ? (value as InboxKind) : null;
}

export function parseLocation(pathname: string, search: string): ParsedLocation {
  const match = pathname.match(/^\/w\/([^/]+)\/issues\/([^/]+)$/);
  const query = new URLSearchParams(search);
  const pathWorkspace = match?.[1] ? decodeURIComponent(match[1]) : null;
  const pathIssue = match?.[2] ? decodeURIComponent(match[2]) : null;
  const workspaceId = pathWorkspace ?? query.get('workspace') ?? null;
  const view = query.get('view');
  const runId = query.get('run');

  if (view === 'reviews') {
    return {
      route: pathIssue && workspaceId
        ? { dest: 'work', workspaceId, mode: 'list', issueId: pathIssue }
        : { dest: 'decisions', workspaceId, entryId: null, issueId: pathIssue, kind: null },
      legacy: { kind: 'reviews', workspaceId, issueId: pathIssue }
    };
  }

  if (view === 'runs') {
    return {
      route: { dest: 'settings', workspaceId, section: 'runs', runId },
      legacy: { kind: 'runs', workspaceId, runId }
    };
  }

  if (view === 'backlog') {
    return {
      route: { dest: 'work', workspaceId, mode: 'list', issueId: pathIssue },
      legacy: { kind: 'backlog', workspaceId, issueId: pathIssue }
    };
  }

  if (pathWorkspace && pathIssue) {
    return {
      route: { dest: 'work', workspaceId: pathWorkspace, mode: 'list', issueId: pathIssue },
      legacy: view ? { kind: 'issue-view', workspaceId: pathWorkspace, issueId: pathIssue } : null
    };
  }

  if (view === 'work' || view === 'board') {
    return {
      route: { dest: 'work', workspaceId, mode: view === 'board' ? 'board' : 'list', issueId: null },
      legacy: null
    };
  }

  if (view === 'settings') {
    const rawSection = query.get('section');
    const section: SettingsSection = isSettingsSection(rawSection) ? rawSection : runId ? 'runs' : 'general';
    return {
      route: { dest: 'settings', workspaceId, section, runId: section === 'runs' ? runId : null },
      legacy: null
    };
  }

  return {
    route: {
      dest: 'decisions',
      workspaceId,
      entryId: query.get('entry'),
      issueId: query.get('issue'),
      kind: asInboxKind(query.get('kind'))
    },
    legacy: null
  };
}

export function resolveLegacyRedirect(
  legacy: LegacyLink,
  entries: readonly Pick<InboxEntry, 'id' | 'workspaceId' | 'issueId' | 'kind' | 'target'>[]
): AppRoute {
  if (legacy.kind === 'backlog') {
    return { dest: 'work', workspaceId: legacy.workspaceId, mode: 'list', issueId: legacy.issueId };
  }
  if (legacy.kind === 'issue-view') {
    return { dest: 'work', workspaceId: legacy.workspaceId, mode: 'list', issueId: legacy.issueId };
  }
  if (legacy.kind === 'reviews') {
    if (legacy.issueId) {
      const match = entries.find(
        (entry) =>
          entry.issueId === legacy.issueId && (!legacy.workspaceId || entry.workspaceId === legacy.workspaceId)
      );
      if (match) {
        return {
          dest: 'decisions',
          workspaceId: match.workspaceId,
          entryId: match.id,
          issueId: match.issueId,
          kind: match.kind
        };
      }
      if (legacy.workspaceId) {
        return { dest: 'work', workspaceId: legacy.workspaceId, mode: 'list', issueId: legacy.issueId };
      }
    }
    return { dest: 'decisions', workspaceId: legacy.workspaceId, entryId: null, issueId: null, kind: null };
  }
  if (legacy.runId) {
    const match = entries.find(
      (entry) =>
        entry.kind === 'RUN_RECONCILE' &&
        entry.target.runId === legacy.runId &&
        (!legacy.workspaceId || entry.workspaceId === legacy.workspaceId)
    );
    if (match) {
      return {
        dest: 'decisions',
        workspaceId: match.workspaceId,
        entryId: match.id,
        issueId: match.issueId,
        kind: 'RUN_RECONCILE'
      };
    }
  }
  return { dest: 'settings', workspaceId: legacy.workspaceId, section: 'runs', runId: legacy.runId };
}

export function routeUrl(route: AppRoute): string {
  if (route.dest === 'work' && route.issueId && route.workspaceId) {
    return `/w/${encodeURIComponent(route.workspaceId)}/issues/${encodeURIComponent(route.issueId)}`;
  }
  const params = new URLSearchParams();
  if (route.workspaceId) params.set('workspace', route.workspaceId);
  if (route.dest === 'decisions') {
    params.set('view', 'decisions');
    if (route.entryId) params.set('entry', route.entryId);
    else if (route.issueId && route.kind) {
      params.set('issue', route.issueId);
      params.set('kind', route.kind);
    }
  } else if (route.dest === 'work') {
    params.set('view', route.mode === 'board' ? 'board' : 'work');
  } else {
    params.set('view', 'settings');
    params.set('section', route.section);
    if (route.section === 'runs' && route.runId) params.set('run', route.runId);
  }
  return `/?${params.toString()}`;
}
