import { Global, Module } from '@nestjs/common';

import { loadRootEnvFile, parseEnv, type Env } from './env.js';

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

/**
 * Validates the environment exactly once, at module construction, and shares
 * the frozen result. Injected as `@Inject(ENV) private readonly env: Env`.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => {
        loadRootEnvFile();
        return parseEnv(process.env);
      },
    },
  ],
  exports: [ENV],
})
export class AppConfigModule {}
