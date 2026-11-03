import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://pos:pos@localhost:5432/pos?schema=public',
};

describe('parseEnv()', () => {
  it('applies defaults around the one required variable', () => {
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
});
