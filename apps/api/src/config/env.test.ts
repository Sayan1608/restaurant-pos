import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://pos:pos@localhost:5432/pos?schema=public',
  JWT_ACCESS_SECRET: 'test-only-secret-0123456789abcdefghijklmnop',
};

describe('parseEnv()', () => {
  it('applies defaults around the required variables', () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('coerces PORT from its string form', () => {
    expect(parseEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('splits and trims the CORS origin list', () => {
    const env = parseEnv({
      ...valid,
      CORS_ORIGINS: 'http://localhost:5173, https://pos.example.com ,',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://pos.example.com']);
  });

  it('fails fast without a database URL', () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
  });

  it('names every offending variable in the message', () => {
    try {
      parseEnv({ DATABASE_URL: 'mysql://nope', PORT: '70000', LOG_LEVEL: 'chatty' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('PORT');
      expect(message).toContain('LOG_LEVEL');
      expect(message).toContain('.env.example');
    }
  });

  it('rejects an unusable NODE_ENV rather than guessing', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  describe('auth settings', () => {
    it('refuses to boot without a signing secret', () => {
      const { JWT_ACCESS_SECRET: _omitted, ...withoutSecret } = valid;
      // No default on purpose: a fallback signing secret is the kind of thing
      // that reaches production and lets anyone forge a manager token.
      expect(() => parseEnv(withoutSecret)).toThrow(/JWT_ACCESS_SECRET/);
    });

    it('refuses a signing secret narrower than its own digest', () => {
      expect(() => parseEnv({ ...valid, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
        /at least 32 characters/,
      );
    });

    it('tells the operator how to generate one', () => {
      try {
        parseEnv({ ...valid, JWT_ACCESS_SECRET: 'short' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('randomBytes');
      }
    });

    it('defaults the token lifetimes to sane values', () => {
      const env = parseEnv(valid);
      // Short access token: it cannot be revoked before it expires.
      expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
      // Long refresh token: a till must not log itself out mid-shift.
      expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
      expect(env.LOGIN_MAX_ATTEMPTS).toBe(5);
      expect(env.LOGIN_LOCKOUT_MINUTES).toBe(15);
      expect(env.PAIRING_CODE_TTL_MINUTES).toBe(10);
    });

    it('refuses an access token lifetime long enough to defeat revocation', () => {
      expect(() => parseEnv({ ...valid, ACCESS_TOKEN_TTL_SECONDS: '86400' })).toThrow();
    });

    it('refuses a lockout threshold low enough to lock out honest typos', () => {
      expect(() => parseEnv({ ...valid, LOGIN_MAX_ATTEMPTS: '1' })).toThrow();
    });
  });
});
