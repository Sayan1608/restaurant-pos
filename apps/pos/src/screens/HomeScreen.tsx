import { formatPaise, fromRupees } from '@pos/money';

import { Button, Card, RoleBadge } from '../components/ui';
import { useAuth } from '../lib/auth-context';
import { useHealth } from '../lib/useHealth';

const ROADMAP = [
  { step: 1, title: 'Foundation & skeleton', state: 'done' },
  { step: 2, title: 'Staff auth, devices & audit log', state: 'done' },
  { step: 3, title: 'Menu management', state: 'next' },
  { step: 4, title: 'Customer identity by phone', state: 'todo' },
  { step: 5, title: 'Order & cart engine', state: 'todo' },
  { step: 6, title: 'Pricing, tax & discount engine', state: 'todo' },
  { step: 7, title: 'Payment & invoice numbering', state: 'todo' },
  { step: 8, title: 'Invoice document & public link', state: 'todo' },
  { step: 9, title: 'WhatsApp delivery', state: 'todo' },
  { step: 10, title: 'Email, day close & hardening', state: 'todo' },
] as const;

/**
 * What a signed-in till shows today.
 *
 * The session banner at the top is the real Step 2 deliverable: who is on the
 * till, on which device, at which outlet, with one tap to hand over. The order
 * screen that replaces the body arrives in Step 5.
 */
export function HomeScreen() {
  const { me, signOut } = useAuth();
  const health = useHealth();

  if (!me) return null;

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-border-subtle bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand font-bold text-brand-ink">
            P
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{me.staff.name}</span>
              <RoleBadge role={me.staff.role} />
            </div>
            <p className="truncate text-xs text-ink-muted">
              {me.outlet.name}
              {me.device ? ` · ${me.device.name}` : ' · no till paired'}
            </p>
          </div>

          <span
            role="status"
            className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised px-3 py-1.5 text-xs font-medium"
          >
            <span
              className={`size-2 rounded-full ${
                health.phase === 'connected' && health.readiness?.status === 'ok'
                  ? 'bg-ok'
                  : health.phase === 'unreachable'
                    ? 'bg-bad'
                    : 'bg-warn'
              }`}
              aria-hidden="true"
            />
            {health.phase === 'connected'
              ? health.readiness?.status === 'ok'
                ? 'Online'
                : 'Degraded'
              : health.phase === 'unreachable'
                ? 'Offline'
                : 'Checking'}
          </span>

          <Button variant="ghost" onClick={() => void signOut()} className="min-h-11 px-3 text-sm">
            Hand over
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 p-4">
        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            This session
          </h2>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="Signed in as" value={`${me.staff.name} (${me.staff.role})`} />
            <Row label="Email" value={me.staff.email ?? 'PIN only'} />
            <Row label="Outlet" value={me.outlet.name} />
            <Row label="Till" value={me.device?.name ?? 'Not paired'} />
            <Row label="Currency" value={me.outlet.currency} />
            <Row label="Timezone" value={me.outlet.timezone} />
          </dl>
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Money primitives
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            All amounts are integer paise, formatted only at the edge.
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
        </Card>

        <Card>
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
        </Card>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border-subtle/50 py-1 last:border-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
