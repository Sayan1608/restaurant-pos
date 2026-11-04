import { describe, expect, it } from 'vitest';

import { DependencyStatusSchema, LivenessSchema, ReadinessSchema } from './health.js';
import { API_PREFIX, HEADERS } from './http.js';

const now = () => new Date().toISOString();

describe('LivenessSchema', () => {
  it('accepts a well-formed liveness body', () => {
    expect(
      LivenessSchema.parse({
        status: 'ok',
        service: 'pos-api',
        version: '0.1.0',
        uptimeSeconds: 0,
        timestamp: now(),
      }).status,
    ).toBe('ok');
  });

  it.each([
    ['a status other than ok', { status: 'degraded' }],
    ['a negative uptime', { uptimeSeconds: -1 }],
    ['a non-ISO timestamp', { timestamp: '2026-11-04' }],
    ['a missing version', { version: undefined }],
  ])('rejects %s', (_label, override) => {
    const parsed = LivenessSchema.safeParse({
      status: 'ok',
      service: 'pos-api',
      version: '0.1.0',
      uptimeSeconds: 1,
      timestamp: now(),
      ...override,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('DependencyStatusSchema', () => {
  it('allows a bare up report with no latency', () => {
    expect(DependencyStatusSchema.safeParse({ name: 'postgres', status: 'up' }).success).toBe(true);
  });

  it('carries a failure reason when down', () => {
    const parsed = DependencyStatusSchema.parse({
      name: 'postgres',
      status: 'down',
      error: 'connection refused',
      latencyMs: 2000,
    });
    expect(parsed.error).toBe('connection refused');
  });

  it('rejects an invented status', () => {
    expect(DependencyStatusSchema.safeParse({ name: 'redis', status: 'flaky' }).success).toBe(
      false,
    );
  });
});

describe('ReadinessSchema', () => {
  it('accepts an empty dependency list', () => {
    expect(
      ReadinessSchema.parse({ status: 'ok', dependencies: [], timestamp: now() }).dependencies,
    ).toEqual([]);
  });

  it('accepts a degraded report', () => {
    const parsed = ReadinessSchema.parse({
      status: 'degraded',
      dependencies: [{ name: 'postgres', status: 'down', error: 'timeout' }],
      timestamp: now(),
    });
    expect(parsed.status).toBe('degraded');
  });

  it('rejects a dependency list that is not a list', () => {
    expect(
      ReadinessSchema.safeParse({ status: 'ok', dependencies: {}, timestamp: now() }).success,
    ).toBe(false);
  });
});

describe('HTTP conventions', () => {
  it('pins the version prefix', () => {
    // Changing this is a breaking change for every deployed POS client.
    expect(API_PREFIX).toBe('v1');
  });

  it('pins the header names both sides rely on', () => {
    expect(HEADERS.requestId).toBe('x-request-id');
    expect(HEADERS.idempotencyKey).toBe('idempotency-key');
    expect(HEADERS.ifMatchVersion).toBe('if-match-version');
  });

  it('keeps header names lower-case, as Node normalises them', () => {
    for (const header of Object.values(HEADERS)) {
      expect(header).toBe(header.toLowerCase());
    }
  });
});
