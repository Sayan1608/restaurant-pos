import type { AuthSession, SessionDevice, SessionStaff } from '@pos/contracts';

/**
 * Where credentials live on the till.
 *
 * Deliberate choices, because this is the part of a POS most likely to be got
 * wrong:
 *
 * - **The access token stays in memory only.** It is the thing that actually
 *   authorises requests, it lasts fifteen minutes, and keeping it out of
 *   storage means a persisted-XSS payload cannot read it after the fact.
 *
 * - **The refresh token goes in localStorage.** It has to survive a page
 *   reload, or a cashier loses their session every time the tablet reloads
 *   mid-shift. An httpOnly cookie would be stronger against XSS, but brings
 *   CSRF handling and a shared-origin requirement; for a dedicated till on a
 *   kiosk browser, this is the trade-off taken knowingly. Revisit if the POS
 *   ever runs in a general-purpose browser alongside other sites.
 *
 * - **The device token also goes in localStorage**, because persisting is its
 *   entire purpose: a till is paired once and remembers itself.
 *
 * Every access is wrapped: storage throws in private mode and in some kiosk
 * configurations, and a till that cannot read localStorage must still boot.
 */

const KEYS = {
  refreshToken: 'pos.refreshToken',
  deviceToken: 'pos.deviceToken',
  deviceName: 'pos.deviceName',
} as const;

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable. The session still works for as long as the tab
    // lives; it just will not survive a reload.
  }
}

/** In memory only, by design. */
let accessToken: string | null = null;
let accessTokenExpiresAt: number | null = null;

export const sessionStore = {
  getAccessToken(): string | null {
    return accessToken;
  },

  /** True when the access token is missing or close enough to expiry that a
   * request would probably race it. */
  isAccessTokenStale(skewMs = 30_000): boolean {
    if (!accessToken || accessTokenExpiresAt === null) return true;
    return accessTokenExpiresAt - Date.now() <= skewMs;
  },

  getRefreshToken(): string | null {
    return readLocal(KEYS.refreshToken);
  },

  getDeviceToken(): string | null {
    return readLocal(KEYS.deviceToken);
  },

  getDeviceName(): string | null {
    return readLocal(KEYS.deviceName);
  },

  saveSession(session: AuthSession): void {
    accessToken = session.accessToken;
    accessTokenExpiresAt = new Date(session.accessTokenExpiresAt).getTime();
    writeLocal(KEYS.refreshToken, session.refreshToken);
  },

  saveDevice(token: string, device: SessionDevice): void {
    writeLocal(KEYS.deviceToken, token);
    writeLocal(KEYS.deviceName, device.name);
  },

  /** Forget the person, keep the till paired. */
  clearSession(): void {
    accessToken = null;
    accessTokenExpiresAt = null;
    writeLocal(KEYS.refreshToken, null);
  },

  /** Forget the till as well. Used when the server says it was unpaired. */
  clearDevice(): void {
    writeLocal(KEYS.deviceToken, null);
    writeLocal(KEYS.deviceName, null);
  },
};

export type { SessionDevice, SessionStaff };
