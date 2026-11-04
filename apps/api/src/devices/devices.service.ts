import { Inject, Injectable } from '@nestjs/common';
import type {
  CreatePairingCodeRequest,
  Device,
  DeviceList,
  PairedDevice,
  PairingCodeIssued,
  SessionStaff,
} from '@pos/contracts';
import type { Device as DeviceRow } from '@prisma/client';

import { AuditService } from '../audit/audit.service.js';
import { HashingService } from '../auth/hashing.service.js';
import { TokenService } from '../auth/token.service.js';
import { ApiException } from '../common/api-exception.js';
import { ENV } from '../config/config.module.js';
import { type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface RequestMeta {
  ip?: string | null;
  requestId?: string | null;
}

/**
 * Pairing a till.
 *
 * The flow is split in half on purpose. A manager, already signed in, creates a
 * short-lived code; the tablet redeems it for a long-lived token. Neither half
 * is sufficient alone, which means a tablet that walks out of the building
 * cannot enrol itself, and a code overheard across the counter is worthless
 * minutes later.
 */
@Injectable()
export class DevicesService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  static toDevice(row: DeviceRow): Device {
    return {
      id: row.id,
      outletId: row.outletId,
      name: row.name,
      pairedAt: row.pairedAt.toISOString(),
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      isActive: row.revokedAt === null,
    };
  }

  async list(actor: SessionStaff): Promise<DeviceList> {
    const rows = await this.prisma.device.findMany({
      where: { outletId: actor.outletId },
      orderBy: [{ revokedAt: 'asc' }, { name: 'asc' }],
    });
    return { devices: rows.map(DevicesService.toDevice) };
  }

  /** Create a single-use code for a manager to read out. */
  async createPairingCode(
    request: CreatePairingCodeRequest,
    actor: SessionStaff,
    meta: RequestMeta = {},
  ): Promise<PairingCodeIssued> {
    const code = this.hashing.generatePairingCode();
    const expiresAt = new Date(Date.now() + this.env.PAIRING_CODE_TTL_MINUTES * 60_000);

    await this.prisma.pairingCode.create({
      data: {
        tenantId: actor.tenantId,
        outletId: actor.outletId,
        codeHash: this.hashing.fingerprint(code),
        deviceName: request.deviceName,
        expiresAt,
        createdByStaffId: actor.id,
      },
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      outletId: actor.outletId,
      action: 'device.pairing_code.create',
      outcome: 'SUCCESS',
      actorStaffId: actor.id,
      actorLabel: actor.name,
      entityType: 'PairingCode',
      // The code itself is a credential and must not be in the audit row.
      after: { deviceName: request.deviceName, expiresAt: expiresAt.toISOString() },
      ip: meta.ip ?? null,
      requestId: meta.requestId ?? null,
    });

    return { code, deviceName: request.deviceName, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Redeem a code. Public, because the tablet has no credentials yet -- the
   * code *is* the credential, which is why it is single-use and short-lived.
   */
  async pair(code: string, meta: RequestMeta = {}): Promise<PairedDevice> {
    const pairing = await this.prisma.pairingCode.findFirst({
      where: { codeHash: this.hashing.fingerprint(code) },
      include: { outlet: { select: { id: true, name: true } } },
    });

    // One message for every failure, so the endpoint cannot be used to learn
    // whether a code exists, has expired, or was already used.
    const invalid = new ApiException(
      'PAIRING_CODE_INVALID',
      'That pairing code is not valid. Ask a manager for a new one.',
    );

    if (!pairing) throw invalid;
    if (pairing.usedAt) throw invalid;
    if (pairing.expiresAt.getTime() <= Date.now()) throw invalid;

    const deviceToken = this.hashing.generateOpaqueToken();

    // Marking the code used and creating the device must be atomic, or a
    // crash in between leaves a code that can be redeemed twice.
    const device = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.pairingCode.updateMany({
        where: { id: pairing.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      // Zero rows means another request claimed it first. The compare-and-set
      // is what makes "single use" true under concurrency, rather than just
      // true in the happy path.
      if (claimed.count === 0) throw invalid;

      return tx.device.create({
        data: {
          tenantId: pairing.tenantId,
          outletId: pairing.outletId,
          name: pairing.deviceName,
          tokenHash: this.hashing.fingerprint(deviceToken),
        },
      });
    });

    await this.audit.record({
      tenantId: pairing.tenantId,
      outletId: pairing.outletId,
      action: 'device.pair',
      outcome: 'SUCCESS',
      actorType: 'DEVICE',
      entityType: 'Device',
      entityId: device.id,
      after: { name: device.name },
      reason: `paired with code created by staff ${pairing.createdByStaffId}`,
      deviceId: device.id,
      ip: meta.ip ?? null,
      requestId: meta.requestId ?? null,
    });

    return {
      device: DevicesService.toDevice(device),
      deviceToken,
      outlet: { id: pairing.outlet.id, name: pairing.outlet.name },
    };
  }

  /**
   * Unpair a till. Also ends every session started on it: a tablet that has
   * been lost should not keep working for the rest of the refresh window.
   */
  async revoke(deviceId: string, actor: SessionStaff, meta: RequestMeta = {}): Promise<Device> {
    const existing = await this.prisma.device.findFirst({
      where: { id: deviceId, outletId: actor.outletId },
    });
    if (!existing) throw ApiException.notFound('Device');

    if (existing.revokedAt) {
      return DevicesService.toDevice(existing);
    }

    const updated = await this.prisma.device.update({
      where: { id: deviceId },
      data: { revokedAt: new Date() },
    });

    const endedSessions = await this.tokens.revokeAllForDevice(deviceId, 'device_revoked');

    await this.audit.record({
      tenantId: actor.tenantId,
      outletId: actor.outletId,
      action: 'device.revoke',
      outcome: 'SUCCESS',
      actorStaffId: actor.id,
      actorLabel: actor.name,
      entityType: 'Device',
      entityId: deviceId,
      before: { name: existing.name, revokedAt: null },
      after: { name: updated.name, revokedAt: updated.revokedAt?.toISOString() },
      reason: `${endedSessions} session(s) ended`,
      deviceId,
      ip: meta.ip ?? null,
      requestId: meta.requestId ?? null,
    });

    return DevicesService.toDevice(updated);
  }
}
