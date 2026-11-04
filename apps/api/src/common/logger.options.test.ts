import { describe, expect, it, vi } from 'vitest';

import { parseEnv, type Env } from '../config/env.js';
import { buildPinoHttpOptions } from './logger.options.js';

const envFor = (overrides: Record<string, string> = {}): Env =>
  parseEnv({
    DATABASE_URL: 'postgresql://pos:pos@localhost:5432/pos',
    JWT_ACCESS_SECRET: 'test-only-secret-0123456789abcdefghijklmnop',
    ...overrides,
  });

type Options = NonNullable<ReturnType<typeof buildPinoHttpOptions>>;

function genReqId(options: Options, headers: Record<string, string | string[]> = {}) {
  const setHeader = vi.fn();
  const id = options.genReqId?.({ headers, url: '/v1/orders' } as never, { setHeader } as never);
  return { id: String(id), setHeader };
}

describe('buildPinoHttpOptions()', () => {
  it('uses the configured level', () => {
    expect(buildPinoHttpOptions(envFor({ LOG_LEVEL: 'warn' }))?.level).toBe('warn');
  });

  describe('request ids', () => {
    it('generates a UUID when the request has none', () => {
      const { id, setHeader } = genReqId(buildPinoHttpOptions(envFor()) as Options);

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(setHeader).toHaveBeenCalledWith('x-request-id', id);
    });

    it('reuses an id supplied upstream so a trace survives the proxy', () => {
      const { id, setHeader } = genReqId(buildPinoHttpOptions(envFor()) as Options, {
        'x-request-id': 'edge-trace-1',
      });

      expect(id).toBe('edge-trace-1');
      expect(setHeader).toHaveBeenCalledWith('x-request-id', 'edge-trace-1');
    });

    it('takes the first value if the header is repeated', () => {
      const { id } = genReqId(buildPinoHttpOptions(envFor()) as Options, {
        'x-request-id': ['first', 'second'],
      });

      expect(id).toBe('first');
    });

    it('generates distinct ids per request', () => {
      const options = buildPinoHttpOptions(envFor()) as Options;
      expect(genReqId(options).id).not.toBe(genReqId(options).id);
    });
  });

  describe('probe filtering', () => {
    const ignore = (url: string) => {
      const options = buildPinoHttpOptions(envFor()) as Options;
      const autoLogging = options.autoLogging as { ignore: (req: unknown) => boolean };
      return autoLogging.ignore({ url } as never);
    };

    it.each([
      ['/healthz', true],
      ['/readyz', true],
      ['/v1/orders', false],
      ['/', false],
    ])('%s ignored: %s', (url, expected) => {
      expect(ignore(url)).toBe(expected);
    });
  });

  describe('redaction', () => {
    const paths = () => {
      const redact = (buildPinoHttpOptions(envFor()) as Options).redact as {
        paths: string[];
        censor: string;
      };
      return redact;
    };

    it.each([
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.pin',
      'req.body.password',
      'req.body.phone',
      'req.body.email',
    ])('redacts %s', (path) => {
      expect(paths().paths).toContain(path);
    });

    it('censors rather than deletes, so the shape of the log stays stable', () => {
      expect(paths().censor).toBe('[redacted]');
    });
  });

  describe('transport', () => {
    it('is pretty in development only', () => {
      const development = buildPinoHttpOptions(envFor({ NODE_ENV: 'development' }));
      expect(development?.transport).toMatchObject({ target: 'pino-pretty' });
    });

    it.each(['production', 'test'])('is raw JSON in %s', (nodeEnv) => {
      expect(buildPinoHttpOptions(envFor({ NODE_ENV: nodeEnv }))?.transport).toBeUndefined();
    });
  });
});
