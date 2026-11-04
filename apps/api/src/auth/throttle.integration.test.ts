import { HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootTestApp,
  createOutlet,
  createStaff,
  type OutletFixture,
  type TestApp,
} from '../test/app-harness.js';

/**
 * Rate limiting, with the real limiter in place.
 *
 * The rest of the suite replaces the throttler's counter, because the sign-in
 * limits are deliberately tight and dozens of test logins would trip them. That
 * makes this file necessary: without it, the suite would never actually prove
 * the limiter works, and a misconfiguration would pass CI unnoticed.
 *
 * What it protects: the per-account lockout stops a *targeted* attack on one
 * cashier, but it does nothing against someone spraying one guess each across
 * many accounts. The rate limit is what bounds that.
 *
 * Requires the database: `pnpm db:up && pnpm db:migrate`.
 */
describe('rate limiting (integration)', () => {
  let harness: TestApp;
  let outlet: OutletFixture;

  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await bootTestApp({ throttle: true });
    outlet = await createOutlet(harness.prisma);
    await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'MANAGER',
      email: 'throttled@test.local',
      password: 'throttle-test-password-1',
    });
  }, 60_000);

  afterAll(async () => {
    await outlet?.cleanup();
    await harness?.close();
  });

  it('stops a burst of sign-in attempts with 429', async () => {
    const statuses: number[] = [];

    // The `auth` bucket allows 10 a minute. Spraying 15 distinct addresses
    // never triggers a per-account lockout, so only the rate limit can stop it.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await http()
        .post('/v1/auth/login')
        .send({ email: `sprayed-${attempt}@test.local`, password: 'guess-guess-guess' });
      statuses.push(response.status);
    }

    expect(statuses).toContain(HttpStatus.TOO_MANY_REQUESTS);

    const allowed = statuses.filter((status) => status !== HttpStatus.TOO_MANY_REQUESTS).length;
    expect(allowed).toBeLessThanOrEqual(10);
  }, 30_000);

  it('does not throttle the health probes', async () => {
    // An orchestrator polls these every few seconds; limiting them would get
    // a healthy instance killed.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await http().get('/healthz').expect(HttpStatus.OK);
    }
  }, 30_000);
});
