import type { AuthSession } from '@pos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionStore } from './session-store';

const session = (overrides: Partial<AuthSession> = {}): AuthSession => ({
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  staff: {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Priya Menon',
    email: null,
    role: 'CASHIER',
    tenantId: '22222222-2222-2222-2222-222222222222',
    outletId: '33333333-3333-3333-3333-333333333333',
  },
  device: null,
  ...overrides,
});

describe('sessionStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    sessionStore.clearSession();
    sessionStore.clearDevice();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the access token in memory and never in storage', () => {
    sessionStore.saveSession(session());

    expect(sessionStore.getAccessToken()).toBe('access-token-value');

    // This is the deliberate split: the token that actually authorises requests
    // must not be readable by a persisted XSS payload after the fact.
    const stored = JSON.stringify(window.localStorage);
    expect(stored).not.toContain('access-token-value');
  });

  it('persists the refresh token, so a reload does not end the shift', () => {
    sessionStore.saveSession(session());
    expect(sessionStore.getRefreshToken()).toBe('refresh-token-value');
    expect(window.localStorage.getItem('pos.refreshToken')).toBe('refresh-token-value');
  });

  it('treats a missing access token as stale', () => {
    expect(sessionStore.isAccessTokenStale()).toBe(true);
  });

  it('treats a fresh access token as usable', () => {
    sessionStore.saveSession(session());
    expect(sessionStore.isAccessTokenStale()).toBe(false);
  });

  it('treats a token expiring within the skew window as stale', () => {
    sessionStore.saveSession(
      session({ accessTokenExpiresAt: new Date(Date.now() + 5_000).toISOString() }),
    );

    // Refreshing a few seconds early avoids a guaranteed 401 round-trip
    // mid-sale.
    expect(sessionStore.isAccessTokenStale()).toBe(true);
    expect(sessionStore.isAccessTokenStale(1_000)).toBe(false);
  });

  it('treats an already-expired token as stale', () => {
    sessionStore.saveSession(
      session({ accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );
    expect(sessionStore.isAccessTokenStale()).toBe(true);
  });

  describe('device pairing', () => {
    it('remembers the till across reloads', () => {
      sessionStore.saveDevice('device-token-value', { id: 'd1', name: 'Counter Till 1' });

      expect(sessionStore.getDeviceToken()).toBe('device-token-value');
      expect(sessionStore.getDeviceName()).toBe('Counter Till 1');
    });

    it('signing out forgets the person but keeps the till paired', () => {
      sessionStore.saveDevice('device-token-value', { id: 'd1', name: 'Counter Till 1' });
      sessionStore.saveSession(session());

      sessionStore.clearSession();

      // A shift change must not look like a fresh install.
      expect(sessionStore.getAccessToken()).toBeNull();
      expect(sessionStore.getRefreshToken()).toBeNull();
      expect(sessionStore.getDeviceToken()).toBe('device-token-value');
    });

    it('unpairing forgets the till too', () => {
      sessionStore.saveDevice('device-token-value', { id: 'd1', name: 'Counter Till 1' });
      sessionStore.clearDevice();

      expect(sessionStore.getDeviceToken()).toBeNull();
      expect(sessionStore.getDeviceName()).toBeNull();
    });
  });

  describe('when storage is unavailable', () => {
    it('reads as empty rather than throwing', () => {
      // Private mode, blocked site data and some kiosk configurations all make
      // these throw. A till that cannot read storage must still boot.
      vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });

      expect(() => sessionStore.getRefreshToken()).not.toThrow();
      expect(sessionStore.getRefreshToken()).toBeNull();
      expect(sessionStore.getDeviceToken()).toBeNull();
    });

    it('writes are swallowed, and the in-memory session still works', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      expect(() => sessionStore.saveSession(session())).not.toThrow();
      // The session survives for as long as the tab lives; it just will not
      // survive a reload.
      expect(sessionStore.getAccessToken()).toBe('access-token-value');
    });

    it('clearing is swallowed too', () => {
      vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });

      expect(() => sessionStore.clearSession()).not.toThrow();
      expect(sessionStore.getAccessToken()).toBeNull();
    });
  });
});
