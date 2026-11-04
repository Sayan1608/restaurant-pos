import { z } from 'zod';

/**
 * Authentication contracts.
 *
 * Two different sign-ins, because a restaurant has two different situations:
 *
 *  - Owners and managers sign in with an email and a password, from anywhere.
 *  - Cashiers tap their name and type a short PIN, and only on a tablet a
 *    manager has already paired. The PIN is weak by design -- it has to be
 *    typeable between customers -- so the device binding, the lockout and the
 *    rate limit are what make it safe, not the PIN itself.
 */

export const ROLES = ['OWNER', 'MANAGER', 'CASHIER'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Ranked for comparisons: an OWNER satisfies a MANAGER requirement. */
export const ROLE_RANK: Record<Role, number> = { CASHIER: 1, MANAGER: 2, OWNER: 3 };

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;
export const PASSWORD_MIN_LENGTH = 12;

/** Digits only: the POS keypad has no letters on it. */
export const PinSchema = z
  .string()
  .regex(
    new RegExp(`^[0-9]{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`),
    `PIN must be ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits.`,
  );

/**
 * Length over composition rules. A long passphrase beats "P@ssw0rd!", and
 * composition rules mostly teach people to write passwords on the till.
 */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(200);

export const EmailSchema = z.string().trim().toLowerCase().email().max(200);

// --- requests ---------------------------------------------------------------

export const PasswordLoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(200),
});
export type PasswordLoginRequest = z.infer<typeof PasswordLoginRequestSchema>;

export const PinLoginRequestSchema = z.object({
  /** The cashier taps their name first, so the PIN never has to be unique. */
  staffUserId: z.string().uuid(),
  pin: z.string().min(1).max(32),
});
export type PinLoginRequest = z.infer<typeof PinLoginRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

// --- responses --------------------------------------------------------------

/** The authenticated staff member, as the client is allowed to see them. */
export const SessionStaffSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable(),
  role: RoleSchema,
  tenantId: z.string().uuid(),
  outletId: z.string().uuid(),
});
export type SessionStaff = z.infer<typeof SessionStaffSchema>;

export const SessionDeviceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type SessionDevice = z.infer<typeof SessionDeviceSchema>;

export const TokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
  refreshTokenExpiresAt: z.string().datetime(),
});
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const AuthSessionSchema = TokenPairSchema.extend({
  staff: SessionStaffSchema,
  device: SessionDeviceSchema.nullable(),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

/** GET /auth/me -- who the current access token belongs to. */
export const MeSchema = z.object({
  staff: SessionStaffSchema,
  device: SessionDeviceSchema.nullable(),
  outlet: z.object({
    id: z.string().uuid(),
    name: z.string(),
    currency: z.string(),
    timezone: z.string(),
  }),
});
export type Me = z.infer<typeof MeSchema>;

/**
 * The cashier picker on the PIN screen. Deliberately just an id and a name:
 * this endpoint is reachable with only a device token, so it must not leak
 * emails, roles or lockout state.
 */
export const CashierSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type CashierSummary = z.infer<typeof CashierSummarySchema>;

export const CashierListSchema = z.object({
  cashiers: z.array(CashierSummarySchema),
});
export type CashierList = z.infer<typeof CashierListSchema>;

/** The claims carried in an access token. Short names: these go over the wire. */
export const AccessTokenClaimsSchema = z.object({
  /** staffUserId */
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  oid: z.string().uuid(),
  role: RoleSchema,
  /** deviceId, when the session was started on a paired till. */
  did: z.string().uuid().optional(),
  iat: z.number(),
  exp: z.number(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;
