import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@pos/contracts';

import type { AuthContext, AuthenticatedRequest, DeviceRequest } from './auth.types.js';

export const IS_PUBLIC_KEY = 'pos:isPublic';
export const ROLES_KEY = 'pos:roles';
export const NEEDS_DEVICE_KEY = 'pos:needsDevice';

/**
 * Opt a route out of authentication.
 *
 * Authentication is global and deny-by-default, so forgetting a guard leaves a
 * route *closed* rather than open. The decorator makes every exception
 * deliberate, greppable and reviewable -- there are only a handful, and they
 * are all sign-in or pairing routes.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Restrict a route to the given roles. OWNER is not implicitly granted
 * everything: a route that managers may use is written `@Roles('OWNER',
 * 'MANAGER')`, because implicit privilege inheritance is how an owner-only
 * action quietly becomes manager-accessible.
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/** Require a valid paired-device token (the `x-device-token` header). */
export const RequiresDevice = (): MethodDecorator & ClassDecorator =>
  SetMetadata(NEEDS_DEVICE_KEY, true);

/** Inject the verified auth context. Never read identity from the body. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.auth;
  },
);

/** Inject the verified staff member. */
export const CurrentStaff = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.auth.staff;
});

/** Inject the verified device, for device-authenticated routes. */
export const CurrentDevice = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<DeviceRequest>();
  return request.device;
});
