/**
 * Development seed: one tenant, one outlet.
 *
 * Idempotent -- running it twice leaves the same single outlet, so it is safe
 * to re-run after a migration. Later steps extend this file with staff, a tax
 * class table and a demo menu.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const env = {
  tenantName: process.env.SEED_TENANT_NAME ?? 'Spice Garden',
  outletName: process.env.SEED_OUTLET_NAME ?? 'Spice Garden - MG Road',
  gstin: process.env.SEED_OUTLET_GSTIN ?? '29ABCDE1234F1Z5',
  currency: process.env.SEED_OUTLET_CURRENCY ?? 'INR',
  timezone: process.env.SEED_OUTLET_TIMEZONE ?? 'Asia/Kolkata',
};

async function main(): Promise<void> {
  const existing = await prisma.tenant.findFirst({ where: { name: env.tenantName } });

  const tenant =
    existing ??
    (await prisma.tenant.create({
      data: { name: env.tenantName },
    }));

  const outlet = await prisma.outlet.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: env.outletName } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: env.outletName,
      legalName: `${env.tenantName} Foods Pvt Ltd`,
      addressLine1: '42 MG Road',
      addressLine2: 'Shanthala Nagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      phone: '+918040001234',
      gstin: env.gstin,
      fssaiLicence: '12345678901234',
      currency: env.currency,
      timezone: env.timezone,
      invoiceFooter: 'Thank you for dining with us. GST included where applicable.',
    },
  });

  console.log(`Seeded tenant  ${tenant.name}  (${tenant.id})`);
  console.log(`Seeded outlet  ${outlet.name}  (${outlet.id})`);
  console.log(`  currency ${outlet.currency}  timezone ${outlet.timezone}  gstin ${outlet.gstin}`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
