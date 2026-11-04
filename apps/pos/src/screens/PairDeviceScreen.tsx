import { PAIRING_CODE_LENGTH } from '@pos/contracts';
import { useState } from 'react';

import { Button, Card, ErrorNote, Field, Screen } from '../components/ui';
import { useAuth } from '../lib/auth-context';

/**
 * What an unpaired till shows.
 *
 * This is the first screen on a brand-new tablet. It asks for a code a manager
 * generates on their own signed-in screen, which is what stops a tablet that
 * walks out of the building from enrolling itself.
 */
export function PairDeviceScreen() {
  const { pairDevice, error, clearError } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = code.trim().length === PAIRING_CODE_LENGTH;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await pairDevice(code.trim().toUpperCase());
    } catch {
      // Already surfaced through the context's error state.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Pair this till" subtitle="This device is not yet linked to an outlet.">
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Pairing code"
            hint={`${PAIRING_CODE_LENGTH} characters, from a manager. Codes expire after a few minutes.`}
            value={code}
            onChange={(event) => {
              clearError();
              setCode(event.target.value.toUpperCase());
            }}
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={PAIRING_CODE_LENGTH}
            placeholder="ABCD2345"
            className="min-h-14 w-full rounded-xl border border-border-subtle bg-surface-sunken px-4 text-center text-2xl font-semibold tracking-[0.3em] tabular text-ink uppercase placeholder:tracking-normal placeholder:text-ink-muted/40"
          />

          {error && <ErrorNote>{error}</ErrorNote>}

          <Button type="submit" disabled={!ready || busy} className="w-full">
            {busy ? 'Pairing…' : 'Pair till'}
          </Button>
        </form>

        <p className="mt-5 border-t border-border-subtle pt-4 text-xs text-ink-muted">
          A manager creates a code from <span className="text-ink">Settings → Tills</span> on their
          own signed-in device.
        </p>
      </Card>
    </Screen>
  );
}
