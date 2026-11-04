import { describe, expect, it } from 'vitest';

import { AuditService } from './audit.service.js';

/**
 * Redaction, tested on its own.
 *
 * The audit table is the one place in the system that deliberately keeps a copy
 * of changed data, which makes it the easiest place to persist a credential
 * forever by accident. These tests are the guarantee that it cannot happen,
 * whatever a future caller passes in.
 */
describe('AuditService.redact()', () => {
  const redact = (value: unknown) => AuditService.redact(value) as Record<string, unknown>;

  it.each([
    'password',
    'passwordHash',
    'pin',
    'pinHash',
    'PIN',
    'Password',
    'secret',
    'clientSecret',
    'token',
    'refreshToken',
    'deviceToken',
    'tokenHash',
    'authorization',
    'cookie',
  ])('redacts a key called %s', (key) => {
    expect(redact({ [key]: 'the-actual-secret' })[key]).toBe('[redacted]');
  });

  it('keeps the keys an investigator actually needs', () => {
    const result = redact({
      name: 'Priya Menon',
      role: 'CASHIER',
      email: 'priya@example.test',
      isActive: false,
    });

    expect(result).toEqual({
      name: 'Priya Menon',
      role: 'CASHIER',
      email: 'priya@example.test',
      isActive: false,
    });
  });

  it('redacts nested secrets, not just top-level ones', () => {
    const result = redact({
      staff: { name: 'Priya', credentials: { pinHash: '$argon2id$...', password: 'hunter2' } },
    });

    const staff = result.staff as { name: string; credentials: Record<string, unknown> };
    expect(staff.credentials.pinHash).toBe('[redacted]');
    expect(staff.credentials.password).toBe('[redacted]');
    expect(staff.name).toBe('Priya');
  });

  it('redacts inside arrays', () => {
    const result = AuditService.redact([{ pin: '1234' }, { pin: '5678' }]) as Array<
      Record<string, unknown>
    >;

    expect(result).toEqual([{ pin: '[redacted]' }, { pin: '[redacted]' }]);
  });

  it('serialises dates, which JSON columns otherwise mangle', () => {
    const when = new Date('2026-11-04T06:00:00.000Z');
    expect(redact({ lockedUntil: when }).lockedUntil).toBe('2026-11-04T06:00:00.000Z');
  });

  it('stringifies bigint, which JSON.stringify throws on', () => {
    expect(redact({ count: 10n }).count).toBe('10');
  });

  it('passes scalars through', () => {
    const result = redact({ a: 1, b: 'two', c: true, d: null });
    expect(result).toEqual({ a: 1, b: 'two', c: true, d: null });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('handles %s without throwing', (_label, value) => {
    expect(() => AuditService.redact(value)).not.toThrow();
  });

  it('stops at a sane depth instead of recursing forever', () => {
    // A self-referential object would otherwise hang the request that is
    // trying to record what happened.
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    expect(() => AuditService.redact(cyclic)).not.toThrow();
    expect(JSON.stringify(AuditService.redact(cyclic))).toContain('[too deep]');
  });

  it('redacts a realistic staff snapshot', () => {
    const row = {
      id: 'b2c3d4e5-0000-0000-0000-000000000000',
      name: 'Priya Menon',
      email: null,
      role: 'CASHIER',
      passwordHash: null,
      pinHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
      failedAttempts: 2,
      isActive: true,
    };

    const result = redact(row);
    expect(result.pinHash).toBe('[redacted]');
    expect(result.passwordHash).toBe('[redacted]');
    expect(JSON.stringify(result)).not.toContain('argon2');
    expect(result.failedAttempts).toBe(2);
  });
});
