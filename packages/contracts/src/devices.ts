import { z } from 'zod';

/**
 * Device pairing.
 *
 * A till is paired once, by a manager, and then remembers itself. The flow is
 * deliberately two-sided: a manager creates a short code on an authenticated
 * screen, and the tablet redeems it. Neither half alone is enough, so a stolen
 * tablet cannot enrol itself and a leaked code is useless after a few minutes.
 */

/** Crockford-style base32, minus the characters people confuse when reading aloud. */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

export const PairingCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`),
    'Not a valid pairing code.',
  );

export const DeviceSchema = z.object({
  id: z.string().uuid(),
  outletId: z.string().uuid(),
  name: z.string(),
  pairedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  isActive: z.boolean(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const DeviceListSchema = z.object({ devices: z.array(DeviceSchema) });
export type DeviceList = z.infer<typeof DeviceListSchema>;

export const CreatePairingCodeRequestSchema = z.object({
  deviceName: z.string().trim().min(1).max(120),
});
export type CreatePairingCodeRequest = z.infer<typeof CreatePairingCodeRequestSchema>;

export const PairingCodeIssuedSchema = z.object({
  /** Shown to the manager once, to read out. Never retrievable afterwards. */
  code: z.string(),
  deviceName: z.string(),
  expiresAt: z.string().datetime(),
});
export type PairingCodeIssued = z.infer<typeof PairingCodeIssuedSchema>;

export const PairDeviceRequestSchema = z.object({
  code: PairingCodeSchema,
});
export type PairDeviceRequest = z.infer<typeof PairDeviceRequestSchema>;

export const PairedDeviceSchema = z.object({
  device: DeviceSchema,
  /**
   * The long-lived device token. Returned exactly once, at pairing: the server
   * keeps only its hash, so it cannot be shown again and a database leak does
   * not yield working credentials.
   */
  deviceToken: z.string(),
  outlet: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }),
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;
