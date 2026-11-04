import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import {
  CreateStaffRequestSchema,
  SetPasswordRequestSchema,
  SetPinRequestSchema,
  type SessionStaff,
  type StaffList,
  type StaffUser,
  UpdateStaffRequestSchema,
  type CreateStaffRequest,
  type UpdateStaffRequest,
} from '@pos/contracts';

import { CurrentStaff, Roles } from '../auth/auth.decorators.js';
import { requestIdOf, type AuthenticatedRequest } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { RequestMeta } from '../devices/devices.service.js';
import { StaffService } from './staff.service.js';

const metaOf = (request: AuthenticatedRequest): RequestMeta => ({
  ip: request.ip ?? null,
  requestId: requestIdOf(request),
});

/** Staff administration. Manager-and-above throughout: a cashier has no
 * business listing colleagues or resetting PINs. */
@Roles('OWNER', 'MANAGER')
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  async list(@CurrentStaff() actor: SessionStaff): Promise<StaffList> {
    return this.staff.list(actor);
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateStaffRequestSchema)) body: CreateStaffRequest,
    @CurrentStaff() actor: SessionStaff,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffUser> {
    return this.staff.create(body, actor, metaOf(request));
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateStaffRequestSchema)) body: UpdateStaffRequest,
    @CurrentStaff() actor: SessionStaff,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffUser> {
    return this.staff.update(id, body, actor, metaOf(request));
  }

  /** PUT, not PATCH: setting a PIN replaces it outright and is idempotent. */
  @Put(':id/pin')
  async setPin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SetPinRequestSchema)) body: { pin: string },
    @CurrentStaff() actor: SessionStaff,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffUser> {
    return this.staff.setPin(id, body.pin, actor, metaOf(request));
  }

  @Put(':id/password')
  async setPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SetPasswordRequestSchema)) body: { password: string },
    @CurrentStaff() actor: SessionStaff,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffUser> {
    return this.staff.setPassword(id, body.password, actor, metaOf(request));
  }
}
