import { Injectable } from '@nestjs/common';
import type {
  CreateStaffRequest,
  SessionStaff,
  StaffList,
  StaffUser,
  UpdateStaffRequest,
} from '@pos/contracts';
import type { StaffUser as StaffRow } from '@prisma/client';

import { AuditService } from '../audit/audit.service.js';
import { HashingService } from '../auth/hashing.service.js';
import { TokenService } from '../auth/token.service.js';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RequestMeta } from '../devices/devices.service.js';

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The public shape of a staff member.
   *
   * `hasPassword` / `hasPin` rather than the hashes: a hash in a JSON response
   * is a hash in the browser's network log, in any proxy cache, and in whatever
   * the client persists. The API never emits one.
   */
  static toStaffUser(row: StaffRow): StaffUser {
    return {
      id: row.id,
      outletId: row.outletId,
      name: row.name,
      email: row.email,
      role: row.role,
      hasPassword: row.passwordHash !== null,
      hasPin: row.pinHash !== null,
      isActive: row.isActive,
      lockedUntil: row.lockedUntil?.toISOString() ?? null,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(actor: SessionStaff): Promise<StaffList> {
    const rows = await this.prisma.staffUser.findMany({
      where: { outletId: actor.outletId },
      orderBy: [{ isActive: 'desc' }, { role: 'asc' }, { name: 'asc' }],
    });
    return { staff: rows.map(StaffService.toStaffUser) };
  }

  async create(
    request: CreateStaffRequest,
    actor: SessionStaff,
    meta: RequestMeta = {},
  ): Promise<StaffUser> {
    // Only an owner may mint another owner. Otherwise a manager could promote
    // themselves sideways into unrestricted access.
    if (request.role === 'OWNER' && actor.role !== 'OWNER') {
      throw ApiException.forbidden('Only an owner can create another owner.');
    }

    if (request.email) {
      const clash = await this.prisma.staffUser.findFirst({
        where: { tenantId: actor.tenantId, email: request.email },
        select: { id: true },
      });
      if (clash) {
        throw ApiException.conflict('That email address is already in use.');
      }
    }

    const created = await this.prisma.staffUser.create({
      data: {
        tenantId: actor.tenantId,
        outletId: actor.outletId,
        name: request.name,
        email: request.email ?? null,
        role: request.role,
        passwordHash: request.password ? await this.hashing.hashSecret(request.password) : null,
        pinHash: request.pin ? await this.hashing.hashSecret(request.pin) : null,
      },
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      outletId: actor.outletId,
      action: 'staff.create',
      outcome: 'SUCCESS',
      actorStaffId: actor.id,
      actorLabel: actor.name,
      entityType: 'StaffUser',
      entityId: created.id,
      // Credentials are stripped by AuditService, but only the safe fields are
      // passed in to begin with.
      after: { name: created.name, email: created.email, role: created.role },
      ip: meta.ip ?? null,
      requestId: meta.requestId ?? null,
    });

    return StaffService.toStaffUser(created);
  }

  async update(
    id: string,
    request: UpdateStaffRequest,
    actor: SessionStaff,
    meta: RequestMeta = {},
  ): Promise<StaffUser> {
    const existing = await this.requireInOutlet(id, actor);

    if (existing.role === 'OWNER' && actor.role !== 'OWNER') {
      throw ApiException.forbidden('Only an owner can change an owner.');
    }

    if (request.isActive === false && existing.id === actor.id) {
      throw ApiException.rule('You cannot deactivate your own account.');
    }

    const updated = await this.prisma.staffUser.update({
      where: { id },
      data: {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.email === undefined ? {} : { email: request.email }),
        ...(request.isActive === undefined ? {} : { isActive: request.isActive }),
      },
    });

    // Deactivating someone must end their sessions now, not in fifteen
    // minutes when their access token happens to expire.
    if (request.isActive === false) {
      await this.tokens.revokeAllForStaff(id, 'staff_deactivated');
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      outletId: actor.outletId,
      action: 'staff.update',
      outcome: 'SUCCESS',
      actorStaffId: actor.id,
      actorLabel: actor.name,
      entityType: 'StaffUser',
      entityId: id,
      before: { name: existing.name, email: existing.email, isActive: existing.isActive },
      after: { name: updated.name, email: updated.email, isActive: updated.isActive },
      ip: meta.ip ?? null,
      requestId: meta.requestId ?? null,
    });

    return StaffService.toStaffUser(updated);
  }

  /** Set or reset a cashier's PIN. Also clears any lockout -- this is the
   * "my cashier is locked out mid-service" remedy. */
  async setPin(
    id: string,
    pin: string,
    actor: SessionStaff,
    meta: RequestMeta = {},
  ): Promise<StaffUser> {
    const existing = await this.requireInOutlet(id, actor);

    if (existing.role !== 'CASHIER') {
      throw ApiException.rule('Only a cashier signs in with a PIN.');
    }

    const updated = await this.prisma.staffUser.update({
      where: { id },
      data: {
        pinHash: await this.hashing.hashSecret(pin),
        failedAttempts: 0,
        lockedUntil: null,
      },
    });

    // A new PIN invalidates sessions opened with the old one.
    await this.tokens.revokeAllForStaff(id, 'password_changed');

    await this.audit.record({
      tenantId: actor.tenantId,
      outletId: actor.outletId,
      action: 'staff.pin.set',
      outcome: 'SUCCESS',
      actorStaffId: actor.id,
      actorLabel: actor.name,
      entityType: 'StaffUser',
      entityId: id,
      reason: 'PIN set or reset; lockout cleared',
      ip: meta.ip ?? null,
      requestId: meta.requestId ?? null,
    });

    return StaffService.toStaffUser(updated);
  }

  async setPassword(
    id: string,
    password: string,
    actor: SessionStaff,
    meta: RequestMeta = {},
  ): Promise<StaffUser> {
    const existing = await this.requireInOutlet(id, actor);

    if (existing.role === 'CASHIER') {
      throw ApiException.rule('A cashier signs in with a PIN, not a password.');
    }
    if (existing.role === 'OWNER' && actor.role !== 'OWNER') {
      throw ApiException.forbidden("Only an owner can change an owner's password.");
    }

    const updated = await this.prisma.staffUser.update({
      where: { id },
      data: {
        passwordHash: await this.hashing.hashSecret(password),
        failedAttempts: 0,
        lockedUntil: null,
      },
    });

    await this.tokens.revokeAllForStaff(id, 'password_changed');

    await this.audit.record({
      tenantId: actor.tenantId,
      outletId: actor.outletId,
      action: 'staff.password.set',
      outcome: 'SUCCESS',
      actorStaffId: actor.id,
      actorLabel: actor.name,
      entityType: 'StaffUser',
      entityId: id,
      reason: 'password set; all sessions ended',
      ip: meta.ip ?? null,
      requestId: meta.requestId ?? null,
    });

    return StaffService.toStaffUser(updated);
  }

  /**
   * Fetch a staff member, scoped to the caller's outlet.
   *
   * The scoping is the point: an id from the URL is attacker-controlled, so it
   * is matched against the outlet from the *token*, never the other way round.
   * A missing row and a row in someone else's outlet both answer "not found",
   * so the endpoint cannot confirm that an id exists elsewhere.
   */
  private async requireInOutlet(id: string, actor: SessionStaff): Promise<StaffRow> {
    const row = await this.prisma.staffUser.findFirst({
      where: { id, outletId: actor.outletId },
    });
    if (!row) throw ApiException.notFound('Staff member');
    return row;
  }
}
