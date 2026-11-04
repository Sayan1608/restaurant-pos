import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { API_PREFIX } from '@pos/contracts';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { ENV } from './config/config.module.js';
import { EnvValidationError, type Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  const env = app.get<Env>(ENV);
  configureApp(app, env);

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
