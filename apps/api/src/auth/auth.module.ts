import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuditModule } from '../audit/audit.module.js';
import { ENV } from '../config/config.module.js';
import { type Env } from '../config/env.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { DeviceGuard } from './device.guard.js';
import { HashingService } from './hashing.service.js';
import { RolesGuard } from './roles.guard.js';
import { TokenService } from './token.service.js';

/**
 * Global so other feature modules can use the guards and the hashing service
 * without re-importing. The guards themselves are registered as APP_GUARDs in
 * AppModule, where their order is visible in one place.
 */
@Global()
@Module({
  imports: [
    AuditModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_ACCESS_SECRET,
        signOptions: {
          algorithm: 'HS256',
          issuer: 'pos-api',
        },
        verifyOptions: {
          algorithms: ['HS256'],
          issuer: 'pos-api',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, HashingService, AccessTokenGuard, RolesGuard, DeviceGuard],
  exports: [AuthService, TokenService, HashingService, AccessTokenGuard, RolesGuard, DeviceGuard],
})
export class AuthModule {}
