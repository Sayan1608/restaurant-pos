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
      log:
        env.NODE_ENV === 'development'
          ? [
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : [{ emit: 'stdout', level: 'error' }],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap round-trip used by the readiness probe. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
