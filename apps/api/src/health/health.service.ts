import { Inject, Injectable } from '@nestjs/common';
import type { DependencyStatus, Liveness, Readiness } from '@pos/contracts';

import { ENV } from '../config/config.module.js';
import { type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class HealthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  /** Liveness must not touch a dependency: a database blip is not a reason to be killed. */
  liveness(): Liveness {
    return {
      status: 'ok',
      service: 'pos-api',
      version: this.env.APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness checks every hard dependency, so a bad instance leaves the load balancer. */
  async readiness(): Promise<Readiness> {
    const dependencies: DependencyStatus[] = [await this.checkPostgres()];

    return {
      status: dependencies.every((dependency) => dependency.status === 'up') ? 'ok' : 'degraded',
      dependencies,
      timestamp: new Date().toISOString(),
    };
  }

  private async checkPostgres(): Promise<DependencyStatus> {
    const startedAt = performance.now();
    try {
      await this.prisma.ping();
      return {
        name: 'postgres',
        status: 'up',
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      return {
        name: 'postgres',
        status: 'down',
        latencyMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
