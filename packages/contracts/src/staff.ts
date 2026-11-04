import { z } from 'zod';

import { EmailSchema, PasswordSchema, PinSchema, RoleSchema } from './auth.js';

/**
 * Staff administration. Note what is absent: no response here ever carries a
 * password hash, a PIN hash, or a PIN. A hash in an API response is a hash in
 * a browser's network log.
 */

export const StaffUserSchema = z.object({
  id: z.string().uuid(),
  outletId: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable(),
  role: RoleSchema,
  /** Whether a credential is set, never the credential itself. */
  hasPassword: z.boolean(),
  hasPin: z.boolean(),
  isActive: z.boolean(),
  /** Non-null while a lockout is in force. */
  lockedUntil: z.string().datetime().nullable(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type StaffUser = z.infer<typeof StaffUserSchema>;

export const StaffListSchema = z.object({ staff: z.array(StaffUserSchema) });
export type StaffList = z.infer<typeof StaffListSchema>;

export const CreateStaffRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    role: RoleSchema,
    email: EmailSchema.optional(),
    password: PasswordSchema.optional(),
    pin: PinSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // A role determines which credential is required. Letting a cashier have a
    // password, or a manager sign in with only a 4-digit PIN, would quietly
    // undermine the distinction the two sign-in flows are built on.
    if (value.role === 'CASHIER') {
      if (!value.pin) {
        ctx.addIssue({ code: 'custom', path: ['pin'], message: 'A cashier needs a PIN.' });
      }
      if (value.password) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: 'A cashier signs in with a PIN, not a password.',
        });
      }
    } else {
      if (!value.email) {
        ctx.addIssue({
          code: 'custom',
          path: ['email'],
          message: 'An owner or manager needs an email address.',
        });
      }
      if (!value.password) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: 'An owner or manager needs a password.',
        });
      }
    }
  });
export type CreateStaffRequest = z.infer<typeof CreateStaffRequestSchema>;

export const UpdateStaffRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: EmailSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to update.',
  });
export type UpdateStaffRequest = z.infer<typeof UpdateStaffRequestSchema>;

export const SetPinRequestSchema = z.object({ pin: PinSchema });
export type SetPinRequest = z.infer<typeof SetPinRequestSchema>;

export const SetPasswordRequestSchema = z.object({ password: PasswordSchema });
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;
