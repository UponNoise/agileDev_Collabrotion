import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { translate } from './locales';
import type { PartyNames } from './sentences';

export type Locale = 'en' | 'zh-CN';
export type Theme = 'system' | 'light' | 'dark';

interface Preferences {
  locale: Locale;
  theme: Theme;
  zoom: number;
  attentionPaused: boolean;
}

const key = 'agiledev.ui.preferences.v1';
const limit = (value: number) => Math.min(200, Math.max(50, Math.round(value / 5) * 5));
const measureViewport = () => ({
  width: document.documentElement.getBoundingClientRect().width || innerWidth,
  height: innerHeight
});

function parse(value: string | null): Preferences {
  const fallback: Preferences = {
    locale: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
    theme: 'system',
    zoom: 100,
    attentionPaused: false
  };
  try {
    const saved = value ? JSON.parse(value) : null;
    return {
      locale: saved?.locale === 'en' || saved?.locale === 'zh-CN' ? saved.locale : fallback.locale,
      theme: saved?.theme === 'system' || saved?.theme === 'light' || saved?.theme === 'dark' ? saved.theme : 'system',
      zoom: typeof saved?.zoom === 'number' && Number.isFinite(saved.zoom) ? limit(saved.zoom) : 100,
      attentionPaused: typeof saved?.attentionPaused === 'boolean' ? saved.attentionPaused : false
    };
  } catch {
    return fallback;
  }
}

const Context = createContext<{
  locale: Locale;
  theme: Theme;
  zoom: number;
  attentionPaused: boolean;
  setLocale(locale: Locale): void;
  setTheme(theme: Theme): void;
  setZoom(value: number): void;
  setAttentionPaused(paused: boolean): void;
  t(text: string): string;
} | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(() => {
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return parse(null);
    }
  });
  const [viewport, setViewport] = useState(measureViewport);
  const setLocale = useCallback(
    (locale: Locale) => setPreferences((current) => ({ ...current, locale })),
    []
  );
  const setTheme = useCallback(
    (theme: Theme) => setPreferences((current) => ({ ...current, theme })),
    []
  );
  const setZoom = useCallback(
    (value: number) => setPreferences((current) => ({ ...current, zoom: limit(value) })),
    []
  );
  const setAttentionPaused = useCallback(
    (attentionPaused: boolean) => setPreferences((current) => ({ ...current, attentionPaused })),
    []
  );
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(preferences));
    } catch {}
  }, [preferences]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.storageArea === localStorage && event.key === key) setPreferences(parse(event.newValue));
    };
    const resized = () => {
      const next = measureViewport();
      setViewport((current) =>
        Math.abs(current.width - next.width) < 0.1 && current.height === next.height ? current : next
      );
    };
    const observer = new ResizeObserver(resized);
    observer.observe(document.documentElement);
    const wheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || !event.deltaY) return;
      event.preventDefault();
      setPreferences((current) => ({ ...current, zoom: limit(current.zoom + (event.deltaY < 0 ? 5 : -5)) }));
    };
    const reset = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === '0') {
        event.preventDefault();
        setZoom(100);
      }
    };
    window.addEventListener('storage', changed);
    window.addEventListener('resize', resized);
    window.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', reset);
    return () => {
      window.removeEventListener('storage', changed);
      observer.disconnect();
      window.removeEventListener('resize', resized);
      window.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', reset);
    };
  }, [setZoom]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const scale = preferences.zoom / 100;
    const width = viewport.width / scale;
    const height = viewport.height / scale;
    root.lang = preferences.locale;
    if (preferences.theme === 'system') root.removeAttribute('data-theme');
    else root.dataset.theme = preferences.theme;
    root.style.zoom = String(scale);
    root.style.setProperty('--app-width', `${width}px`);
    root.style.setProperty('--app-height', `${height}px`);
    root.dataset.layout =
      width <= 880 ? 'narrow' : width <= 1040 ? 'compact' : width < 1440 ? 'desktop' : 'wide';
    root.dataset.issue = width <= 1180 ? 'stacked' : 'split';
    root.dataset.density = width <= 640 ? 'tight' : 'normal';
  }, [preferences, viewport]);
  const t = useCallback((text: string) => translate(preferences.locale, text), [preferences.locale]);
  const value = useMemo(
    () => ({ ...preferences, setLocale, setTheme, setZoom, setAttentionPaused, t }),
    [preferences, setLocale, setTheme, setZoom, setAttentionPaused, t]
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePreferences() {
  const value = useContext(Context);
  if (!value) throw new Error('PreferencesProvider is required');
  return value;
}

export function useText() {
  return usePreferences().t;
}

export function useRoleWords(): PartyNames {
  const { locale } = usePreferences();
  return useMemo(
    () =>
      locale === 'zh-CN'
        ? { lead: '负责人', pm: 'PM', dev: '开发', qa: '独立测试' }
        : { lead: 'lead', pm: 'PM', dev: 'developer', qa: 'QA' },
    [locale]
  );
}

export function useDateText() {
  const { locale, t } = usePreferences();
  return useCallback(
    (value?: string | number | null) =>
      value ? new Date(value).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) : t('Not recorded'),
    [locale, t]
  );
}
