import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@pos/contracts';

import { ApiException } from '../common/api-exception.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './auth.types.js';

/**
 * Role enforcement, registered globally after AccessTokenGuard.
 *
 * A route with no `@Roles()` is available to any authenticated staff member;
 * anything narrower states it explicitly. There is no implicit hierarchy --
 * see the note on the Roles decorator.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const role = request.auth?.staff.role;

    if (!role) {
      // Only reachable if the guard order is changed so this runs first.
      throw ApiException.unauthenticated();
    }

    if (!required.includes(role)) {
      throw ApiException.forbidden(
        `This action needs ${required.join(' or ')} access; you are signed in as ${role}.`,
      );
    }

    return true;
  }
}
