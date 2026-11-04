import { Reflector } from '@nestjs/core';
import type { Role } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import { ApiException } from '../common/api-exception.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators.js';
import { RolesGuard } from './roles.guard.js';

/**
 * The authorization rule, in isolation.
 *
 * Worth unit-testing separately from the endpoints because the *absence* of a
 * `@Roles()` decorator is itself a decision -- it means "any signed-in staff
 * member" -- and that default needs pinning down.
 */
function contextFor(options: { role?: Role; required?: Role[]; isPublic?: boolean }) {
  const metadata = new Map<string, unknown>();
  if (options.required) metadata.set(ROLES_KEY, options.required);
  if (options.isPublic) metadata.set(IS_PUBLIC_KEY, true);

  const reflector = {
    getAllAndOverride: (key: string) => metadata.get(key),
  } as unknown as Reflector;

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () =>
        options.role
          ? { auth: { staff: { role: options.role, id: 'x', name: 'x' }, device: null } }
          : {},
    }),
  };

  return { guard: new RolesGuard(reflector), context: context as never };
}

describe('RolesGuard', () => {
  it('lets a public route through without looking at roles', () => {
    const { guard, context } = contextFor({ isPublic: true });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows any authenticated role when no roles are declared', () => {
    // The deliberate default: a route that does not narrow is open to all
    // signed-in staff.
    for (const role of ['OWNER', 'MANAGER', 'CASHIER'] as Role[]) {
      const { guard, context } = contextFor({ role });
      expect(guard.canActivate(context)).toBe(true);
    }
  });

  it('allows an empty roles list the same way', () => {
    const { guard, context } = contextFor({ role: 'CASHIER', required: [] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it.each([
    ['OWNER', ['OWNER'], true],
    ['MANAGER', ['OWNER', 'MANAGER'], true],
    ['CASHIER', ['OWNER', 'MANAGER'], false],
    ['MANAGER', ['OWNER'], false],
    ['CASHIER', ['CASHIER'], true],
  ] as Array<[Role, Role[], boolean]>)('%s against %j -> %s', (role, required, expected) => {
    const { guard, context } = contextFor({ role, required });

    if (expected) {
      expect(guard.canActivate(context)).toBe(true);
    } else {
      expect(() => guard.canActivate(context)).toThrow(ApiException);
    }
  });

  it('does not grant an owner manager-only routes implicitly', () => {
    // There is no role hierarchy on purpose: a route for managers is written
    // `@Roles('OWNER', 'MANAGER')`. Implicit inheritance is how an owner-only
    // action quietly becomes manager-accessible later.
    const { guard, context } = contextFor({ role: 'OWNER', required: ['MANAGER'] });
    expect(() => guard.canActivate(context)).toThrow(/needs MANAGER access/);
  });

  it('explains what was required and what the caller is', () => {
    const { guard, context } = contextFor({ role: 'CASHIER', required: ['OWNER', 'MANAGER'] });

    try {
      guard.canActivate(context);
      expect.unreachable('should have thrown');
    } catch (error) {
      const exception = error as ApiException;
      expect(exception.code).toBe('FORBIDDEN');
      expect(exception.message).toContain('OWNER or MANAGER');
      expect(exception.message).toContain('CASHIER');
    }
  });

  it('refuses rather than crashing if it somehow runs before authentication', () => {
    const { guard, context } = contextFor({ required: ['OWNER'] });

    try {
      guard.canActivate(context);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiException).code).toBe('UNAUTHENTICATED');
    }
  });
});
