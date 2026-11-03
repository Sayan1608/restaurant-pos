import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { API_PREFIX } from '@pos/contracts';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { ENV } from './config/config.module.js';
import { EnvValidationError, type Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  const env = app.get<Env>(ENV);

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

  await app.listen(env.PORT, '0.0.0.0');

  app
    .get(Logger)
    .log(
      `pos-api ${env.APP_VERSION} listening on :${env.PORT} ` +
        `[${env.NODE_ENV}] prefix=/${API_PREFIX}`,
    );
}

bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    // A config problem is the operator's to fix: print it plainly, with no
    // stack trace to wade through.
    console.error(`\n${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
