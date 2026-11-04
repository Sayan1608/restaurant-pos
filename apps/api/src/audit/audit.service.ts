import { Injectable, Logger } from '@nestjs/common';
import type { AuditOutcome, AuditPage, AuditQuery } from '@pos/contracts';
import type { ActorType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  tenantId: string;
  outletId: string;
  action: string;
  outcome: AuditOutcome;
  actorType?: ActorType;
  actorStaffId?: string | null;
  /** The actor's name *at the time*. Stored so renaming or deactivating a
   * staff member can never rewrite who did something. */
  actorLabel?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  deviceId?: string | null;
  requestId?: string | null;
}

/** Keys whose values must never reach the audit table, matched case-insensitively. */
const SECRET_KEY_PATTERN =
  /pass(word)?|\bpin\b|pin[_-]?hash|secret|token|hash|authorization|cookie/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append one row.
   *
   * Never throws. An audit write that fails must not roll back the thing it was
   * describing -- refusing a sale because the log is full is worse than a gap
   * in the log. The failure is logged loudly instead, which is what alerting
   * watches for. (From Step 7, money-affecting audit rows are written *inside*
   * the business transaction via `recordWithin`, where the trade-off reverses.)
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: this.toRow(entry) });
    } catch (error) {
      this.logger.error(
        { err: error, action: entry.action, outletId: entry.outletId },
        'Failed to write audit row',
      );
    }
  }

  /**
   * Append one row inside an existing transaction, so the record and the thing
   * it describes commit together or not at all. Throws on failure, by design.
   */
  async recordWithin(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({ data: this.toRow(entry) });
  }

  private toRow(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
    return {
      tenantId: entry.tenantId,
      outletId: entry.outletId,
      actorType: entry.actorType ?? 'STAFF',
      actorStaffId: entry.actorStaffId ?? null,
      actorLabel: entry.actorLabel ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      // Omitted rather than set when absent, so the column stays SQL NULL
      // instead of holding a JSON `null` -- two different things to query.
      ...(AuditService.jsonOrSkip(entry.before) === undefined
        ? {}
        : { before: AuditService.jsonOrSkip(entry.before) }),
      ...(AuditService.jsonOrSkip(entry.after) === undefined
        ? {}
        : { after: AuditService.jsonOrSkip(entry.after) }),
      outcome: entry.outcome,
      reason: entry.reason?.slice(0, 200) ?? null,
      ip: entry.ip ?? null,
      deviceId: entry.deviceId ?? null,
      requestId: entry.requestId ?? null,
    };
  }

  /**
   * Strip credentials from a before/after snapshot.
   *
   * The audit table is the one place that deliberately keeps a copy of changed
   * data, which makes it the easiest place to accidentally persist a password
   * or a token forever. Redaction happens here, at the boundary, rather than
   * relying on every caller to remember.
   */
  static redact(value: unknown): unknown {
    return AuditService.redactValue(value, 0);
  }

  private static jsonOrSkip(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;
    return AuditService.redactValue(value, 0) as Prisma.InputJsonValue;
  }

  private static redactValue(value: unknown, depth: number): unknown {
    if (depth > 6) return '[too deep]';
    if (value === null || value === undefined) return null;

    if (Array.isArray(value)) {
      return value.map((item) => AuditService.redactValue(item, depth + 1));
    }

    if (value instanceof Date) return value.toISOString();

    if (typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        output[key] = SECRET_KEY_PATTERN.test(key)
          ? '[redacted]'
          : AuditService.redactValue(nested, depth + 1);
      }
      return output;
    }

    if (typeof value === 'bigint') return value.toString();
    return value;
  }

  /**
   * Read the trail for one outlet, newest first, with keyset pagination.
   *
   * Keyset rather than offset: an append-only table grows while it is being
   * paged, and `OFFSET` would silently skip or repeat rows as it does.
   */
  async query(outletId: string, query: AuditQuery): Promise<AuditPage> {
    const where: Prisma.AuditLogWhereInput = {
      outletId,
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.actorStaffId ? { actorStaffId: query.actorStaffId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      entries: page.map((row) => ({
        id: row.id,
        outletId: row.outletId,
        actorType: row.actorType,
        actorStaffId: row.actorStaffId,
        actorLabel: row.actorLabel,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: row.before ?? null,
        after: row.after ?? null,
        outcome: row.outcome,
        reason: row.reason,
        ip: row.ip,
        deviceId: row.deviceId,
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
