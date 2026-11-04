import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ENV } from '../config/config.module.js';
import { type Env } from '../config/env.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ENV) env: Env) {
    super({
      datasources: { db: { url: env.DATABASE_URL } },
      log: PrismaService.logLevelsFor(env.NODE_ENV).map((level) => ({
        emit: 'stdout' as const,
        level,
      })),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Query logging is noisier in development on purpose: a warning there is a
   * hint, while in production it is log volume nobody reads.
   */
  static logLevelsFor(nodeEnv: Env['NODE_ENV']): Array<'warn' | 'error'> {
    return nodeEnv === 'development' ? ['warn', 'error'] : ['error'];
  }

  /** Cheap round-trip used by the readiness probe. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
