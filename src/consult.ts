import { DomainError, type Actor } from './contracts.js';
import type { Store } from './store.js';

interface WakeSettings {
  workspaceId: string;
  enabled: boolean;
  version: number;
}

export function wakeSettings(store: Store, workspaceId: string): WakeSettings {
  const row = store.db.prepare("SELECT data FROM records WHERE kind = 'wake_settings' AND id = ? AND workspace_id = ?")
    .get(workspaceId, workspaceId) as { data: string } | undefined;
  if (!row) return { workspaceId, enabled: false, version: 0 };
  const { enabled, version } = JSON.parse(row.data) as WakeSettings;
  return { workspaceId, enabled, version };
}

export function updateWakeSettings(store: Store, actor: Actor, workspaceId: string, expectedVersion: number, enabled: boolean) {
  const previous = wakeSettings(store, workspaceId);
  if (previous.version !== expectedVersion) {
    throw new DomainError('VERSION_CONFLICT', 'Workspace wake settings changed; reload before retrying', 409, { currentVersion: previous.version });
  }
  const settings: WakeSettings = { workspaceId, enabled, version: previous.version + 1 };
  store.put('wake_settings', { id: workspaceId, ...settings }, workspaceId);
  store.event(workspaceId, actor, 'wake_settings_update', workspaceId, { enabled, previousEnabled: previous.enabled, version: settings.version });
  return { settings };
}
