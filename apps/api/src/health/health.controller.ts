import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Liveness, Readiness } from '@pos/contracts';
import type { Response } from 'express';

import { Public } from '../auth/auth.decorators.js';
import { HealthService } from './health.service.js';

/**
 * Probe endpoints. Deliberately outside the /v1 prefix and outside auth --
 * orchestrators and uptime checks should not need a token, and the payload
 * contains nothing a stranger could use.
 */
@Public()
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): Liveness {
    return this.health.liveness();
  }

  @Get('readyz')
  async readiness(@Res({ passthrough: true }) response: Response): Promise<Readiness> {
    const result = await this.health.readiness();
    // 503 on degraded so a load balancer actually acts on it.
    response.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
