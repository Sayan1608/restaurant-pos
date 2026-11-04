import type { Me } from '@pos/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiClientError } from './api';
import { authApi, refreshSession } from './auth-client';
import { sessionStore } from './session-store';

/**
 * Who is signed in, and on what till.
 *
 * The till has two independent pieces of state, which is why this is not a
 * single boolean:
 *
 *  - **Is the device paired?** Long-lived, survives reloads and shift changes.
 *  - **Is someone signed in?** Short-lived, changes every shift change.
 *
 * An unpaired device must show the pairing screen; a paired one with nobody
 * signed in shows the PIN pad. Collapsing the two would make a shift change
 * look like a fresh install.
 */

export type AuthPhase = 'restoring' | 'unpaired' | 'locked' | 'signed-in';

export interface AuthState {
  phase: AuthPhase;
  me: Me | null;
  deviceName: string | null;
  error: string | null;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signInWithPin: (staffUserId: string, pin: string) => Promise<void>;
  pairDevice: (code: string) => Promise<void>;
  signOut: () => Promise<void>;
  unpair: () => void;
  clearError: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>('restoring');
  const [me, setMe] = useState<Me | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(sessionStore.getDeviceName());
  const [error, setError] = useState<string | null>(null);

  /** Decide which screen to show when there is no live session. */
  const settleUnauthenticated = useCallback(() => {
    setMe(null);
    setPhase(sessionStore.getDeviceToken() ? 'locked' : 'unpaired');
  }, []);

  /**
   * On load, try to turn a stored refresh token back into a session. This is
   * what makes a tablet reload invisible to the cashier.
   */
  useEffect(() => {
    let cancelled = false;

    const restore = async (): Promise<void> => {
      if (!sessionStore.getRefreshToken()) {
        if (!cancelled) settleUnauthenticated();
        return;
      }

      const ok = await refreshSession();
      if (cancelled) return;

      if (!ok) {
        settleUnauthenticated();
        return;
      }

      try {
        const current = await authApi.me();
        if (cancelled) return;
        setMe(current);
        setDeviceName(current.device?.name ?? sessionStore.getDeviceName());
        setPhase('signed-in');
      } catch {
        if (!cancelled) settleUnauthenticated();
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, [settleUnauthenticated]);

  const describe = (caught: unknown): string =>
    caught instanceof ApiClientError
      ? caught.message
      : caught instanceof Error
        ? caught.message
        : 'Something went wrong.';

  const afterSignIn = useCallback(async () => {
    const current = await authApi.me();
    setMe(current);
    setDeviceName(current.device?.name ?? sessionStore.getDeviceName());
    setPhase('signed-in');
    setError(null);
  }, []);

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        await authApi.loginWithPassword(email, password);
        await afterSignIn();
      } catch (caught) {
        setError(describe(caught));
        throw caught;
      }
    },
    [afterSignIn],
  );

  const signInWithPin = useCallback(
    async (staffUserId: string, pin: string) => {
      setError(null);
      try {
        await authApi.loginWithPin(staffUserId, pin);
        await afterSignIn();
      } catch (caught) {
        // A revoked till must drop back to the pairing screen, not sit on a
        // PIN pad that can never succeed.
        if (caught instanceof ApiClientError && caught.code === 'DEVICE_REVOKED') {
          sessionStore.clearDevice();
          setDeviceName(null);
          setPhase('unpaired');
        }
        setError(describe(caught));
        throw caught;
      }
    },
    [afterSignIn],
  );

  const pairDevice = useCallback(async (code: string) => {
    setError(null);
    try {
      const paired = await authApi.pairDevice(code);
      setDeviceName(paired.device.name);
      setPhase('locked');
    } catch (caught) {
      setError(describe(caught));
      throw caught;
    }
  }, []);

  const signOut = useCallback(async () => {
    await authApi.logout();
    settleUnauthenticated();
    setError(null);
  }, [settleUnauthenticated]);

  const unpair = useCallback(() => {
    sessionStore.clearSession();
    sessionStore.clearDevice();
    setMe(null);
    setDeviceName(null);
    setPhase('unpaired');
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      phase,
      me,
      deviceName,
      error,
      signInWithPassword,
      signInWithPin,
      pairDevice,
      signOut,
      unpair,
      clearError: () => setError(null),
    }),
    [phase, me, deviceName, error, signInWithPassword, signInWithPin, pairDevice, signOut, unpair],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
