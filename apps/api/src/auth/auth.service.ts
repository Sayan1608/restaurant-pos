import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AuthSession,
  CashierList,
  Me,
  PasswordLoginRequest,
  PinLoginRequest,
  SessionStaff,
} from '@pos/contracts';
import type { StaffUser } from '@prisma/client';

import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-exception.js';
import { ENV } from '../config/config.module.js';
import { type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HashingService } from './hashing.service.js';
import { TokenService, type AccessTokenSubject } from './token.service.js';

export interface LoginContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** The till a cashier is signing in on. */
export interface DeviceContext {
  id: string;
  name: string;
  tenantId: string;
  outletId: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  // --- sign in --------------------------------------------------------------

  /**
   * Email + password, for owners and managers.
   *
   * Every failure path returns the same INVALID_CREDENTIALS message and spends
   * roughly the same time, so the endpoint cannot be used to discover which
   * email addresses exist. The one deliberate exception is a locked account,
   * which must say so -- otherwise a manager locked out mid-service has no idea
   * why their correct password is being refused.
   */
  async loginWithPassword(
    request: PasswordLoginRequest,
    context: LoginContext = {},
  ): Promise<AuthSession> {
    const staff = await this.prisma.staffUser.findFirst({
      where: { email: request.email, isActive: true },
      include: { outlet: { select: { id: true, name: true } } },
    });

    if (!staff || staff.role === 'CASHIER' || !staff.passwordHash) {
      // Spend the time a real verification would, then fail identically.
      await this.hashing.verifyDummy();
      await this.recordFailedLogin(staff, context, 'auth.login.password', 'unknown_or_ineligible');
      throw ApiException.invalidCredentials();
    }

    this.assertNotLocked(staff);

    const ok = await this.hashing.verifySecret(staff.passwordHash, request.password);
    if (!ok) {
      await this.registerFailure(staff, context, 'auth.login.password');
      throw ApiException.invalidCredentials();
    }

    return this.completeLogin(staff, null, context, 'auth.login.password');
  }

  /**
   * Cashier PIN, which is only accepted on a paired till.
   *
   * Three things make a 4-digit secret acceptable here, and all three are
   * required: the device must be paired (so the PIN is useless off-premises),
   * the account locks after a handful of failures (so guessing is bounded), and
   * the PIN is Argon2id-hashed (so a database leak does not hand over the PIN).
   */
  async loginWithPin(
    request: PinLoginRequest,
    device: DeviceContext,
    context: LoginContext = {},
  ): Promise<AuthSession> {
    const staff = await this.prisma.staffUser.findFirst({
      where: {
        id: request.staffUserId,
        outletId: device.outletId,
        role: 'CASHIER',
        isActive: true,
      },
      include: { outlet: { select: { id: true, name: true } } },
    });

    if (!staff || !staff.pinHash) {
      await this.hashing.verifyDummy();
      await this.recordFailedLogin(
        staff,
        { ...context },
        'auth.login.pin',
        'unknown_cashier',
        device,
      );
      throw ApiException.invalidCredentials();
    }

    this.assertNotLocked(staff);

    const ok = await this.hashing.verifySecret(staff.pinHash, request.pin);
    if (!ok) {
      await this.registerFailure(staff, context, 'auth.login.pin', device);
      throw ApiException.invalidCredentials();
    }

    await this.prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });

    return this.completeLogin(staff, device, context, 'auth.login.pin');
  }

  /** The names on the PIN pad. Device-authenticated, so it returns id and name
   * only -- no emails, no roles, no lockout state. */
  async listCashiers(device: DeviceContext): Promise<CashierList> {
    const cashiers = await this.prisma.staffUser.findMany({
      where: { outletId: device.outletId, role: 'CASHIER', isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return { cashiers };
  }

  // --- session lifecycle ----------------------------------------------------

  async refresh(refreshToken: string, context: LoginContext = {}): Promise<AuthSession> {
    const { tokens, subject } = await this.tokens.rotate(refreshToken, context);

    const staff = await this.prisma.staffUser.findUniqueOrThrow({
      where: { id: subject.staffUserId },
      include: { outlet: { select: { id: true, name: true } } },
    });

    const device = subject.deviceId
      ? await this.prisma.device.findUnique({
          where: { id: subject.deviceId },
          select: { id: true, name: true },
        })
      : null;

    await this.audit.record({
      tenantId: staff.tenantId,
      outletId: staff.outletId,
      action: 'auth.refresh',
      outcome: 'SUCCESS',
      actorStaffId: staff.id,
      actorLabel: staff.name,
      deviceId: subject.deviceId ?? null,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    });

    return {
      ...this.serialiseTokens(tokens),
      staff: AuthService.toSessionStaff(staff),
      device: device ? { id: device.id, name: device.name } : null,
    };
  }

  async logout(
    refreshToken: string | undefined,
    actor: SessionStaff,
    context: LoginContext = {},
  ): Promise<void> {
    if (refreshToken) {
      await this.tokens.revokeByToken(refreshToken, 'logout');
    } else {
      // No token supplied: end every session for this person rather than
      // leaving them signed in on a shared till they meant to leave.
      await this.tokens.revokeAllForStaff(actor.id, 'logout');
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      outletId: actor.outletId,
      action: 'auth.logout',
      outcome: 'SUCCESS',
      actorStaffId: actor.id,
      actorLabel: actor.name,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    });
  }

  async me(staffId: string, deviceId: string | null): Promise<Me> {
    const staff = await this.prisma.staffUser.findUniqueOrThrow({
      where: { id: staffId },
      include: {
        outlet: { select: { id: true, name: true, currency: true, timezone: true } },
      },
    });

    const device = deviceId
      ? await this.prisma.device.findUnique({
          where: { id: deviceId },
          select: { id: true, name: true },
        })
      : null;

    return {
      staff: AuthService.toSessionStaff(staff),
      device: device ? { id: device.id, name: device.name } : null,
      outlet: {
        id: staff.outlet.id,
        name: staff.outlet.name,
        currency: staff.outlet.currency,
        timezone: staff.outlet.timezone,
      },
    };
  }

  // --- internals ------------------------------------------------------------

  static toSessionStaff(staff: StaffUser): SessionStaff {
    return {
      id: staff.id,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      tenantId: staff.tenantId,
      outletId: staff.outletId,
    };
  }

  private serialiseTokens(tokens: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: Date;
    refreshTokenExpiresAt: Date;
  }) {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    };
  }

  private assertNotLocked(staff: StaffUser): void {
    if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) {
      const seconds = Math.ceil((staff.lockedUntil.getTime() - Date.now()) / 1000);
      const minutes = Math.ceil(seconds / 60);
      throw new ApiException(
        'ACCOUNT_LOCKED',
        `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, ` +
          'or ask a manager to reset it.',
      );
    }
  }

  private async completeLogin(
    staff: StaffUser,
    device: DeviceContext | null,
    context: LoginContext,
    action: string,
  ): Promise<AuthSession> {
    const subject: AccessTokenSubject = {
      staffUserId: staff.id,
      tenantId: staff.tenantId,
      outletId: staff.outletId,
      role: staff.role,
      deviceId: device?.id ?? null,
    };

    const tokens = await this.tokens.issuePair(subject, context);

    // Clearing the counter is part of a successful sign-in: otherwise four
    // typos earlier in the shift would still lock the account on the next one.
    await this.prisma.staffUser.update({
      where: { id: staff.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    await this.audit.record({
      tenantId: staff.tenantId,
      outletId: staff.outletId,
      action,
      outcome: 'SUCCESS',
      actorStaffId: staff.id,
      actorLabel: staff.name,
      deviceId: device?.id ?? null,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    });

    return {
      ...this.serialiseTokens(tokens),
      staff: AuthService.toSessionStaff(staff),
      device: device ? { id: device.id, name: device.name } : null,
    };
  }

  /**
   * Count a failed attempt and lock the account once the threshold is reached.
   *
   * The lockout is what makes a short PIN defensible: it converts an unlimited
   * guessing game into a handful of tries per quarter of an hour.
   */
  private async registerFailure(
    staff: StaffUser,
    context: LoginContext,
    action: string,
    device?: DeviceContext,
  ): Promise<void> {
    const attempts = staff.failedAttempts + 1;
    const shouldLock = attempts >= this.env.LOGIN_MAX_ATTEMPTS;
    const lockedUntil = shouldLock
      ? new Date(Date.now() + this.env.LOGIN_LOCKOUT_MINUTES * 60_000)
      : null;

    await this.prisma.staffUser.update({
      where: { id: staff.id },
      data: {
        failedAttempts: shouldLock ? 0 : attempts,
        ...(shouldLock ? { lockedUntil } : {}),
      },
    });

    if (shouldLock) {
      // Locking someone out also ends their existing sessions: if this is an
      // attacker guessing, any session they already have should not survive.
      await this.tokens.revokeAllForStaff(staff.id, 'reuse_detected');
      this.logger.warn(
        { staffUserId: staff.id, outletId: staff.outletId, attempts },
        'Account locked after repeated failed sign-ins',
      );
    }

    await this.audit.record({
      tenantId: staff.tenantId,
      outletId: staff.outletId,
      action: shouldLock ? 'auth.login.locked' : 'auth.login.failed',
      outcome: shouldLock ? 'DENIED' : 'FAILURE',
      actorStaffId: staff.id,
      actorLabel: staff.name,
      entityType: 'StaffUser',
      entityId: staff.id,
      reason: `${action}; attempt ${attempts} of ${this.env.LOGIN_MAX_ATTEMPTS}`,
      deviceId: device?.id ?? null,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    });
  }

  /**
   * Record an attempt against an account we could not identify.
   *
   * There is no counter to increment, but the attempt still belongs in the
   * trail: a burst of these is how credential stuffing looks from the inside.
   */
  private async recordFailedLogin(
    staff: { tenantId: string; outletId: string; id: string; name: string } | null,
    context: LoginContext,
    action: string,
    reason: string,
    device?: DeviceContext,
  ): Promise<void> {
    const scope = staff ?? device;
    if (!scope) {
      // No tenant to attribute it to -- an unknown email with no device. The
      // server log is the only place it can go.
      this.logger.warn({ action, reason, ip: context.ip }, 'Sign-in attempt for unknown account');
      return;
    }

    await this.audit.record({
      tenantId: scope.tenantId,
      outletId: scope.outletId,
      action: 'auth.login.failed',
      outcome: 'FAILURE',
      actorType: staff ? 'STAFF' : 'DEVICE',
      actorStaffId: staff?.id ?? null,
      actorLabel: staff?.name ?? null,
      reason: `${action}; ${reason}`,
      deviceId: device?.id ?? null,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    });
  }
}
