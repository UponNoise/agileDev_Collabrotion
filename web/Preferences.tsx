import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { translate } from './locales';

export type Locale = 'en' | 'zh-CN';
interface Preferences {
  locale: Locale;
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
    zoom: 100,
    attentionPaused: false
  };
  try {
    const saved = value ? JSON.parse(value) : null;
    return {
      locale: saved?.locale === 'en' || saved?.locale === 'zh-CN' ? saved.locale : fallback.locale,
      zoom: typeof saved?.zoom === 'number' && Number.isFinite(saved.zoom) ? limit(saved.zoom) : 100,
      attentionPaused: typeof saved?.attentionPaused === 'boolean' ? saved.attentionPaused : false
    };
  } catch {
    return fallback;
  }
}
const Context = createContext<{
  locale: Locale;
  zoom: number;
  attentionPaused: boolean;
  setLocale(locale: Locale): void;
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
  const setZoom = useCallback(
    (value: number) => setPreferences((current) => ({ ...current, zoom: limit(value) })),
    []
  );
  const setAttentionPaused = useCallback(
    (attentionPaused: boolean) => setPreferences(current => ({ ...current, attentionPaused })),
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
    root.lang = preferences.locale;
    root.style.zoom = String(scale);
    root.style.setProperty('--app-width', `${width}px`);
    root.style.setProperty('--app-height', `${viewport.height / scale}px`);
    root.dataset.layout =
      width <= 760 ? 'narrow' : width <= 1150 ? 'compact' : width < 1440 ? 'desktop' : 'wide';
    root.dataset.density = width < 320 ? 'compressed' : 'normal';
  }, [preferences, viewport]);
  const t = useCallback((text: string) => translate(preferences.locale, text), [preferences.locale]);
  const value = useMemo(
    () => ({ ...preferences, setLocale, setZoom, setAttentionPaused, t }),
    [preferences, setLocale, setZoom, setAttentionPaused, t]
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
export function useDateText() {
  const { locale, t } = usePreferences();
  return useCallback(
    (value?: string | number | null) =>
      value ? new Date(value).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN') : t('Not recorded'),
    [locale, t]
  );
}
export function AppearanceSettings() {
  const { locale, zoom, setLocale, setZoom, t } = usePreferences();
  return (
    <section className="appearance" aria-labelledby="appearance-title">
      <h2 id="appearance-title">{t('Language and display')}</h2>
      <p className="muted">
        {t('Saved on this device. These settings do not change project data or agent permissions.')}
      </p>
      <label className="field">
        <span>{t('Interface language')}</span>
        <select
          aria-label={t('Interface language')}
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <div className="zoom-heading">
        <span id="zoom-label">{t('Page zoom')}</span>
        <output aria-live="polite">{zoom}%</output>
      </div>
      <div className="zoom-controls">
        <button
          type="button"
          aria-label={t('Zoom out')}
          disabled={zoom <= 50}
          onClick={() => setZoom(zoom - 5)}
        >
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
        <button
          type="button"
          aria-label={t('Zoom in')}
          disabled={zoom >= 200}
          onClick={() => setZoom(zoom + 5)}
        >
          +
        </button>
        <button type="button" onClick={() => setZoom(100)}>
          {t('Reset to 100%')}
        </button>
      </div>
      <p className="muted">
        {t(
          'Use Ctrl or Command + mouse wheel to zoom. Scroll normally without the modifier. Ctrl/Command + 0 resets zoom.'
        )}
      </p>
      <p className="muted">
        {t(
          'The layout adapts to the window and zoom level. Smaller windows use collapsible navigation and full-page issue details.'
        )}
      </p>
    </section>
  );
}
