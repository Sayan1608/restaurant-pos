import { parseEnv, type Env } from '../config/env.js';

/**
 * A valid environment for tests, so every suite does not repeat the required
 * variables -- and so adding a new required variable is a one-line fix here
 * rather than a sweep across every test file.
 */
export const TEST_JWT_SECRET = 'test-only-secret-0123456789abcdefghijklmnop';

export function testEnv(overrides: Record<string, string | number> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://pos:pos@localhost:5432/pos',
    JWT_ACCESS_SECRET: TEST_JWT_SECRET,
    ...overrides,
  });
}
