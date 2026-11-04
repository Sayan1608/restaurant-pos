import { useState } from 'react';

import { AuthProvider, useAuth } from './lib/auth-context';
import { HomeScreen } from './screens/HomeScreen';
import { LoginScreen } from './screens/LoginScreen';
import { PairDeviceScreen } from './screens/PairDeviceScreen';
import { PinPadScreen } from './screens/PinPadScreen';

/**
 * Which screen the till shows, derived from two independent facts: whether the
 * device is paired, and whether somebody is signed in.
 *
 *   unpaired  -> pair the till (manager's code)
 *   locked    -> PIN pad, with a way through to manager sign-in
 *   signed-in -> the POS itself
 *
 * Deliberately a state machine rather than routes: the till is a kiosk, and a
 * URL that can be typed into is a URL that can skip the PIN pad. Routing
 * arrives with the admin screens in Step 3, which do belong on their own URLs.
 */
function Shell() {
  const { phase } = useAuth();
  const [managerSignIn, setManagerSignIn] = useState(false);

  if (phase === 'restoring') {
    return (
      <div className="grid min-h-full place-items-center p-4">
        <p className="text-sm text-ink-muted">Starting up…</p>
      </div>
    );
  }

  if (phase === 'signed-in') return <HomeScreen />;

  if (phase === 'unpaired') {
    return managerSignIn ? (
      <LoginScreen onBack={() => setManagerSignIn(false)} />
    ) : (
      <>
        <PairDeviceScreen />
        <div className="pb-8 text-center">
          <button
            type="button"
            onClick={() => setManagerSignIn(true)}
            className="min-h-11 rounded-lg px-4 text-sm font-medium text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          >
            Sign in as a manager instead
          </button>
        </div>
      </>
    );
  }

  // Paired, nobody signed in.
  return managerSignIn ? (
    <LoginScreen onBack={() => setManagerSignIn(false)} />
  ) : (
    <>
      <PinPadScreen />
      <div className="pb-8 text-center">
        <button
          type="button"
          onClick={() => setManagerSignIn(true)}
          className="min-h-11 rounded-lg px-4 text-sm font-medium text-ink-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Manager sign in
        </button>
      </div>
    </>
  );
}

export function App() {
  return (
    <AuthProvider>
      <div className="min-h-full bg-surface-sunken text-ink">
        <Shell />
      </div>
    </AuthProvider>
  );
}
