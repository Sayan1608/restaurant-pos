import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AuditModule } from './audit/audit.module.js';
import { AccessTokenGuard } from './auth/access-token.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { RolesGuard } from './auth/roles.guard.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { buildPinoHttpOptions } from './common/logger.options.js';
import { AppConfigModule, ENV } from './config/config.module.js';
import { type Env } from './config/env.js';
import { DevicesModule } from './devices/devices.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { StaffModule } from './staff/staff.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ pinoHttp: buildPinoHttpOptions(env) }),
    }),
    /**
     * One bucket, a generous ceiling against a runaway client, tightened per
     * route with `@Throttle({ default: ... })` on sign-in and pairing.
     *
     * Deliberately *not* a second named bucket for auth: ThrottlerGuard
     * applies **every** named definition to **every** route, so adding an
     * `auth` bucket with a limit of 10 silently caps the whole API at 10
     * requests a minute. (It also cannot be escaped with a bare
     * `@SkipThrottle()`, which only skips the bucket literally named
     * `default`.) A test asserting the health probes are not throttled is what
     * caught this.
     */
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    StaffModule,
    DevicesModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    /**
     * Guard order is the security model, so it lives in one visible place.
     *
     * Throttler first (cheapest, and it must apply to unauthenticated floods),
     * then authentication, then authorization. Reversing the last two would
     * check roles against an identity nothing had established yet.
     */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
