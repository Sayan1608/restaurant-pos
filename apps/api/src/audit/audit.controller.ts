import { Controller, Get, Query } from '@nestjs/common';
import { type AuditPage, AuditQuerySchema, type SessionStaff } from '@pos/contracts';

import { CurrentStaff, Roles } from '../auth/auth.decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuditService } from './audit.service.js';

/**
 * Read-only by construction. There is no POST, PATCH or DELETE here and there
 * should never be one: the trail is written as a side effect of the actions it
 * describes, and anything that can edit it defeats its purpose.
 *
 * Manager-and-above only -- it is a record of staff behaviour, so a cashier
 * should not be able to read their colleagues' activity.
 */
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles('OWNER', 'MANAGER')
  @Get()
  async list(
    @Query(new ZodValidationPipe(AuditQuerySchema))
    query: Parameters<AuditService['query']>[1],
    @CurrentStaff() staff: SessionStaff,
  ): Promise<AuditPage> {
    // Scoped to the caller's own outlet, taken from the token. A client-supplied
    // outlet id here would be a cross-tenant read.
    return this.audit.query(staff.outletId, query);
  }
}
