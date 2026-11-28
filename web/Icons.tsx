import type { ReactNode } from 'react';
import type { StatusIconKind } from './work-model';

export type UiIconName =
  | 'inbox'
  | 'work'
  | 'board'
  | 'list'
  | 'gear'
  | 'search'
  | 'plus'
  | 'more'
  | 'chev'
  | 'chevd'
  | 'up'
  | 'arrow'
  | 'check'
  | 'x'
  | 'copy'
  | 'ext'
  | 'refresh'
  | 'off'
  | 'menu'
  | 'globe'
  | 'bell'
  | 'folder'
  | 'agent'
  | 'test'
  | 'run'
  | 'kbd'
  | 'doc'
  | 'pkg'
  | 'scope'
  | 'alert'
  | 'lock'
  | 'bug'
  | 'chat'
  | 'signout';

const PATHS: Record<UiIconName, ReactNode> = {
  inbox: <path d="M2.5 9.5h3.2l1.2 2h2.2l1.2-2h3.2M3.3 4.5l-.8 5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3l-.8-5a1 1 0 0 0-1-.8H4.3a1 1 0 0 0-1 .8Z" />,
  work: <path d="M3 4h10M3 8h10M3 12h7" />,
  board: <><rect x="2.2" y="2.8" width="3.2" height="10.4" rx=".8" /><rect x="6.4" y="2.8" width="3.2" height="7" rx=".8" /><rect x="10.6" y="2.8" width="3.2" height="9" rx=".8" /></>,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.6M2.5 8h.6M2.5 12h.6" />,
  gear: <><circle cx="8" cy="8" r="2.2" /><path d="M8 2.2v1.3M8 12.5v1.3M2.2 8h1.3M12.5 8h1.3M3.9 3.9l.9.9M11.2 11.2l.9.9M12.1 3.9l-.9.9M4.8 11.2l-.9.9" /></>,
  search: <><circle cx="7" cy="7" r="4.3" /><path d="M10.4 10.4 13.5 13.5" /></>,
  plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
  more: <><circle cx="4" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" /></>,
  chev: <path d="M6 3.8 10.2 8 6 12.2" />,
  chevd: <path d="M3.8 6 8 10.2 12.2 6" />,
  up: <path d="M3.8 10 8 5.8 12.2 10" />,
  arrow: <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" />,
  check: <path d="M3.5 8.3 6.5 11.3 12.6 5" />,
  x: <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />,
  copy: <><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.4" /><path d="M10.5 5.5V4a1.2 1.2 0 0 0-1.2-1.2H4A1.2 1.2 0 0 0 2.8 4v5.3A1.2 1.2 0 0 0 4 10.5h1.5" /></>,
  ext: <path d="M9.2 2.8h4v4M13.2 2.8 7.5 8.5M11.5 9.2v3a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h3" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.3-3.4M13 2.8v2.4h-2.4" />,
  off: <path d="M2.5 2.5 13.5 13.5M5 10.5a4.5 4.5 0 0 1 6 0M2.8 7.6a7.5 7.5 0 0 1 3.7-1.6M9.6 6a7.5 7.5 0 0 1 3.6 1.6M8 13h.01" />,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.7 1.8 1.7 9.2 0 11M8 2.5c-1.7 1.8-1.7 9.2 0 11" /></>,
  bell: <path d="M4.2 10.8V7a3.8 3.8 0 0 1 7.6 0v3.8l1 1.4H3.2l1-1.4ZM6.6 13.5a1.5 1.5 0 0 0 2.8 0" />,
  folder: <path d="M2.5 4.5a1 1 0 0 1 1-1H6l1.4 1.5h5.1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7.5Z" />,
  agent: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3.2 13.3a4.8 4.8 0 0 1 9.6 0" /></>,
  test: <path d="M6 2.8h4M6.8 2.8v3.6L3.6 12a1 1 0 0 0 .9 1.5h7a1 1 0 0 0 .9-1.5L9.2 6.4V2.8" />,
  run: <path d="M5 3.4 12.6 8 5 12.6V3.4Z" />,
  kbd: <><rect x="2.2" y="4" width="11.6" height="8" rx="1.5" /><path d="M4.8 6.8h.5M7.8 6.8h.5M10.8 6.8h.5M5.3 9.5h5.4" /></>,
  doc: <path d="M4 2.5h5.2l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1ZM9 2.7v3h3M5.5 8.5h5M5.5 11h3.5" />,
  pkg: <path d="M8 2.2 13 4.8v6.4L8 13.8 3 11.2V4.8L8 2.2ZM3 4.8 8 7.5l5-2.7M8 7.5v6.3" />,
  scope: <path d="M4.5 3.5v9M4.5 7.5h4.5a2.5 2.5 0 0 1 2.5 2.5v2.5M9.5 10.5l2 2 2-2" />,
  alert: <path d="M8 2.6 13.8 13H2.2L8 2.6ZM8 6.5v3M8 11.3h.01" />,
  lock: <><rect x="3.5" y="7" width="9" height="6.2" rx="1.2" /><path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7" /></>,
  bug: <path d="M8 5v8M5.2 6.5h5.6v3.7a2.8 2.8 0 0 1-5.6 0V6.5ZM6.2 6.5a1.8 1.8 0 0 1 3.6 0M3 8h2.2M10.8 8H13M3.5 11l1.8-.8M12.5 11l-1.8-.8" />,
  chat: <path d="M3 4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5.8a1 1 0 0 1-1 1H6.5L3.5 13v-2.2H4a1 1 0 0 1-1-1V4Z" />,
  signout: <path d="M6 2.8H4a1 1 0 0 0-1 1v8.4a1 1 0 0 0 1 1h2M10 5l3 3-3 3M13 8H6.5" />
};

export function UiIcon({ name, size = 16 }: { name: UiIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function StatusIcon({ kind, progress = 0 }: { kind: StatusIconKind; progress?: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  if (kind === 'done') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="var(--st-done)" />
        <path d="M5.2 8.2 7.1 10.1 11 6.2" fill="none" stroke="var(--panel)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'rework') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--st-rework)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.3M12.5 2.9v2.3h-2.3" />
      </svg>
    );
  }
  if (kind === 'crit') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="var(--st-crit)" />
        <path d="M8 4.6v4.1M8 10.9h.01" stroke="var(--panel)" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'hold') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--st-todo)" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
        <path d="M6.4 5.7v4.6M9.6 5.7v4.6" />
      </svg>
    );
  }
  if (kind === 'gone') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--st-todo)" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
        <path d="M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4" />
      </svg>
    );
  }
  if (kind === 'todo') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--st-todo)" strokeWidth="1.5" strokeDasharray="2.3 2" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
      </svg>
    );
  }
  const color = kind === 'dev' ? 'var(--st-dev)' : kind === 'review' ? 'var(--st-review)' : 'var(--st-you)';
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="1.5" opacity=".32" />
      <circle cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="1.7" strokeDasharray={`${c * progress} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" />
    </svg>
  );
}

export function ProgressRing({ done, total }: { done: number; total: number }) {
  if (!total) return <StatusIcon kind="todo" />;
  if (done >= total) return <StatusIcon kind="done" />;
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--line-2)" strokeWidth="1.6" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeDasharray={`${(c * done) / total} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" />
    </svg>
  );
}

export function Avatar({ name, initials, isYou = false }: { name?: string | null; initials?: string; isYou?: boolean }) {
  if (!name) return <span className="av none" aria-hidden="true" />;
  return (
    <span className={`av ${isYou ? 'you' : ''}`} title={name} aria-hidden="true">
      {initials ?? name.slice(0, 2).toUpperCase()}
    </span>
  );
}
