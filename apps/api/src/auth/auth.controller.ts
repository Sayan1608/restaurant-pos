import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthSession,
  type CashierList,
  type Me,
  PasswordLoginRequestSchema,
  PinLoginRequestSchema,
  RefreshRequestSchema,
  type SessionStaff,
} from '@pos/contracts';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuthService, type LoginContext } from './auth.service.js';
import { CurrentDevice, CurrentStaff, Public, RequiresDevice } from './auth.decorators.js';
import { requestIdOf, type AuthenticatedRequest, type DeviceRequest } from './auth.types.js';
import { DeviceGuard } from './device.guard.js';

/** Pull the request details every audit row wants, from the request only. */
function contextOf(request: AuthenticatedRequest | DeviceRequest): LoginContext {
  return {
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: requestIdOf(request),
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Owner / manager sign-in.
   *
   * Rate limited hard and separately from the rest of the API: this is the one
   * endpoint where an attacker gets unlimited free guesses unless we say
   * otherwise. The per-account lockout handles a targeted attack; this limit
   * handles someone spraying many accounts from one address.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(PasswordLoginRequestSchema))
    body: { email: string; password: string },
    @Req() request: AuthenticatedRequest,
  ): Promise<AuthSession> {
    return this.auth.loginWithPassword(body, contextOf(request));
  }

  /** The names shown on the PIN pad. Needs a paired till, not a person. */
  @Public()
  @RequiresDevice()
  @UseGuards(DeviceGuard)
  @Get('cashiers')
  async cashiers(@CurrentDevice() device: DeviceRequest['device']): Promise<CashierList> {
    return this.auth.listCashiers(device);
  }

  /** Cashier sign-in: a PIN, on a paired till. */
  @Public()
  @RequiresDevice()
  @UseGuards(DeviceGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('pin')
  @HttpCode(HttpStatus.OK)
  async loginWithPin(
    @Body(new ZodValidationPipe(PinLoginRequestSchema))
    body: { staffUserId: string; pin: string },
    @CurrentDevice() device: DeviceRequest['device'],
    @Req() request: DeviceRequest,
  ): Promise<AuthSession> {
    return this.auth.loginWithPin(body, device, contextOf(request));
  }

  /**
   * Exchange a refresh token for a new pair. Public because the access token
   * it is meant to replace has, by definition, expired.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) body: { refreshToken: string },
    @Req() request: AuthenticatedRequest,
  ): Promise<AuthSession> {
    return this.auth.refresh(body.refreshToken, contextOf(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body() body: { refreshToken?: string },
    @CurrentStaff() staff: SessionStaff,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.auth.logout(body?.refreshToken, staff, contextOf(request));
  }

  /** Who am I, and where am I working? Drives the POS session banner. */
  @Get('me')
  async me(@Req() request: AuthenticatedRequest): Promise<Me> {
    return this.auth.me(request.auth.staff.id, request.auth.device?.id ?? null);
  }
}
