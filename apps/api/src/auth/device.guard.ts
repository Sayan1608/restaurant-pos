import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { HEADERS } from '@pos/contracts';

import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { DeviceRequest } from './auth.types.js';
import { HashingService } from './hashing.service.js';

/**
 * Proves the request comes from a till a manager paired.
 *
 * Applied explicitly, not globally: only the cashier sign-in routes need it.
 * It authenticates the *terminal*, which is a separate question from who is
 * standing at it -- hence a separate header and a separate guard from
 * AccessTokenGuard.
 */
@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DeviceRequest>();
    const raw = request.headers[HEADERS.deviceToken];
    const token = Array.isArray(raw) ? raw[0] : raw;

    if (!token) {
      throw new ApiException(
        'DEVICE_NOT_REGISTERED',
        'This device is not paired with an outlet. Ask a manager to pair it.',
      );
    }

    // Looked up by fingerprint, so the token itself is never stored and the
    // comparison is done by an indexed equality rather than in application
    // code.
    const device = await this.prisma.device.findUnique({
      where: { tokenHash: this.hashing.fingerprint(token) },
      select: { id: true, name: true, tenantId: true, outletId: true, revokedAt: true },
    });

    if (!device) {
      throw new ApiException(
        'DEVICE_NOT_REGISTERED',
        'This device is not paired with an outlet. Ask a manager to pair it.',
      );
    }

    if (device.revokedAt) {
      throw new ApiException(
        'DEVICE_REVOKED',
        'This till has been unpaired. Ask a manager to pair it again.',
      );
    }

    request.device = {
      id: device.id,
      name: device.name,
      tenantId: device.tenantId,
      outletId: device.outletId,
    };

    return true;
  }
}
