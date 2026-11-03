import { z } from 'zod';

/**
 * The tenancy spine. A `Tenant` is the restaurant business; an `Outlet` is a
 * physical location that issues invoices under its own GSTIN and its own
 * invoice number series.
 *
 * v1 runs one outlet, but every scoped row carries `outletId` from day one.
 * Retrofitting tenancy onto a live sales table is the kind of migration nobody
 * wants to run against real invoices.
 */

/** 15-character GSTIN: 2-digit state code, 10-char PAN, entity digit, 'Z', checksum. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const GstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_PATTERN, 'Not a valid 15-character GSTIN.');

export const OutletSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  /** Display name on the POS and the invoice header. */
  name: z.string().min(1).max(120),
  /** Registered name printed on the tax invoice. */
  legalName: z.string().min(1).max(200),
  addressLine1: z.string().max(200).nullable(),
  addressLine2: z.string().max(200).nullable(),
  city: z.string().max(80).nullable(),
  state: z.string().max(80).nullable(),
  postalCode: z.string().max(16).nullable(),
  phone: z.string().max(20).nullable(),
  gstin: z.string().nullable(),
  fssaiLicence: z.string().max(32).nullable(),
  /** ISO 4217. INR for v1 -- stored so reports never guess. */
  currency: z.string().length(3),
  /** IANA zone; the business day and the Z-report are cut in this zone. */
  timezone: z.string().min(1),
  /** Free text printed at the foot of every invoice. */
  invoiceFooter: z.string().max(500).nullable(),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Outlet = z.infer<typeof OutletSchema>;

export const TenantSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Tenant = z.infer<typeof TenantSchema>;
