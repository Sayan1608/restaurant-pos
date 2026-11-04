import { describe, expect, it } from 'vitest';

import {
  AccessTokenClaimsSchema,
  AuthSessionSchema,
  EmailSchema,
  PasswordLoginRequestSchema,
  PasswordSchema,
  PinLoginRequestSchema,
  PinSchema,
  ROLE_RANK,
  RoleSchema,
} from './auth.js';
import { AuditQuerySchema, AuditLogEntrySchema } from './audit.js';
import { PairingCodeSchema, PairDeviceRequestSchema } from './devices.js';
import { CreateStaffRequestSchema, StaffUserSchema, UpdateStaffRequestSchema } from './staff.js';

const UUID = '11111111-1111-1111-1111-111111111111';

describe('RoleSchema', () => {
  it.each(['OWNER', 'MANAGER', 'CASHIER'])('accepts %s', (role) => {
    expect(RoleSchema.parse(role)).toBe(role);
  });

  it.each(['owner', 'ADMIN', 'SUPERUSER', ''])('rejects %s', (role) => {
    expect(RoleSchema.safeParse(role).success).toBe(false);
  });

  it('ranks roles for comparison without granting implicit privilege', () => {
    // The rank is for display and comparison only. Route access is declared
    // explicitly per endpoint; see the note on the Roles decorator.
    expect(ROLE_RANK.OWNER).toBeGreaterThan(ROLE_RANK.MANAGER);
    expect(ROLE_RANK.MANAGER).toBeGreaterThan(ROLE_RANK.CASHIER);
  });
});

describe('PinSchema', () => {
  it.each(['1234', '12345', '123456', '0000'])('accepts %s', (pin) => {
    expect(PinSchema.parse(pin)).toBe(pin);
  });

  it.each([
    ['too short', '123'],
    ['too long', '1234567'],
    ['letters', 'abcd'],
    ['mixed', '12a4'],
    ['spaces', '12 4'],
    ['empty', ''],
    ['a unicode digit lookalike', '１２３４'],
  ])('rejects %s', (_label, pin) => {
    expect(PinSchema.safeParse(pin).success).toBe(false);
  });

  it('explains the rule in its message', () => {
    const parsed = PinSchema.safeParse('1');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/4 to 6 digits/);
    }
  });
});

describe('PasswordSchema', () => {
  it('accepts a long passphrase', () => {
    expect(PasswordSchema.parse('correct horse battery staple')).toBeTruthy();
  });

  it('rejects a short password even if it looks complex', () => {
    // Length over composition rules: "P@ssw0rd!" is both complex and terrible.
    expect(PasswordSchema.safeParse('P@ssw0rd!').success).toBe(false);
  });

  it('states the minimum length', () => {
    const parsed = PasswordSchema.safeParse('short');
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/at least 12 characters/);
    }
  });
});

describe('EmailSchema', () => {
  it('normalises case and whitespace', () => {
    // Otherwise "Owner@Example.com" and "owner@example.com" would be two
    // different accounts.
    expect(EmailSchema.parse('  Owner@Example.COM ')).toBe('owner@example.com');
  });

  it.each(['not-an-email', '@example.com', 'a@', ''])('rejects %s', (value) => {
    expect(EmailSchema.safeParse(value).success).toBe(false);
  });
});

describe('login requests', () => {
  it('accepts a password login', () => {
    expect(
      PasswordLoginRequestSchema.parse({ email: 'o@example.com', password: 'anything' }),
    ).toEqual({ email: 'o@example.com', password: 'anything' });
  });

  it('does not apply the password policy at sign-in', () => {
    // Validating length here would tell an attacker that a short guess is not
    // even worth checking -- and would lock out anyone whose password predates
    // a policy change.
    expect(
      PasswordLoginRequestSchema.safeParse({ email: 'o@example.com', password: 'x' }).success,
    ).toBe(true);
  });

  it('requires a cashier id alongside the PIN', () => {
    // Name-then-PIN: the id is what lets PINs stay non-unique and private.
    expect(PinLoginRequestSchema.safeParse({ pin: '1234' }).success).toBe(false);
    expect(PinLoginRequestSchema.safeParse({ staffUserId: UUID, pin: '1234' }).success).toBe(true);
  });

  it('rejects a cashier id that is not a uuid', () => {
    expect(PinLoginRequestSchema.safeParse({ staffUserId: 'c2', pin: '1234' }).success).toBe(false);
  });
});

describe('AuthSessionSchema', () => {
  const session = {
    accessToken: 'a.b.c',
    refreshToken: 'opaque',
    accessTokenExpiresAt: new Date().toISOString(),
    refreshTokenExpiresAt: new Date().toISOString(),
    staff: {
      id: UUID,
      name: 'Priya Menon',
      email: null,
      role: 'CASHIER',
      tenantId: UUID,
      outletId: UUID,
    },
    device: { id: UUID, name: 'Counter Till 1' },
  };

  it('accepts a cashier session on a till', () => {
    expect(AuthSessionSchema.parse(session).device?.name).toBe('Counter Till 1');
  });

  it('accepts a manager session with no device', () => {
    expect(AuthSessionSchema.parse({ ...session, device: null }).device).toBeNull();
  });

  it('requires the device id to be a uuid', () => {
    expect(
      AuthSessionSchema.safeParse({ ...session, device: { id: 'd1', name: 'x' } }).success,
    ).toBe(false);
  });
});

describe('AccessTokenClaimsSchema', () => {
  it('accepts claims with a device', () => {
    const claims = {
      sub: UUID,
      tid: UUID,
      oid: UUID,
      role: 'CASHIER',
      did: UUID,
      iat: 1,
      exp: 2,
    };
    expect(AccessTokenClaimsSchema.parse(claims).did).toBe(UUID);
  });

  it('accepts claims without a device', () => {
    const claims = { sub: UUID, tid: UUID, oid: UUID, role: 'OWNER', iat: 1, exp: 2 };
    expect(AccessTokenClaimsSchema.parse(claims).did).toBeUndefined();
  });

  it('rejects claims missing the tenancy scope', () => {
    // Tenancy comes from the token, so a token without it must be unusable
    // rather than defaulted to something.
    expect(
      AccessTokenClaimsSchema.safeParse({ sub: UUID, role: 'OWNER', iat: 1, exp: 2 }).success,
    ).toBe(false);
  });
});

describe('CreateStaffRequestSchema', () => {
  it('accepts a cashier with a PIN', () => {
    expect(
      CreateStaffRequestSchema.safeParse({ name: 'Priya', role: 'CASHIER', pin: '1234' }).success,
    ).toBe(true);
  });

  it('accepts a manager with an email and password', () => {
    expect(
      CreateStaffRequestSchema.safeParse({
        name: 'Vikram',
        role: 'MANAGER',
        email: 'v@example.com',
        password: 'a-long-enough-password',
      }).success,
    ).toBe(true);
  });

  const issuePaths = (input: unknown): string[] => {
    const parsed = CreateStaffRequestSchema.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
  };

  it('requires a PIN for a cashier', () => {
    expect(issuePaths({ name: 'Priya', role: 'CASHIER' })).toContain('pin');
  });

  it('refuses to give a cashier a password', () => {
    // A cashier with a password could sign in from anywhere, which defeats the
    // device binding the PIN relies on.
    expect(
      issuePaths({ name: 'Priya', role: 'CASHIER', pin: '1234', password: 'a-long-password-x' }),
    ).toContain('password');
  });

  it('requires an email and password for an owner or manager', () => {
    const paths = issuePaths({ name: 'Vikram', role: 'MANAGER' });
    expect(paths).toContain('email');
    expect(paths).toContain('password');
  });

  it('trims the name', () => {
    const parsed = CreateStaffRequestSchema.parse({
      name: '  Priya Menon  ',
      role: 'CASHIER',
      pin: '1234',
    });
    expect(parsed.name).toBe('Priya Menon');
  });

  it('rejects an empty name', () => {
    expect(issuePaths({ name: '   ', role: 'CASHIER', pin: '1234' })).toContain('name');
  });
});

describe('UpdateStaffRequestSchema', () => {
  it('accepts a single field', () => {
    expect(UpdateStaffRequestSchema.safeParse({ name: 'New Name' }).success).toBe(true);
    expect(UpdateStaffRequestSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('allows clearing an email', () => {
    expect(UpdateStaffRequestSchema.safeParse({ email: null }).success).toBe(true);
  });

  it('rejects an empty update rather than performing a no-op write', () => {
    expect(UpdateStaffRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('StaffUserSchema', () => {
  it('describes whether credentials exist, never the credentials', () => {
    const staff = StaffUserSchema.parse({
      id: UUID,
      outletId: UUID,
      name: 'Priya',
      email: null,
      role: 'CASHIER',
      hasPassword: false,
      hasPin: true,
      isActive: true,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    });

    expect(staff.hasPin).toBe(true);
    expect(Object.keys(staff)).not.toContain('pinHash');
    expect(Object.keys(staff)).not.toContain('passwordHash');
  });
});

describe('PairingCodeSchema', () => {
  it('normalises case and whitespace', () => {
    expect(PairingCodeSchema.parse('  bss5bypt  ')).toBe('BSS5BYPT');
  });

  it.each([
    ['too short', 'BSS5BYP'],
    ['too long', 'BSS5BYPTX'],
    ['a confusable zero', 'BSS5BYP0'],
    ['a confusable letter O', 'BSS5BYPO'],
    ['a confusable one', 'BSS5BYP1'],
    ['a confusable I', 'BSS5BYPI'],
    ['punctuation', 'BSS5-YPT'],
    ['empty', ''],
  ])('rejects %s', (_label, code) => {
    expect(PairingCodeSchema.safeParse(code).success).toBe(false);
  });

  it('is applied by the pair request', () => {
    expect(PairDeviceRequestSchema.safeParse({ code: 'nope' }).success).toBe(false);
    expect(PairDeviceRequestSchema.parse({ code: 'bss5bypt' }).code).toBe('BSS5BYPT');
  });
});

describe('AuditQuerySchema', () => {
  it('defaults the page size', () => {
    expect(AuditQuerySchema.parse({}).limit).toBe(50);
  });

  it('coerces a limit that arrives as a query string', () => {
    expect(AuditQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it.each(['0', '201', '-1', 'all'])('rejects a limit of %s', (limit) => {
    expect(AuditQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('accepts the filters a manager actually uses', () => {
    const parsed = AuditQuerySchema.parse({
      action: 'auth.',
      actorStaffId: UUID,
      outcome: 'FAILURE',
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      cursor: UUID,
      limit: '10',
    });
    expect(parsed.outcome).toBe('FAILURE');
    expect(parsed.action).toBe('auth.');
  });

  it('rejects a non-ISO date rather than guessing a format', () => {
    expect(AuditQuerySchema.safeParse({ from: '2026-11-04' }).success).toBe(false);
  });

  it('rejects an invented outcome', () => {
    expect(AuditQuerySchema.safeParse({ outcome: 'MAYBE' }).success).toBe(false);
  });
});

describe('AuditLogEntrySchema', () => {
  it('accepts an entry with no actor, as a device action has', () => {
    const entry = AuditLogEntrySchema.parse({
      id: UUID,
      outletId: UUID,
      actorType: 'DEVICE',
      actorStaffId: null,
      actorLabel: null,
      action: 'device.pair',
      entityType: 'Device',
      entityId: UUID,
      before: null,
      after: { name: 'Counter Till 1' },
      outcome: 'SUCCESS',
      reason: null,
      ip: '127.0.0.1',
      deviceId: UUID,
      requestId: 'req_1',
      createdAt: new Date().toISOString(),
    });

    // At pairing time nobody is signed in, so the actor is the terminal.
    expect(entry.actorType).toBe('DEVICE');
    expect(entry.actorStaffId).toBeNull();
  });
});
