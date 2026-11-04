/**
 * Development seed: one tenant, one outlet, and the staff needed to sign in.
 *
 * Idempotent -- running it twice leaves the same rows, so it is safe to re-run
 * after a migration. Later steps extend it with a tax class table and a demo
 * menu.
 *
 * The credentials below are obviously fake and are printed to the console on
 * purpose: they exist so a developer can sign in thirty seconds after cloning.
 * They are only ever created when NODE_ENV is not production.
 */
import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaClient, type Role } from '@prisma/client';

const prisma = new PrismaClient();

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const env = {
  tenantName: process.env.SEED_TENANT_NAME ?? 'Spice Garden',
  outletName: process.env.SEED_OUTLET_NAME ?? 'Spice Garden - MG Road',
  gstin: process.env.SEED_OUTLET_GSTIN ?? '29ABCDE1234F1Z5',
  currency: process.env.SEED_OUTLET_CURRENCY ?? 'INR',
  timezone: process.env.SEED_OUTLET_TIMEZONE ?? 'Asia/Kolkata',
  isProduction: process.env.NODE_ENV === 'production',
};

interface SeedStaff {
  name: string;
  role: Role;
  email?: string;
  password?: string;
  pin?: string;
}

const DEMO_STAFF: SeedStaff[] = [
  {
    name: 'Anita Rao',
    role: 'OWNER',
    email: 'owner@spicegarden.test',
    password: 'owner-dev-password-1',
  },
  {
    name: 'Vikram Shah',
    role: 'MANAGER',
    email: 'manager@spicegarden.test',
    password: 'manager-dev-password-1',
  },
  { name: 'Priya Menon', role: 'CASHIER', pin: '1234' },
  { name: 'Rahul Das', role: 'CASHIER', pin: '4321' },
];

async function main(): Promise<void> {
  const existing = await prisma.tenant.findFirst({ where: { name: env.tenantName } });

  const tenant = existing ?? (await prisma.tenant.create({ data: { name: env.tenantName } }));

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

  if (env.isProduction) {
    console.log('\nNODE_ENV=production: skipping demo staff accounts.');
    return;
  }

  console.log('\nStaff:');
  for (const person of DEMO_STAFF) {
    // Cashiers have no email, so they are matched on name within the outlet.
    const found = person.email
      ? await prisma.staffUser.findFirst({ where: { tenantId: tenant.id, email: person.email } })
      : await prisma.staffUser.findFirst({
          where: { outletId: outlet.id, name: person.name, role: 'CASHIER' },
        });

    const staff =
      found ??
      (await prisma.staffUser.create({
        data: {
          tenantId: tenant.id,
          outletId: outlet.id,
          name: person.name,
          email: person.email ?? null,
          role: person.role,
          passwordHash: person.password ? await hash(person.password, ARGON2_OPTIONS) : null,
          pinHash: person.pin ? await hash(person.pin, ARGON2_OPTIONS) : null,
        },
      }));

    const credential = person.password
      ? `${person.email}  /  ${person.password}`
      : `PIN ${person.pin}`;
    console.log(`  ${staff.role.padEnd(8)} ${staff.name.padEnd(14)} ${credential}`);
  }

  console.log('\nDevelopment credentials only. Never seeded in production.');
  console.log('Pair a till: sign in as the manager, POST /v1/devices/pairing-codes.');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
