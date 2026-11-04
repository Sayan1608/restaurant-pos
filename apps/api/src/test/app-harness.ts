import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../app.module.js';
import { HashingService } from '../auth/hashing.service.js';
import { configureApp } from '../bootstrap.js';
import { ENV } from '../config/config.module.js';
import { type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Boots the real application for integration tests.
 *
 * Two deliberate choices:
 *
 * - It uses `configureApp`, the same function main.ts calls, so a test can
 *   never pass against wiring production does not have.
 *
 * - It replaces the rate-limit guard by default. The sign-in limits are tight
 *   on purpose (10/minute), which is correct in production and useless in a
 *   suite that performs dozens of logins -- the tests would fail on 429s that
 *   have nothing to do with what they assert. Rate limiting gets its own test
 *   with `throttle: true`.
 */
export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  env: Env;
  hashing: HashingService;
  close: () => Promise<void>;
}

export async function bootTestApp(options: { throttle?: boolean } = {}): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [AppModule] });

  if (!options.throttle) {
    /*
     * Override the *storage*, not the guard.
     *
     * ThrottlerGuard is registered through APP_GUARD, so its DI token is
     * APP_GUARD rather than the class -- `overrideGuard(ThrottlerGuard)`
     * silently matches nothing and the real limits stay in force. Replacing
     * the counter it reads is the seam that actually works, and it leaves the
     * guard itself in the pipeline so route wiring is still exercised.
     */
    builder.overrideProvider(ThrottlerStorage).useValue({
      increment: async () => ({
        totalHits: 1,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    });
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  const env = app.get<Env>(ENV);
  configureApp(app, env);
  await app.init();

  const prisma = app.get(PrismaService);
  const hashing = app.get(HashingService);

  return {
    app,
    prisma,
    env,
    hashing,
    close: async () => {
      await app.close();
    },
  };
}

export interface OutletFixture {
  tenantId: string;
  outletId: string;
  /** Deletes everything this fixture created, in dependency order. */
  cleanup: () => Promise<void>;
}

/**
 * A tenant and outlet of its own for each suite.
 *
 * Isolation matters more than speed here: these tests lock accounts, revoke
 * tokens and count audit rows, so sharing the seeded outlet would make them
 * interfere with each other and with whatever a developer has been clicking on.
 */
export async function createOutlet(prisma: PrismaService): Promise<OutletFixture> {
  const suffix = randomUUID().slice(0, 8);

  const tenant = await prisma.tenant.create({ data: { name: `test-tenant-${suffix}` } });
  const outlet = await prisma.outlet.create({
    data: {
      tenantId: tenant.id,
      name: `test-outlet-${suffix}`,
      legalName: 'Test Foods Pvt Ltd',
      gstin: '29ABCDE1234F1Z5',
    },
  });

  return {
    tenantId: tenant.id,
    outletId: outlet.id,
    cleanup: async () => {
      // Children first: the schema uses Restrict on the tenant and outlet
      // relations precisely so this order cannot be got wrong silently.
      await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.refreshToken.deleteMany({
        where: { staffUser: { tenantId: tenant.id } },
      });
      await prisma.pairingCode.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.device.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.staffUser.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.outlet.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
    },
  };
}

export interface StaffFixture {
  id: string;
  name: string;
  email: string | null;
  password?: string;
  pin?: string;
}

export async function createStaff(
  prisma: PrismaService,
  hashing: HashingService,
  outlet: OutletFixture,
  spec: {
    role: 'OWNER' | 'MANAGER' | 'CASHIER';
    name?: string;
    email?: string;
    password?: string;
    pin?: string;
    isActive?: boolean;
  },
): Promise<StaffFixture> {
  const suffix = randomUUID().slice(0, 8);
  const name = spec.name ?? `${spec.role.toLowerCase()}-${suffix}`;
  const email = spec.role === 'CASHIER' ? null : (spec.email ?? `${suffix}@test.local`);

  const created = await prisma.staffUser.create({
    data: {
      tenantId: outlet.tenantId,
      outletId: outlet.outletId,
      name,
      email,
      role: spec.role,
      isActive: spec.isActive ?? true,
      passwordHash: spec.password ? await hashing.hashSecret(spec.password) : null,
      pinHash: spec.pin ? await hashing.hashSecret(spec.pin) : null,
    },
  });

  return {
    id: created.id,
    name,
    email,
    ...(spec.password ? { password: spec.password } : {}),
    ...(spec.pin ? { pin: spec.pin } : {}),
  };
}

/** Pair a device directly, for tests that need a till without walking the
 * manager-issues-a-code flow every time. */
export async function pairDeviceDirectly(
  prisma: PrismaService,
  hashing: HashingService,
  outlet: OutletFixture,
  name = 'Test Till',
): Promise<{ id: string; token: string }> {
  const token = hashing.generateOpaqueToken();
  const device = await prisma.device.create({
    data: {
      tenantId: outlet.tenantId,
      outletId: outlet.outletId,
      name,
      tokenHash: hashing.fingerprint(token),
    },
  });
  return { id: device.id, token };
}
