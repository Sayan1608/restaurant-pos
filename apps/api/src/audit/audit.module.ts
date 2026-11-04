import { Global, Module } from '@nestjs/common';

import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

/** Global: almost every feature module records something. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
