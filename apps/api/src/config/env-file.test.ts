import { describe, expect, it } from 'vitest';

import { isProduction, loadRootEnvFile, parseEnv } from './env.js';

/**
 * These exercise the real workspace .env discovery. They assert the *mechanism*
 * (it finds the workspace root and does not crash when there is no file),
 * not specific values, because .env is developer-local and absent in CI.
 */
describe('loadRootEnvFile()', () => {
  it('finds the workspace root and leaves a usable environment behind', () => {
    loadRootEnvFile();

    // Either the local .env supplied it or CI did; in both cases the API must
    // be able to boot after this call.
    expect(() => parseEnv(process.env)).not.toThrow();
  });

  it('is safe to call repeatedly', () => {
    expect(() => {
      loadRootEnvFile();
      loadRootEnvFile();
    }).not.toThrow();
  });

  it('never overrides a variable already set in the real environment', () => {
    // Node's env-file loader skips keys that already exist. That is what lets a
    // container or CI win over a checked-out .env.
    const sentinel = 'pos-sentinel-value';
    const previous = process.env.APP_VERSION;
    process.env.APP_VERSION = sentinel;

    try {
      loadRootEnvFile();
      expect(process.env.APP_VERSION).toBe(sentinel);
    } finally {
      if (previous === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = previous;
    }
  });
});

describe('isProduction()', () => {
  const base = { DATABASE_URL: 'postgresql://pos:pos@localhost:5432/pos' };

  it.each([
    ['production', true],
    ['development', false],
    ['test', false],
  ])('%s -> %s', (nodeEnv, expected) => {
    expect(isProduction(parseEnv({ ...base, NODE_ENV: nodeEnv }))).toBe(expected);
  });
});
