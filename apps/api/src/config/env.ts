import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Environment validation.
 *
 * The process refuses to boot on a missing or malformed variable rather than
 * failing later, halfway through a sale, with a confusing stack trace. Every
 * variable the API reads is declared here and nowhere else -- there is no
 * `process.env` access anywhere past this file.
 */

const commaSeparated = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)));

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /** Origins allowed to call the API. Empty list disables CORS entirely. */
    CORS_ORIGINS: commaSeparated.default('http://localhost:5173'),

    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string.',
      }),

    REDIS_URL: z
      .string()
      .min(1)
      .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
        message: 'REDIS_URL must be a redis:// or rediss:// connection string.',
      })
      .default('redis://localhost:6379'),

    /** Reported by /healthz; set from the image tag or commit SHA in CI. */
    APP_VERSION: z.string().default('0.1.0-dev'),
  })
  .readonly();

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(
      [
        'Invalid environment configuration. The API will not start.',
        ...issues.map((issue) => `  - ${issue}`),
        '',
        'Copy .env.example to .env and fill it in.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Load the monorepo-root `.env` into process.env, if it exists.
 *
 * One .env at the root rather than one per app: the whole stack shares a
 * database and a Redis, and two copies of a connection string is one copy too
 * many. Real environment variables always win, so a container or CI can
 * override without a file. Uses Node's built-in loader -- no dotenv dependency.
 */
export function loadRootEnvFile(): void {
  // Walk up looking for the workspace root rather than counting `..` segments:
  // this file runs from src/ under `nest start` and from dist/ in production,
  // which are at different depths.
  let directory = __dirname;

  for (let hops = 0; hops < 8; hops += 1) {
    if (existsSync(resolve(directory, 'pnpm-workspace.yaml'))) {
      const envFile = resolve(directory, '.env');
      if (existsSync(envFile)) process.loadEnvFile(envFile);
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) return; // hit the filesystem root
    directory = parent;
  }
}

/** Parse and validate a raw environment bag. Throws EnvValidationError. */
export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new EnvValidationError(issues);
  }
  return result.data;
}

export const isProduction = (env: Env): boolean => env.NODE_ENV === 'production';
