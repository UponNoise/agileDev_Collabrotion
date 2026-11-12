import { useEffect, useRef, useState } from 'react';
import { usePreferences } from './Preferences';

interface DesktopCapabilities {
  taskbarFlash: boolean;
  taskbarOverlay: boolean;
  osNotifications: { available: false; reason: 'PORTABLE_INSTALLATION_UNVERIFIED' };
}
interface AttentionSnapshot { blockingCount: number; paused: boolean; stale: boolean }
interface DesktopBridge {
  capabilities(): Promise<DesktopCapabilities>;
  updateAttention(snapshot: AttentionSnapshot): Promise<void>;
  onOpenDecisions(callback: () => void): () => void;
}
declare global { interface Window { agiledevDesktop?: DesktopBridge } }

export function useDesktopAttention({ authenticated, blockingCount, stale, openDecisions }: {
  authenticated: boolean;
  blockingCount: number | undefined;
  stale: boolean;
  openDecisions(): void;
}) {
  const { attentionPaused } = usePreferences();
  const bridge = window.agiledevDesktop;
  const [capabilities, setCapabilities] = useState<DesktopCapabilities | null>(null);
  const [capabilityFailed, setCapabilityFailed] = useState(false);
  const [updateFailed, setUpdateFailed] = useState(false);
  const [subscriptionFailed, setSubscriptionFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const open = useRef({ authenticated, openDecisions });
  open.current = { authenticated, openDecisions };
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    setCapabilities(null);
    Promise.resolve().then(() => bridge.capabilities()).then(result => {
      if (active) { setCapabilities(result); setCapabilityFailed(false); }
    }).catch(() => { if (active) setCapabilityFailed(true); });
    return () => { active = false; };
  }, [bridge, retry]);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const snapshot = { blockingCount: authenticated ? blockingCount ?? 0 : 0, paused: attentionPaused, stale: authenticated && (stale || blockingCount === undefined) };
    Promise.resolve().then(() => bridge.updateAttention(snapshot)).then(() => {
      if (active) setUpdateFailed(false);
    }).catch(() => { if (active) setUpdateFailed(true); });
    return () => { active = false; };
  }, [bridge, authenticated, blockingCount, attentionPaused, stale, retry]);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = bridge.onOpenDecisions(() => { if (active && open.current.authenticated) open.current.openDecisions(); });
      setSubscriptionFailed(false);
    } catch { setSubscriptionFailed(true); }
    return () => {
      active = false;
      try { unsubscribe?.(); } catch {}
    };
  }, [bridge, retry]);
  useEffect(() => {
    if (!bridge) return;
    return () => { void Promise.resolve().then(() => bridge.updateAttention({ blockingCount: 0, paused: false, stale: false })).catch(() => {}); };
  }, [bridge]);
  return { available: !!bridge, capabilities, failed: capabilityFailed || updateFailed || subscriptionFailed, retry: () => setRetry(value => value + 1) };
}

export function DesktopAttentionSettings({ attention }: { attention: ReturnType<typeof useDesktopAttention> }) {
  const { attentionPaused, setAttentionPaused, t } = usePreferences();
  return <section className="appearance" aria-labelledby="desktop-attention-title">
    <h2 id="desktop-attention-title">{t('Desktop attention')}</h2>
    <label className="check-row">
      <input type="checkbox" checked={attentionPaused} onChange={event => setAttentionPaused(event.target.checked)} />
      <span>{t('Pause desktop attention')}</span>
    </label>
    <p className="muted">{t('Pausing stops attention flashes. The in-app count, title, and passive taskbar indicator remain available.')}</p>
    {!attention.available ? <p>{t('Taskbar attention requires the desktop app. In-app counts and the title remain available in this browser.')}</p> : attention.failed ? <div role="alert">
      <p>{t('Desktop attention could not connect. In-app decisions remain available.')}</p>
      <button type="button" onClick={attention.retry}>{t('Retry desktop attention')}</button>
    </div> : !attention.capabilities ? <p role="status">{t('Checking desktop attention capabilities…')}</p> : <dl className="metadata">
      <dt>{t('Taskbar flash')}</dt><dd>{t(attention.capabilities.taskbarFlash ? 'Available' : 'Unavailable')}</dd>
      <dt>{t('Taskbar indicator')}</dt><dd>{t(attention.capabilities.taskbarOverlay ? 'Available' : 'Unavailable')}</dd>
    </dl>}
    <p>{t('Operating-system notifications')}: {t(attention.available ? 'Unavailable in this portable package: installation support has not been verified.' : 'Unavailable in the browser; no notification permission is requested.')}</p>
    <p className="muted">{t('Attention only opens the current decision view. It never approves or accepts work.')}</p>
  </section>;
}
