import type { Device, PairingCodeIssued } from '@pos/contracts';
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, ErrorNote } from '../components/ui';
import { adminApi } from '../lib/admin-client';
import { ApiClientError } from '../lib/api';

/**
 * Till management for owners and managers.
 *
 * The pairing code is the point of this screen. It is shown once, large, with
 * the time remaining, because the manager is about to read it out loud to
 * whoever is holding the tablet -- and the server only keeps its hash, so it
 * genuinely cannot be shown again.
 */
export function TillsSection() {
  const [tills, setTills] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<PairingCodeIssued | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);

  const describe = (caught: unknown): string =>
    caught instanceof ApiClientError
      ? caught.message
      : caught instanceof Error
        ? caught.message
        : 'Something went wrong.';

  const load = useCallback(async () => {
    try {
      const list = await adminApi.listTills();
      setTills(list.devices);
    } catch (caught) {
      setError(describe(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = async (): Promise<void> => {
    const name = deviceName.trim();
    if (!name || busy) return;

    setBusy(true);
    setError(null);
    try {
      setIssued(await adminApi.createPairingCode(name));
      setDeviceName('');
      await load();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.revokeTill(id);
      setConfirmingRevoke(null);
      await load();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Tills</h2>
        <button
          type="button"
          onClick={() => void load()}
          className="min-h-11 rounded-lg px-3 text-sm font-medium text-ink-muted hover:bg-surface-raised hover:text-ink"
        >
          Refresh
        </button>
      </div>

      {issued && <PairingCodeBanner issued={issued} onDone={() => setIssued(null)} />}

      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <input
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void issue();
          }}
          placeholder="Counter Till 1"
          aria-label="New till name"
          maxLength={120}
          className="min-h-12 min-w-0 flex-1 rounded-xl border border-border-subtle bg-surface-sunken px-4 text-base text-ink placeholder:text-ink-muted/60"
        />
        <Button onClick={() => void issue()} disabled={!deviceName.trim() || busy}>
          {busy ? 'Working…' : 'Pair a new till'}
        </Button>
      </div>

      {tills === null && !error && <p className="text-sm text-ink-muted">Loading…</p>}

      {tills?.length === 0 && (
        <p className="text-sm text-ink-muted">
          No tills paired yet. Name one above to get a pairing code, then enter that code on the
          tablet.
        </p>
      )}

      <ul className="divide-y divide-border-subtle/60">
        {tills?.map((till) => (
          <li key={till.id} className="flex flex-wrap items-center gap-3 py-3">
            <span
              className={`size-2 shrink-0 rounded-full ${till.isActive ? 'bg-ok' : 'bg-bad'}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{till.name}</p>
              <p className="truncate text-xs text-ink-muted">
                {till.isActive ? 'Paired' : 'Unpaired'}
                {' · '}
                {till.lastSeenAt
                  ? `last used ${new Date(till.lastSeenAt).toLocaleString()}`
                  : 'never used'}
              </p>
            </div>

            {till.isActive &&
              (confirmingRevoke === till.id ? (
                <span className="flex items-center gap-2">
                  {/* A two-step confirm rather than a browser dialog: a modal
                      blocks the whole page, and unpairing a live till
                      mid-service is worth one deliberate second. */}
                  <Button
                    variant="danger"
                    onClick={() => void revoke(till.id)}
                    disabled={busy}
                    className="min-h-11 px-3 text-sm"
                  >
                    Confirm unpair
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmingRevoke(null)}
                    className="min-h-11 px-3 text-sm"
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setConfirmingRevoke(till.id)}
                  className="min-h-11 px-3 text-sm"
                >
                  Unpair
                </Button>
              ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The code, shown once, with the time remaining. */
function PairingCodeBanner({ issued, onDone }: { issued: PairingCodeIssued; onDone: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.floor((new Date(issued.expiresAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSecondsLeft(
        Math.max(0, Math.floor((new Date(issued.expiresAt).getTime() - Date.now()) / 1000)),
      );
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [issued.expiresAt]);

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  return (
    <div className="mb-4 rounded-card border border-brand/40 bg-brand/10 p-4">
      <p className="text-sm text-ink-muted">
        Enter this code on <span className="font-medium text-ink">{issued.deviceName}</span>
      </p>

      <p className="my-2 select-all text-center text-3xl font-bold tracking-[0.3em] tabular text-brand">
        {issued.code}
      </p>

      <p className="text-center text-xs text-ink-muted" role="status">
        {secondsLeft > 0
          ? `Expires in ${minutes}:${String(seconds).padStart(2, '0')} · single use`
          : 'Expired — create a new one.'}
      </p>

      <div className="mt-3 flex justify-center">
        <Button variant="ghost" onClick={onDone} className="min-h-11 px-3 text-sm">
          Done
        </Button>
      </div>
    </div>
  );
}
