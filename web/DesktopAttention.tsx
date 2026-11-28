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
  const enabled = !attentionPaused;
  return (
    <div className="slist">
      <div className="srow">
        <div className="sl">
          <b>{t('Alert me when something waits for me')}</b>
          <small>
            {attention.available
              ? t('Flashes the taskbar and shows the count in the title.')
              : t('Shows the count in the title. Taskbar flashing requires the desktop app.')}
          </small>
        </div>
        <button
          type="button"
          className="sw"
          role="switch"
          aria-checked={enabled}
          aria-label={t('Alert me when something waits for me')}
          onClick={() => setAttentionPaused(enabled)}
        />
      </div>
      {attention.available && attention.failed ? (
        <div className="srow" role="alert">
          <div className="sl">
            <b>{t('Desktop attention could not connect. In-app decisions remain available.')}</b>
          </div>
          <button type="button" className="btn" onClick={attention.retry}>
            {t('Retry desktop attention')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
