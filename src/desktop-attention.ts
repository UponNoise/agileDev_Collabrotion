export interface AttentionSnapshot {
  blockingCount: number;
  paused: boolean;
  stale: boolean;
}

export function attentionSnapshot(value: unknown): AttentionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop attention snapshot.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || Object.keys(input).some(key => !['blockingCount', 'paused', 'stale'].includes(key)) || !Number.isSafeInteger(input.blockingCount) || (input.blockingCount as number) < 0 || (input.blockingCount as number) > 1000000 || typeof input.paused !== 'boolean' || typeof input.stale !== 'boolean') {
    throw new Error('Invalid desktop attention snapshot.');
  }
  return { blockingCount: input.blockingCount as number, paused: input.paused, stale: input.stale };
}

export function desktopCapabilities(platform: string) {
  return {
    taskbarFlash: platform === 'win32',
    taskbarOverlay: platform === 'win32',
    osNotifications: { available: false, reason: 'PORTABLE_INSTALLATION_UNVERIFIED' }
  };
}

export class DesktopAttention {
  private count = 0;
  private flashing = false;

  update(snapshot: AttentionSnapshot, focused: boolean) {
    if (snapshot.paused || snapshot.stale || focused || snapshot.blockingCount === 0) this.flashing = false;
    else if (snapshot.blockingCount > this.count) this.flashing = true;
    this.count = snapshot.blockingCount;
    return this.current();
  }

  focus() { this.flashing = false; return this.current(); }
  clear() { this.count = 0; this.flashing = false; return this.current(); }
  current() { return { blockingCount: this.count, flashing: this.flashing }; }
}
