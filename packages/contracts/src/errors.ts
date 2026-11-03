import { z } from 'zod';

/**
 * Every non-2xx response from the API has exactly this shape. One envelope,
 * one place the POS client has to understand, and a stable machine-readable
 * `code` the UI can switch on -- the `message` is for humans and may change
 * wording without being a breaking change.
 */

export const ERROR_CODES = [
  // 400s -- the request was wrong
  'VALIDATION_FAILED',
  'MALFORMED_REQUEST',
  // 401/403
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'DEVICE_NOT_REGISTERED',
  // 404/409
  'NOT_FOUND',
  'CONFLICT',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  // 422 -- the request was well-formed but the domain refuses it
  'RULE_VIOLATION',
  'ORDER_STATE_INVALID',
  'PAYMENT_TOTAL_MISMATCH',
  // 429
  'RATE_LIMITED',
  // 500s
  'INTERNAL_ERROR',
  'DEPENDENCY_UNAVAILABLE',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** One field-level validation problem. */
export const FieldIssueSchema = z.object({
  /** Dot/bracket path into the request body, e.g. `lines[0].quantity`. */
  path: z.string(),
  message: z.string(),
});
export type FieldIssue = z.infer<typeof FieldIssueSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    /** Present on VALIDATION_FAILED. */
    issues: z.array(FieldIssueSchema).optional(),
    /** Correlates the response with the server log line. Always present. */
    requestId: z.string(),
    timestamp: z.string().datetime(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Default HTTP status for each code, so controllers never have to remember. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  MALFORMED_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  DEVICE_NOT_REGISTERED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RULE_VIOLATION: 422,
  ORDER_STATE_INVALID: 422,
  PAYMENT_TOTAL_MISMATCH: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  DEPENDENCY_UNAVAILABLE: 503,
};
