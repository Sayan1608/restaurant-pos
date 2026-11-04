import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { IS_PUBLIC_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { TokenService } from './token.service.js';

/**
 * Global authentication. Registered as an APP_GUARD, so **every** route is
 * closed unless it carries `@Public()`.
 *
 * That default matters more than it looks: the opposite arrangement -- guards
 * applied per route -- means a new endpoint added in a hurry is wide open, and
 * nothing in the code says so. Here, forgetting is safe.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw ApiException.unauthenticated();
    }

    const claims = this.tokens.verifyAccessToken(header.slice('Bearer '.length).trim());

    // The token is proof of identity, but not proof the account is still
    // usable. One indexed read per request is the price of being able to
    // deactivate someone and have it take effect.
    const staff = await this.prisma.staffUser.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        tenantId: true,
        outletId: true,
        isActive: true,
      },
    });

    if (!staff || !staff.isActive) {
      throw ApiException.unauthenticated('This account is no longer active.');
    }

    // Claims are only trusted as far as they still agree with the database. A
    // token minted before a staff member moved outlet must not keep acting on
    // the old one.
    if (
      staff.tenantId !== claims.tid ||
      staff.outletId !== claims.oid ||
      staff.role !== claims.role
    ) {
      throw ApiException.unauthenticated('Your session is out of date. Please sign in again.');
    }

    let device: AuthenticatedRequest['auth']['device'] = null;
    if (claims.did) {
      const found = await this.prisma.device.findUnique({
        where: { id: claims.did },
        select: { id: true, name: true, revokedAt: true, outletId: true },
      });

      if (!found || found.outletId !== staff.outletId) {
        throw ApiException.unauthenticated('This till is no longer recognised.');
      }
      if (found.revokedAt) {
        throw new ApiException('DEVICE_REVOKED', 'This till has been unpaired.');
      }
      device = { id: found.id, name: found.name };
    }

    request.auth = {
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        tenantId: staff.tenantId,
        outletId: staff.outletId,
      },
      device,
    };

    return true;
  }
}
