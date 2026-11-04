import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@pos/contracts';
import helmet from 'helmet';

import { type Env } from './config/env.js';

/**
 * Everything that turns a compiled Nest application into *our* HTTP surface.
 *
 * Kept separate from main.ts so the integration tests configure the app
 * exactly the way production does. A test that re-implements this wiring is a
 * test that can pass while the real server is misconfigured.
 */
export function configureApp(app: INestApplication, env: Env): void {
  app.use(helmet());

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    // Exposed so the POS client can show the request id on an error screen --
    // that one string is what support needs to find the server-side log line.
    exposedHeaders: ['x-request-id'],
  });

  // Business endpoints are versioned; probes are not, so an orchestrator's
  // health check never has to track an API version.
  //
  // Nest 11 on Express 5 logs an "Unsupported route path: /v1/*" warning at
  // boot because of this `exclude`, and auto-converts it to `/v1/{*path}`.
  // It is cosmetic and comes from Nest's own internals -- not worth versioning
  // the probes to silence.
  app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz', 'readyz'] });

  // Finish in-flight requests on SIGTERM instead of dropping a sale mid-write.
  app.enableShutdownHooks();
}
