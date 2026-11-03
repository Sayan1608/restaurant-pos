import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HEADERS } from '@pos/contracts';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';

import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { AppConfigModule, ENV } from './config/config.module.js';
import { type Env } from './config/env.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          // Pretty output is a development convenience only; production logs
          // are single-line JSON so they are searchable in a log store.
          transport:
            env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
              : undefined,
          // Honour an upstream request id so a trace survives the proxy.
          genReqId: (request, response) => {
            const incoming = request.headers[HEADERS.requestId];
            const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
            response.setHeader(HEADERS.requestId, id);
            return id;
          },
          // Health probes would otherwise dominate the log volume.
          autoLogging: {
            ignore: (request) => request.url === '/healthz' || request.url === '/readyz',
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["idempotency-key"]',
              'req.body.pin',
              'req.body.password',
              // Customer phone and email are PII: they belong in the database,
              // not in a log aggregator. Tightened further in Step 4.
              'req.body.phone',
              'req.body.email',
            ],
            censor: '[redacted]',
          },
        },
      }),
    }),
    PrismaModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
