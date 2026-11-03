import { describe, expect, it } from 'vitest';

import { ERROR_CODES, ERROR_STATUS, ApiErrorSchema } from './errors.js';
import { GstinSchema } from './tenancy.js';

describe('GstinSchema', () => {
  it('accepts a valid GSTIN and normalises case', () => {
    expect(GstinSchema.parse(' 29abcde1234f1z5 ')).toBe('29ABCDE1234F1Z5');
  });

  it.each([
    ['too short', '29ABCDE1234F1Z'],
    ['missing Z', '29ABCDE1234F1X5'],
    ['letters in the state code', 'XXABCDE1234F1Z5'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(GstinSchema.safeParse(value).success).toBe(false);
  });
});

describe('error envelope', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(Object.keys(ERROR_STATUS)).toHaveLength(ERROR_CODES.length);
  });

  it('validates a well-formed error body', () => {
    const parsed = ApiErrorSchema.safeParse({
      error: {
        code: 'NOT_FOUND',
        message: 'Order not found.',
        requestId: 'req_123',
        timestamp: new Date().toISOString(),
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown error code', () => {
    const parsed = ApiErrorSchema.safeParse({
      error: {
        code: 'KABOOM',
        message: 'x',
        requestId: 'r',
        timestamp: new Date().toISOString(),
      },
    });
    expect(parsed.success).toBe(false);
  });
});
