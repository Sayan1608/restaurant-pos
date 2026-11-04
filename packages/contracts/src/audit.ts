import { z } from 'zod';

/**
 * The audit trail.
 *
 * Append-only and read-only over HTTP: there is no update or delete endpoint
 * here, and there never should be. An audit trail that can be edited is not an
 * audit trail.
 */

export const ACTOR_TYPES = ['STAFF', 'DEVICE', 'SYSTEM'] as const;
export const ActorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const AUDIT_OUTCOMES = ['SUCCESS', 'FAILURE', 'DENIED'] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/**
 * Actions are dotted verbs so they group and filter naturally:
 * `auth.*` for sign-in activity, `device.*` for pairing, and from Step 3
 * onwards `menu.*`, `order.*`, `payment.*`.
 */
export const AUDIT_ACTIONS = [
  'auth.login.password',
  'auth.login.pin',
  'auth.login.failed',
  'auth.login.locked',
  'auth.refresh',
  'auth.refresh.reuse_detected',
  'auth.logout',
  'device.pairing_code.create',
  'device.pair',
  'device.revoke',
  'staff.create',
  'staff.update',
  'staff.pin.set',
  'staff.password.set',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number] | (string & {});

export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  outletId: z.string().uuid(),
  actorType: ActorTypeSchema,
  actorStaffId: z.string().uuid().nullable(),
  /** The actor's name as it was at the time, so history cannot be rewritten. */
  actorLabel: z.string().nullable(),
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  outcome: AuditOutcomeSchema,
  reason: z.string().nullable(),
  ip: z.string().nullable(),
  deviceId: z.string().uuid().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditQuerySchema = z.object({
  action: z.string().max(80).optional(),
  actorStaffId: z.string().uuid().optional(),
  outcome: AuditOutcomeSchema.optional(),
  /** ISO instants, inclusive. */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** Keyset pagination: the id of the last row from the previous page. */
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditPageSchema = z.object({
  entries: z.array(AuditLogEntrySchema),
  /** Pass back as `cursor` for the next page; null at the end. */
  nextCursor: z.string().uuid().nullable(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;
