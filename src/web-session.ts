import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Actor, DomainError } from './contracts.js';
import { Store, hash } from './store.js';

interface Pairing {
  id: string;
  actorId: string;
  expiresAt: number;
  usedAt?: number;
}
interface BrowserSession {
  id: string;
  actorId: string;
  expiresAt: number;
  revokedAt?: number;
}
export const browserCookie = 'agiledev_ui';
export class WebSessions {
  private failures: number[] = [];
  constructor(
    private store: Store,
    private now = Date.now
  ) {}
  createPairing(actor: Actor) {
    if (actor.role !== 'human')
      throw new DomainError('ROLE_DENIED', 'Only the local owner can pair a human browser', 403);
    const code = randomBytes(18).toString('base64url');
    const expiresAt = this.now() + 300000;
    this.store.put<Pairing>('ui_pairing', { id: hash(code), actorId: actor.principalId ?? actor.id, expiresAt });
    return { code, expiresAt };
  }
  pair(code: string) {
    this.failures = this.failures.filter((at) => at > this.now() - 60000);
    if (this.failures.length >= 10)
      throw new DomainError('PAIRING_RATE_LIMIT', 'Too many unsuccessful pairing attempts; wait one minute', 429);
    try {
      return this.store.db
        .transaction(() => {
          let pairing: Pairing;
          try {
            pairing = this.store.get<Pairing>('ui_pairing', hash(code));
          } catch {
            throw new DomainError('PAIRING_INVALID', 'Pairing code is invalid, expired, or already used', 401);
          }
          if (pairing.usedAt !== undefined || pairing.expiresAt <= this.now())
            throw new DomainError('PAIRING_INVALID', 'Pairing code is invalid, expired, or already used', 401);
          const owner = this.store.get<Actor>('actor', pairing.actorId);
          if (owner.role !== 'human')
            throw new DomainError('ROLE_DENIED', 'Pairing does not identify the local owner', 403);
          const actor: Actor = {
            id: randomUUID(),
            role: 'human',
            name: 'Local owner browser',
            principalId: owner.id,
            workspaceIds: [],
            sessionId: randomUUID()
          };
          const cookie = randomBytes(32).toString('base64url');
          const expiresAt = this.now() + 28800000;
          this.store.put('actor', actor);
          this.store.put<BrowserSession>('ui_session', { id: hash(cookie), actorId: actor.id, expiresAt });
          pairing.usedAt = this.now();
          this.store.put('ui_pairing', pairing);
          return { actor, cookie, expiresAt, csrf: this.csrf(cookie) };
        })
        .immediate();
    } catch (error) {
      this.failures.push(this.now());
      throw error;
    }
  }
  cookie(header?: string) {
    const value = header
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${browserCookie}=`))
      ?.slice(browserCookie.length + 1);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  authenticate(cookie: string) {
    let session: BrowserSession;
    try {
      session = this.store.get<BrowserSession>('ui_session', hash(cookie));
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Pair this browser with the local owner', 401);
    }
    if (session.revokedAt !== undefined || session.expiresAt <= this.now())
      throw new DomainError('UNAUTHENTICATED', 'The browser session expired; pair again', 401);
    const actor = this.store.get<Actor>('actor', session.actorId);
    if (actor.role !== 'human') throw new DomainError('ROLE_DENIED', 'Human browser authority is unavailable', 403);
    return actor;
  }
  csrf(cookie: string) {
    return hash(`agiledev-ui-csrf-v1:${cookie}`);
  }
  checkCsrf(cookie: string, value?: string) {
    if (!value || !/^[a-f0-9]{64}$/.test(value) || !timingSafeEqual(Buffer.from(value), Buffer.from(this.csrf(cookie))))
      throw new DomainError('CSRF_DENIED', 'Reload this page before making a browser change', 403);
  }
  revoke(cookie: string) {
    const session = this.store.get<BrowserSession>('ui_session', hash(cookie));
    session.revokedAt = this.now();
    this.store.put('ui_session', session);
  }
}
