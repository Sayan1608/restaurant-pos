import type { Role, SessionDevice, SessionStaff } from '@pos/contracts';
import type { Request } from 'express';

/**
 * What a guard proves about a request, and the only thing the rest of the API
 * is allowed to trust.
 *
 * Note what is *not* here: nothing is read from the request body or query to
 * determine who the caller is or which outlet they are acting on. Tenancy and
 * identity come from the verified token only. A body-supplied `outletId` is
 * how a bug becomes a cross-tenant data leak.
 */
export interface AuthContext {
  staff: SessionStaff;
  /** Present when the session was started on a paired till. */
  device: SessionDevice | null;
}

/**
 * A request that has passed the access-token guard.
 *
 * `id` is not declared here: pino-http already augments Express's Request with
 * it, typed as `ReqId` (string | number | object). Redeclaring it narrower
 * conflicts with that augmentation, so use `requestIdOf()` to read it.
 */
export interface AuthenticatedRequest extends Request {
  auth: AuthContext;
}

/** A request that has passed the device guard but may have no staff yet. */
export interface DeviceRequest extends Request {
  device: {
    id: string;
    name: string;
    tenantId: string;
    outletId: string;
  };
}

/** The pino-http request id as a string, for audit rows and error envelopes. */
export function requestIdOf(request: { id?: unknown }): string | null {
  return request.id === undefined || request.id === null ? null : String(request.id);
}

export const hasRole = (role: Role, ...allowed: Role[]): boolean => allowed.includes(role);
