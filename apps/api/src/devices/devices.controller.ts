import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CreatePairingCodeRequestSchema,
  type Device,
  type DeviceList,
  PairDeviceRequestSchema,
  type PairedDevice,
  type PairingCodeIssued,
  type SessionStaff,
} from '@pos/contracts';

import { CurrentStaff, Public, Roles } from '../auth/auth.decorators.js';
import { requestIdOf, type AuthenticatedRequest } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DevicesService, type RequestMeta } from './devices.service.js';

const metaOf = (request: AuthenticatedRequest): RequestMeta => ({
  ip: request.ip ?? null,
  requestId: requestIdOf(request),
});

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Roles('OWNER', 'MANAGER')
  @Get()
  async list(@CurrentStaff() staff: SessionStaff): Promise<DeviceList> {
    return this.devices.list(staff);
  }

  @Roles('OWNER', 'MANAGER')
  @Post('pairing-codes')
  async createPairingCode(
    @Body(new ZodValidationPipe(CreatePairingCodeRequestSchema)) body: { deviceName: string },
    @CurrentStaff() staff: SessionStaff,
    @Req() request: AuthenticatedRequest,
  ): Promise<PairingCodeIssued> {
    return this.devices.createPairingCode(body, staff, metaOf(request));
  }

  /**
   * Redeeming a code is necessarily unauthenticated -- the tablet has no
   * credentials yet. Rate limited tightly because the code space is small
   * enough to be worth guessing if guesses were free.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('pair')
  async pair(
    @Body(new ZodValidationPipe(PairDeviceRequestSchema)) body: { code: string },
    @Req() request: AuthenticatedRequest,
  ): Promise<PairedDevice> {
    return this.devices.pair(body.code, metaOf(request));
  }

  @Roles('OWNER', 'MANAGER')
  @Delete(':id')
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentStaff() staff: SessionStaff,
    @Req() request: AuthenticatedRequest,
  ): Promise<Device> {
    return this.devices.revoke(id, staff, metaOf(request));
  }
}
