import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenClaimsSchema, type AccessTokenClaims, type Role } from '@pos/contracts';

import { ApiException } from '../common/api-exception.js';
import { ENV } from '../config/config.module.js';
import { type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HashingService } from './hashing.service.js';

export interface AccessTokenSubject {
  staffUserId: string;
  tenantId: string;
  outletId: string;
  role: Role;
  deviceId?: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface RefreshContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** Recorded on the row so a revocation can be explained months later. */
export type RevokeReason =
  | 'rotated'
  | 'logout'
  | 'reuse_detected'
  | 'staff_deactivated'
  | 'device_revoked'
  | 'password_changed';

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  // --- access tokens --------------------------------------------------------

  /**
   * Access tokens are self-contained and deliberately short-lived: there is no
   * revocation list, so the window during which a deactivated staff member can
   * still act is exactly ACCESS_TOKEN_TTL_SECONDS. Revocation happens at the
   * refresh boundary instead, which keeps the hot path free of a database read
   * on every request.
   */
  signAccessToken(subject: AccessTokenSubject): { token: string; expiresAt: Date } {
    const ttl = this.env.ACCESS_TOKEN_TTL_SECONDS;
    const issuedAt = Math.floor(Date.now() / 1000);

    const claims: Omit<AccessTokenClaims, 'iat' | 'exp'> = {
      sub: subject.staffUserId,
      tid: subject.tenantId,
      oid: subject.outletId,
      role: subject.role,
      ...(subject.deviceId ? { did: subject.deviceId } : {}),
    };

    const token = this.jwt.sign(claims, { expiresIn: ttl });
    return { token, expiresAt: new Date((issuedAt + ttl) * 1000) };
  }

  /** Verify and parse an access token. Distinguishes expiry from invalidity,
   * because the client reacts differently: refresh versus sign in again. */
  verifyAccessToken(token: string): AccessTokenClaims {
    let payload: unknown;
    try {
      payload = this.jwt.verify(token);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TokenExpiredError') {
        throw new ApiException('TOKEN_EXPIRED', 'Access token has expired.');
      }
      throw new ApiException('UNAUTHENTICATED', 'Access token is not valid.');
    }

    const parsed = AccessTokenClaimsSchema.safeParse(payload);
    if (!parsed.success) {
      // Correctly signed but the wrong shape: a token from an older version, or
      // a signing key shared with something it should not be.
      throw new ApiException('UNAUTHENTICATED', 'Access token claims are not valid.');
    }
    return parsed.data;
  }

  // --- refresh tokens -------------------------------------------------------

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  }

  /** Issue a fresh access + refresh pair and persist the refresh fingerprint. */
  async issuePair(
    subject: AccessTokenSubject,
    context: RefreshContext = {},
  ): Promise<IssuedTokens> {
    const access = this.signAccessToken(subject);
    const refreshToken = this.hashing.generateOpaqueToken();
    const refreshTokenExpiresAt = this.refreshExpiry();

    await this.prisma.refreshToken.create({
      data: {
        staffUserId: subject.staffUserId,
        deviceId: subject.deviceId ?? null,
        tokenHash: this.hashing.fingerprint(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        ip: context.ip ?? null,
        userAgent: context.userAgent?.slice(0, 255) ?? null,
      },
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  /**
   * Rotate a refresh token: every use issues a new one and revokes the old.
   *
   * The important case is **reuse**. If a token that has already been rotated
   * is presented again, either the client is badly broken or the token was
   * stolen and is being replayed. We cannot tell which, so we assume the worst
   * and revoke every refresh token for that staff member -- logging the real
   * user out is a far smaller harm than leaving an attacker with a session on
   * a system that takes payments.
   */
  async rotate(
    presentedToken: string,
    context: RefreshContext = {},
  ): Promise<{ tokens: IssuedTokens; subject: AccessTokenSubject; reusedDetected: boolean }> {
    const fingerprint = this.hashing.fingerprint(presentedToken);

    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: fingerprint },
      include: {
        staffUser: {
          select: { id: true, tenantId: true, outletId: true, role: true, isActive: true },
        },
        device: { select: { id: true, revokedAt: true } },
      },
    });

    if (!existing) {
      throw new ApiException('TOKEN_REVOKED', 'Refresh token is not recognised.');
    }

    if (existing.revokedAt) {
      await this.revokeAllForStaff(existing.staffUserId, 'reuse_detected');
      this.logger.warn(
        { staffUserId: existing.staffUserId, tokenId: existing.id },
        'Refresh token reuse detected; all sessions for this staff member revoked',
      );
      throw new ApiException(
        'TOKEN_REVOKED',
        'This session has been ended for security reasons. Please sign in again.',
      );
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      await this.revokeById(existing.id, 'rotated');
      throw new ApiException('TOKEN_EXPIRED', 'Session has expired. Please sign in again.');
    }

    if (!existing.staffUser.isActive) {
      await this.revokeAllForStaff(existing.staffUserId, 'staff_deactivated');
      throw new ApiException('FORBIDDEN', 'This account is no longer active.');
    }

    if (existing.device?.revokedAt) {
      await this.revokeAllForStaff(existing.staffUserId, 'device_revoked');
      throw new ApiException('DEVICE_REVOKED', 'This till is no longer paired.');
    }

    const subject: AccessTokenSubject = {
      staffUserId: existing.staffUser.id,
      tenantId: existing.staffUser.tenantId,
      outletId: existing.staffUser.outletId,
      role: existing.staffUser.role,
      deviceId: existing.deviceId,
    };

    const access = this.signAccessToken(subject);
    const refreshToken = this.hashing.generateOpaqueToken();
    const refreshTokenExpiresAt = this.refreshExpiry();

    // One transaction: the replacement must exist and the old one must be
    // revoked together, or a crash between them leaves either two live tokens
    // or none at all.
    await this.prisma.$transaction(async (tx) => {
      const replacement = await tx.refreshToken.create({
        data: {
          staffUserId: subject.staffUserId,
          deviceId: subject.deviceId ?? null,
          tokenHash: this.hashing.fingerprint(refreshToken),
          expiresAt: refreshTokenExpiresAt,
          ip: context.ip ?? null,
          userAgent: context.userAgent?.slice(0, 255) ?? null,
        },
      });

      await tx.refreshToken.update({
        where: { id: existing.id },
        data: {
          revokedAt: new Date(),
          revokedReason: 'rotated',
          replacedByTokenId: replacement.id,
        },
      });
    });

    return {
      tokens: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken,
        refreshTokenExpiresAt,
      },
      subject,
      reusedDetected: false,
    };
  }

  /** Revoke a single refresh token by its plaintext value. Idempotent. */
  async revokeByToken(presentedToken: string, reason: RevokeReason): Promise<boolean> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashing.fingerprint(presentedToken), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count > 0;
  }

  async revokeById(id: string, reason: RevokeReason): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Revoke every live session for a staff member. */
  async revokeAllForStaff(staffUserId: string, reason: RevokeReason): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { staffUserId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  /** Revoke every live session started on a device. Used when it is unpaired. */
  async revokeAllForDevice(deviceId: string, reason: RevokeReason): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }
}
