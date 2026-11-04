import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/**
 * The small shared vocabulary the Step 2 screens are built from.
 *
 * Two constraints drive every size here: a cashier is standing up, in a hurry,
 * possibly with wet hands, so touch targets are at least 44px; and the till may
 * be a 10" tablet, so nothing assumes a wide viewport.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-card border border-border-subtle bg-surface p-5 shadow-lg shadow-black/20 ${className}`}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const tones = {
    primary: 'bg-brand text-brand-ink hover:brightness-110 disabled:brightness-75',
    ghost: 'border border-border-subtle text-ink hover:bg-surface-raised',
    danger: 'border border-bad/50 text-bad hover:bg-bad/10',
  } as const;

  return (
    <button
      className={`min-h-12 rounded-xl px-5 text-base font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${tones[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink-muted">{label}</span>
      <input
        className="min-h-12 w-full rounded-xl border border-border-subtle bg-surface-sunken px-4 text-base text-ink placeholder:text-ink-muted/60"
        {...rest}
      />
      {hint && <span className="mt-1.5 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

/** Errors are shown, never swallowed: a cashier needs to know why the till
 * refused them, in words they can act on. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm font-medium text-bad"
    >
      {children}
    </p>
  );
}

export function Screen({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-brand text-xl font-bold text-brand-ink">
            P
          </span>
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function RoleBadge({ role }: { role: string }) {
  const tone =
    role === 'OWNER'
      ? 'bg-brand/20 text-brand'
      : role === 'MANAGER'
        ? 'bg-ok/20 text-ok'
        : 'bg-surface-raised text-ink-muted';
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-semibold uppercase ${tone}`}>{role}</span>
  );
}
