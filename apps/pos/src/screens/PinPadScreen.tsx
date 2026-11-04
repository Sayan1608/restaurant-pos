import { type CashierSummary, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@pos/contracts';
import { useEffect, useState } from 'react';

import { Button, Card, ErrorNote } from '../components/ui';
import { ApiClientError } from '../lib/api';
import { authApi } from '../lib/auth-client';
import { useAuth } from '../lib/auth-context';

/**
 * The shift-change screen: pick a name, type a PIN.
 *
 * Name-then-PIN rather than PIN-only is a security decision as much as a UX
 * one. A bare PIN login would force PINs to be unique across the outlet so the
 * server could tell who typed it -- which leaks that a PIN is taken, and caps
 * the number of cashiers at the size of the PIN space.
 */
export function PinPadScreen() {
  const { signInWithPin, deviceName, error, clearError, unpair } = useAuth();

  const [cashiers, setCashiers] = useState<CashierSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CashierSummary | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authApi
      .listCashiers()
      .then((list) => {
        if (!cancelled) setCashiers(list.cashiers);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setLoadError(
          caught instanceof ApiClientError ? caught.message : 'Could not load the cashier list.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (value: string): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await signInWithPin(selected.id, value);
    } catch {
      // Surfaced via context error; clear the entry so the next try starts fresh.
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const press = (digit: string): void => {
    clearError();
    const next = `${pin}${digit}`.slice(0, PIN_MAX_LENGTH);
    setPin(next);
    // Auto-submit at the maximum length: one less tap per shift change, and the
    // cashier never wonders whether the till registered the last digit.
    if (next.length === PIN_MAX_LENGTH) void submit(next);
  };

  if (!selected) {
    return (
      <div className="flex min-h-full flex-col p-4">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Who is on the till?</h1>
            <p className="text-sm text-ink-muted">{deviceName ?? 'This till'}</p>
          </div>
          <Button variant="ghost" onClick={unpair} className="min-h-11 px-3 text-sm">
            Unpair
          </Button>
        </header>

        {loadError && <ErrorNote>{loadError}</ErrorNote>}

        {cashiers === null && !loadError && <p className="text-sm text-ink-muted">Loading…</p>}

        {cashiers?.length === 0 && (
          <Card>
            <p className="text-sm text-ink-muted">
              No cashiers have been set up for this outlet yet. A manager can add them from the
              staff screen.
            </p>
          </Card>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {cashiers?.map((cashier) => (
            <button
              key={cashier.id}
              type="button"
              onClick={() => {
                clearError();
                setSelected(cashier);
                setPin('');
              }}
              className="min-h-20 rounded-card border border-border-subtle bg-surface p-4 text-left text-lg font-semibold transition hover:border-brand hover:bg-surface-raised"
            >
              {cashier.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center p-4">
      <div className="mb-5 text-center">
        <p className="text-sm text-ink-muted">Signing in as</p>
        <h1 className="text-xl font-semibold">{selected.name}</h1>
      </div>

      <div
        className="mb-4 flex justify-center gap-3"
        role="status"
        aria-label={`${pin.length} of ${PIN_MAX_LENGTH} digits entered`}
      >
        {Array.from({ length: PIN_MAX_LENGTH }, (_, index) => (
          <span
            key={index}
            className={`size-3.5 rounded-full transition ${
              index < pin.length ? 'bg-brand' : 'bg-surface-raised'
            }`}
          />
        ))}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <PinKey key={digit} onClick={() => press(digit)} disabled={busy}>
            {digit}
          </PinKey>
        ))}

        <PinKey
          onClick={() => {
            clearError();
            setPin('');
          }}
          disabled={busy}
          muted
        >
          Clear
        </PinKey>
        <PinKey onClick={() => press('0')} disabled={busy}>
          0
        </PinKey>
        <PinKey
          onClick={() => {
            clearError();
            setPin((value) => value.slice(0, -1));
          }}
          disabled={busy}
          muted
        >
          ⌫
        </PinKey>
      </div>

      <Button
        onClick={() => void submit(pin)}
        disabled={pin.length < PIN_MIN_LENGTH || busy}
        className="mt-4 w-full"
      >
        {busy ? 'Checking…' : 'Sign in'}
      </Button>

      <Button
        variant="ghost"
        onClick={() => {
          clearError();
          setSelected(null);
          setPin('');
        }}
        className="mt-2 w-full"
      >
        Back
      </Button>
    </div>
  );
}

function PinKey({
  children,
  onClick,
  disabled,
  muted = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-h-16 rounded-xl border border-border-subtle text-2xl font-semibold tabular transition active:scale-95 disabled:opacity-50 ${
        muted ? 'bg-surface text-ink-muted text-base' : 'bg-surface-raised text-ink'
      }`}
    >
      {children}
    </button>
  );
}
