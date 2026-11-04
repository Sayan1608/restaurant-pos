import { useState } from 'react';

import { Button, Card, ErrorNote, Field, Screen } from '../components/ui';
import { useAuth } from '../lib/auth-context';

/** Email and password, for owners and managers. */
export function LoginScreen({ onBack }: { onBack?: () => void }) {
  const { signInWithPassword, error, clearError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await signInWithPassword(email.trim(), password);
    } catch {
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Manager sign in" subtitle="Owners and managers sign in with an email address.">
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Email"
            type="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="off"
            autoCorrect="off"
            value={email}
            onChange={(event) => {
              clearError();
              setEmail(event.target.value);
            }}
            autoFocus
            required
          />

          <Field
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              clearError();
              setPassword(event.target.value);
            }}
            required
          />

          {error && <ErrorNote>{error}</ErrorNote>}

          <Button type="submit" disabled={busy || !email || !password} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {onBack && (
          <Button variant="ghost" onClick={onBack} className="mt-3 w-full">
            Back to the till
          </Button>
        )}
      </Card>
    </Screen>
  );
}
