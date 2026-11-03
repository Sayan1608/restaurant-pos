import { formatPaise, fromRupees } from '@pos/money';

import { useHealth } from './lib/useHealth';

/**
 * Step 1 shell.
 *
 * Deliberately not a mock of the till: it shows the one thing that is actually
 * built -- the API connection and its dependencies -- plus the build roadmap.
 * The real POS screens arrive in Steps 4 and 5 and will replace this view.
 */

const ROADMAP = [
  { step: 1, title: 'Foundation & skeleton', state: 'done' },
  { step: 2, title: 'Staff auth, devices & audit log', state: 'next' },
  { step: 3, title: 'Menu management', state: 'todo' },
  { step: 4, title: 'Customer identity by phone', state: 'todo' },
  { step: 5, title: 'Order & cart engine', state: 'todo' },
  { step: 6, title: 'Pricing, tax & discount engine', state: 'todo' },
  { step: 7, title: 'Payment & invoice numbering', state: 'todo' },
  { step: 8, title: 'Invoice document & public link', state: 'todo' },
  { step: 9, title: 'WhatsApp delivery', state: 'todo' },
  { step: 10, title: 'Email, day close & hardening', state: 'todo' },
] as const;

export function App() {
  const health = useHealth();

  return (
    <div className="min-h-full bg-surface-sunken text-ink">
      <header className="sticky top-0 z-10 border-b border-border-subtle bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand font-bold text-brand-ink">
            P
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight">Restaurant POS</h1>
            <p className="truncate text-xs text-ink-muted">Step 1 — foundation</p>
          </div>
          <ConnectionPill health={health} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <section className="rounded-card border border-border-subtle bg-surface p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
              System status
            </h2>
            <button
              type="button"
              onClick={health.refresh}
              className="min-h-11 rounded-lg px-3 text-sm font-medium text-ink-muted hover:bg-surface-raised hover:text-ink"
            >
              Re-check
            </button>
          </div>

          {health.phase === 'checking' && <p className="text-sm text-ink-muted">Checking…</p>}

          {health.phase === 'unreachable' && (
            <div className="rounded-lg border border-bad/40 bg-bad/10 p-3">
              <p className="text-sm font-medium text-bad">API unreachable</p>
              <p className="mt-1 text-sm text-ink-muted">{health.error}</p>
              <p className="mt-2 text-xs text-ink-muted">
                Start it with <code className="text-ink">pnpm db:up</code> then{' '}
                <code className="text-ink">pnpm dev</code>.
              </p>
            </div>
          )}

          {health.phase === 'connected' && health.liveness && (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row label="Service" value={health.liveness.service} />
              <Row label="Version" value={health.liveness.version} />
              <Row label="Uptime" value={`${health.liveness.uptimeSeconds}s`} />
              <Row
                label="Readiness"
                value={health.readiness?.status ?? 'degraded'}
                tone={health.readiness?.status === 'ok' ? 'ok' : 'bad'}
              />
              {health.readiness?.dependencies.map((dependency) => (
                <Row
                  key={dependency.name}
                  label={dependency.name}
                  value={
                    dependency.status === 'up'
                      ? `up${dependency.latencyMs === undefined ? '' : ` · ${dependency.latencyMs}ms`}`
                      : (dependency.error ?? 'down')
                  }
                  tone={dependency.status === 'up' ? 'ok' : 'bad'}
                />
              ))}
            </dl>
          )}
        </section>

        <section className="rounded-card border border-border-subtle bg-surface p-4">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Money primitives
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            All amounts are integer paise. Shown here because it is the one piece of shared
            arithmetic the whole system depends on.
          </p>
          <ul className="space-y-1 text-sm">
            {['0.07', '249.50', '1234.5', '100000'].map((rupees) => (
              <li key={rupees} className="flex justify-between gap-4">
                <code className="text-ink-muted">fromRupees('{rupees}')</code>
                <span className="tabular font-medium">
                  {formatPaise(fromRupees(rupees))}
                  <span className="ml-2 text-xs text-ink-muted">{fromRupees(rupees)} paise</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-card border border-border-subtle bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Build roadmap
          </h2>
          <ol className="space-y-1">
            {ROADMAP.map((item) => (
              <li key={item.step} className="flex items-center gap-3 py-1 text-sm">
                <span
                  className={[
                    'grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold',
                    item.state === 'done'
                      ? 'bg-ok/20 text-ok'
                      : item.state === 'next'
                        ? 'bg-brand/20 text-brand'
                        : 'bg-surface-raised text-ink-muted',
                  ].join(' ')}
                >
                  {item.state === 'done' ? '✓' : item.step}
                </span>
                <span className={item.state === 'todo' ? 'text-ink-muted' : ''}>{item.title}</span>
                {item.state === 'next' && (
                  <span className="ml-auto text-xs font-medium text-brand">next</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border-subtle/50 py-1 last:border-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd
        className={[
          'truncate font-medium',
          tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : '',
        ].join(' ')}
      >
        {value}
      </dd>
    </div>
  );
}

function ConnectionPill({ health }: { health: ReturnType<typeof useHealth> }) {
  const tone =
    health.phase === 'connected'
      ? health.readiness?.status === 'ok'
        ? { dot: 'bg-ok', label: 'Connected' }
        : { dot: 'bg-warn', label: 'Degraded' }
      : health.phase === 'checking'
        ? { dot: 'bg-warn', label: 'Checking' }
        : { dot: 'bg-bad', label: 'Offline' };

  return (
    <span
      role="status"
      className="ml-auto flex shrink-0 items-center gap-2 rounded-full border border-border-subtle bg-surface-raised px-3 py-1.5 text-xs font-medium"
    >
      <span className={`size-2 rounded-full ${tone.dot}`} aria-hidden="true" />
      {tone.label}
    </span>
  );
}
