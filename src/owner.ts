import { DomainError, type Actor } from './contracts.js';
import type { Store } from './store.js';

interface OwnerState { id: 'owner'; claimed: boolean; claimedAt?: string; resetAt?: string }
const owners = (store: Store) => store.list<Actor>('actor').filter(actor => actor.role === 'human' && !actor.principalId);
export const isOwnerClaimed = (store: Store) => store.list<OwnerState>('owner_state')[0]?.claimed ?? false;
export const alreadyClaimed = 'The owner credential was already taken over. If it was not this computer\'s desktop app, stop the service, then run "node dist/cli.js owner-reset" in the installation folder';

export function issueOwnerCredential(store: Store, previous?: string) {
  return store.db.transaction(() => {
    if (!store.list<OwnerState>('owner_state').length) store.put<OwnerState>('owner_state', { id: 'owner', claimed: false });
    if (previous) {
      try {
        const actor = store.authenticate(previous);
        if (actor.role === 'human' && !actor.principalId) return previous;
      } catch (error) { if (!(error instanceof DomainError)) throw error; }
    }
    const owner = owners(store)[0];
    if (!owner) return store.bootstrap().token;
    store.revokeActor(owner.id);
    return store.token(owner);
  }).immediate();
}

function revokeOwnerAccess(store: Store, now: number) {
  for (const actor of owners(store)) store.revokeActor(actor.id);
  for (const session of store.list<{ id: string; revokedAt?: number }>('ui_session'))
    store.put('ui_session', { ...session, revokedAt: now });
  for (const pairing of store.list<{ id: string; usedAt?: number }>('ui_pairing'))
    if (pairing.usedAt === undefined) store.put('ui_pairing', { ...pairing, usedAt: now });
}

export function claimOwner(store: Store, actor: Actor, credentialHash: string, now: number) {
  return store.db.transaction(() => {
    if (isOwnerClaimed(store)) throw new DomainError('OWNER_ALREADY_CLAIMED', alreadyClaimed, 409);
    revokeOwnerAccess(store, now);
    store.db.prepare('INSERT INTO credentials(hash,actor_id) VALUES(?,?)').run(credentialHash, actor.id);
    const claimedAt = new Date(now).toISOString();
    store.put<OwnerState>('owner_state', { id: 'owner', claimed: true, claimedAt });
    return { ok: true, claimedAt };
  }).immediate();
}

export function resetOwner(store: Store, now = Date.now()) {
  store.db.transaction(() => {
    revokeOwnerAccess(store, now);
    store.put<OwnerState>('owner_state', { id: 'owner', claimed: false, resetAt: new Date(now).toISOString() });
  }).immediate();
}
