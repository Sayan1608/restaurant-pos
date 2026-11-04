import {
  type AuthSession,
  AuthSessionSchema,
  type CashierList,
  CashierListSchema,
  HEADERS,
  type Me,
  MeSchema,
  type PairedDevice,
  PairedDeviceSchema,
} from '@pos/contracts';
import { z, type ZodType } from 'zod';

import { ApiClientError, apiRequest, type RequestOptions } from './api';
import { sessionStore } from './session-store';

const V1 = '/v1';

/** A 204 carries no body. Modelled explicitly so the client still validates. */
const NoContentSchema = z.unknown();

/**
 * Authenticated API access.
 *
 * The one piece of real logic here is **transparent refresh**: a request whose
 * access token has expired is retried once after rotating. Without it, a
 * cashier gets a spurious "please sign in" fifteen minutes into every shift.
 *
 * Concurrent callers share a single in-flight refresh. If each request rotated
 * on its own, the second rotation would present a token the first had just
 * replaced -- which the server correctly treats as token theft and responds to
 * by ending every session. A refresh stampede would log the whole till out.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function rotate(): Promise<boolean> {
  const refreshToken = sessionStore.getRefreshToken();
  if (!refreshToken) return false;

  try {
    const session = await apiRequest(`${V1}/auth/refresh`, AuthSessionSchema, {
      method: 'POST',
      body: { refreshToken },
    });
    sessionStore.saveSession(session);
    return true;
  } catch {
    sessionStore.clearSession();
    return false;
  }
}

/** Rotate, coalescing concurrent attempts into one. */
export async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= rotate().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function withAuth(options: RequestOptions = {}): RequestOptions {
  const token = sessionStore.getAccessToken();
  return {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
}

/** A request that carries the staff session and refreshes it when needed. */
export async function authedRequest<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  // Refresh proactively when the token is known to be stale, which avoids a
  // guaranteed 401 round-trip.
  if (sessionStore.isAccessTokenStale() && sessionStore.getRefreshToken()) {
    await refreshSession();
  }

  try {
    return await apiRequest(path, schema, withAuth(options));
  } catch (error) {
    const isExpired =
      error instanceof ApiClientError &&
      (error.code === 'TOKEN_EXPIRED' || error.code === 'UNAUTHENTICATED');

    if (!isExpired) throw error;

    const rotated = await refreshSession();
    if (!rotated) throw error;

    return apiRequest(path, schema, withAuth(options));
  }
}

/** A request that carries the device token instead of a staff session. */
function withDevice(options: RequestOptions = {}): RequestOptions {
  const token = sessionStore.getDeviceToken();
  return {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { [HEADERS.deviceToken]: token } : {}),
    },
  };
}

export const authApi = {
  async loginWithPassword(email: string, password: string): Promise<AuthSession> {
    const session = await apiRequest(`${V1}/auth/login`, AuthSessionSchema, {
      method: 'POST',
      body: { email, password },
    });
    sessionStore.saveSession(session);
    return session;
  },

  async listCashiers(): Promise<CashierList> {
    return apiRequest(`${V1}/auth/cashiers`, CashierListSchema, withDevice());
  },

  async loginWithPin(staffUserId: string, pin: string): Promise<AuthSession> {
    const session = await apiRequest(
      `${V1}/auth/pin`,
      AuthSessionSchema,
      withDevice({ method: 'POST', body: { staffUserId, pin } }),
    );
    sessionStore.saveSession(session);
    return session;
  },

  async pairDevice(code: string): Promise<PairedDevice> {
    const paired = await apiRequest(`${V1}/devices/pair`, PairedDeviceSchema, {
      method: 'POST',
      body: { code },
    });
    sessionStore.saveDevice(paired.deviceToken, {
      id: paired.device.id,
      name: paired.device.name,
    });
    return paired;
  },

  async me(): Promise<Me> {
    return authedRequest(`${V1}/auth/me`, MeSchema);
  },

  async logout(): Promise<void> {
    const refreshToken = sessionStore.getRefreshToken();
    try {
      await authedRequest(`${V1}/auth/logout`, NoContentSchema, {
        method: 'POST',
        body: { refreshToken },
      });
    } catch {
      // Signing out locally must succeed even if the server cannot be reached;
      // the refresh token is revoked server-side when it next appears anyway.
    }
    sessionStore.clearSession();
  },
};
