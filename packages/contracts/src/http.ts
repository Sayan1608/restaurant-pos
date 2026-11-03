/** Shared HTTP conventions, so the client and the server cannot drift. */

/** All business endpoints live under this prefix. Health probes do not. */
export const API_PREFIX = 'v1';

export const HEADERS = {
  /** Echoed on every response; appears in the error envelope and the logs. */
  requestId: 'x-request-id',
  /** Required on every money-affecting mutation; makes a retry a no-op. */
  idempotencyKey: 'idempotency-key',
  /** Optimistic concurrency on the order aggregate (Step 5). */
  ifMatchVersion: 'if-match-version',
} as const;
