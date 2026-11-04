import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadRootEnvFile, parseEnv, type Env } from '../config/env.js';
import { PrismaService } from './prisma.service.js';

/**
 * Schema-level tests against a real PostgreSQL.
 *
 * These assert the guarantees the *database* makes, not the ones the
 * application makes. An application-level check can be bypassed by a bug, a
 * script or a future developer; a database constraint cannot. Since these rules
 * protect financial records, they belong in the schema -- and therefore need a
 * test that actually exercises Postgres.
 *
 * Requires the database: `pnpm db:up && pnpm db:migrate`.
 */
describe('tenancy schema (integration)', () => {
  let prisma: PrismaService;
  let env: Env;

  // Namespaced so a failed run can never collide with the seed or with a
  // parallel run, and so cleanup can find exactly its own rows.
  const runId = randomUUID().slice(0, 8);
  const tenantName = `test-tenant-${runId}`;
  const createdTenantIds: string[] = [];

  const outletData = (tenantId: string, name: string) => ({
    tenantId,
    name,
    legalName: 'Test Foods Pvt Ltd',
  });

  beforeAll(async () => {
    loadRootEnvFile();
    env = parseEnv(process.env);
    prisma = new PrismaService(env);
    await prisma.onModuleInit();
  }, 30_000);

  afterAll(async () => {
    if (!prisma) return;
    // Outlets first: the Restrict rule this suite verifies would otherwise
    // block deleting the tenants.
    await prisma.outlet.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    await prisma.onModuleDestroy();
  });

  async function makeTenant(suffix = ''): Promise<string> {
    const tenant = await prisma.tenant.create({
      data: { name: `${tenantName}${suffix}` },
    });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  it('ping() round-trips, which is what readiness reports on', async () => {
    await expect(prisma.ping()).resolves.toBeUndefined();
  });

  it.each([
    ['development', ['warn', 'error']],
    ['production', ['error']],
    ['test', ['error']],
  ] as const)('logs %s levels: %j', (nodeEnv, expected) => {
    expect(PrismaService.logLevelsFor(nodeEnv)).toEqual(expected);
  });

  it('generates a UUID primary key without asking the database for a sequence', async () => {
    const tenantId = await makeTenant('-uuid');
    expect(tenantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('applies the outlet defaults an invoice depends on', async () => {
    const tenantId = await makeTenant('-defaults');

    const outlet = await prisma.outlet.create({
      data: outletData(tenantId, 'Main Counter'),
    });

    // Currency and timezone are stored, never assumed: the business day, the
    // Z-report cut-off and the invoice series all depend on the timezone.
    expect(outlet.currency).toBe('INR');
    expect(outlet.timezone).toBe('Asia/Kolkata');
    expect(outlet.isActive).toBe(true);
    expect(outlet.createdAt).toBeInstanceOf(Date);
    expect(outlet.updatedAt).toBeInstanceOf(Date);
  });

  it('allows a GSTIN-less outlet, which must not claim to be a tax invoice', async () => {
    const tenantId = await makeTenant('-nogst');

    const outlet = await prisma.outlet.create({
      data: outletData(tenantId, 'Kiosk'),
    });

    expect(outlet.gstin).toBeNull();
    expect(outlet.fssaiLicence).toBeNull();
    expect(outlet.invoiceFooter).toBeNull();
  });

  it('stores a full outlet profile including the invoice legal block', async () => {
    const tenantId = await makeTenant('-full');

    const outlet = await prisma.outlet.create({
      data: {
        ...outletData(tenantId, 'MG Road'),
        gstin: '29ABCDE1234F1Z5',
        fssaiLicence: '12345678901234',
        addressLine1: '42 MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        phone: '+918040001234',
        invoiceFooter: 'Thank you for dining with us.',
      },
    });

    expect(outlet.gstin).toBe('29ABCDE1234F1Z5');
    expect(outlet.invoiceFooter).toContain('Thank you');
  });

  it('refuses two outlets with the same name in one tenant', async () => {
    const tenantId = await makeTenant('-dupe');
    await prisma.outlet.create({ data: outletData(tenantId, 'Duplicate') });

    await expect(prisma.outlet.create({ data: outletData(tenantId, 'Duplicate') })).rejects.toThrow(
      /Unique constraint/i,
    );
  });

  it('allows the same outlet name under a different tenant', async () => {
    const first = await makeTenant('-t1');
    const second = await makeTenant('-t2');

    await prisma.outlet.create({ data: outletData(first, 'Shared Name') });

    await expect(
      prisma.outlet.create({ data: outletData(second, 'Shared Name') }),
    ).resolves.toMatchObject({ name: 'Shared Name' });
  });

  it('refuses an outlet pointing at a tenant that does not exist', async () => {
    await expect(
      prisma.outlet.create({ data: outletData(randomUUID(), 'Orphan') }),
    ).rejects.toThrow();
  });

  it('refuses to delete a tenant that still has an outlet', async () => {
    const tenantId = await makeTenant('-restrict');
    await prisma.outlet.create({ data: outletData(tenantId, 'Protected') });

    // onDelete: Restrict. Deleting a tenant must never silently take its
    // outlets -- and therefore its invoice history -- with it.
    await expect(prisma.tenant.delete({ where: { id: tenantId } })).rejects.toThrow();

    expect(await prisma.tenant.findUnique({ where: { id: tenantId } })).not.toBeNull();
    expect(await prisma.outlet.count({ where: { tenantId } })).toBe(1);
  });

  it('moves updatedAt forward on a change', async () => {
    const tenantId = await makeTenant('-touch');
    const outlet = await prisma.outlet.create({ data: outletData(tenantId, 'Touched') });

    const updated = await prisma.outlet.update({
      where: { id: outlet.id },
      data: { name: 'Touched Twice' },
    });

    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(outlet.updatedAt.getTime());
    expect(updated.createdAt.getTime()).toBe(outlet.createdAt.getTime());
  });

  it('rolls an interrupted transaction back completely', async () => {
    const tenantId = await makeTenant('-tx');

    // The pattern Step 7 depends on: an order, its payments and its invoice
    // number are allocated together or not at all.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.outlet.create({ data: outletData(tenantId, 'In Transaction') });
        throw new Error('simulated failure after the write');
      }),
    ).rejects.toThrow('simulated failure');

    expect(await prisma.outlet.count({ where: { tenantId } })).toBe(0);
  });
});
