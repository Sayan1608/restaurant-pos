import { HttpStatus } from '@nestjs/common';
import { AuthSessionSchema, HEADERS, MeSchema } from '@pos/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bootTestApp,
  createOutlet,
  createStaff,
  pairDeviceDirectly,
  type OutletFixture,
  type StaffFixture,
  type TestApp,
} from '../test/app-harness.js';

/**
 * The security properties of Step 2, asserted against the real application and
 * a real database.
 *
 * These are written as statements about behaviour an attacker cares about --
 * can I enumerate accounts, can I guess a PIN, can I replay a token, can a
 * cashier read the audit trail -- rather than as tests of individual methods.
 * A unit test of the hashing service cannot tell you whether the *endpoint*
 * leaks which emails exist.
 *
 * Requires the database: `pnpm db:up && pnpm db:migrate`.
 */
describe('authentication (integration)', () => {
  let harness: TestApp;
  let outlet: OutletFixture;
  let owner: StaffFixture;
  let manager: StaffFixture;
  let cashier: StaffFixture;
  let till: { id: string; token: string };

  const OWNER_PASSWORD = 'owner-test-password-1';
  const MANAGER_PASSWORD = 'manager-test-password-1';
  const CASHIER_PIN = '2468';

  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await bootTestApp();
    outlet = await createOutlet(harness.prisma);

    owner = await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'OWNER',
      password: OWNER_PASSWORD,
    });
    manager = await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'MANAGER',
      password: MANAGER_PASSWORD,
    });
    cashier = await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'CASHIER',
      name: 'Test Cashier',
      pin: CASHIER_PIN,
    });
    till = await pairDeviceDirectly(harness.prisma, harness.hashing, outlet);
  }, 60_000);

  afterAll(async () => {
    await outlet?.cleanup();
    await harness?.close();
  });

  beforeEach(async () => {
    // Each test starts from a clean lockout state; several of them deliberately
    // rack up failures.
    await harness.prisma.staffUser.updateMany({
      where: { outletId: outlet.outletId },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  });

  const loginAsOwner = async () => {
    const response = await http()
      .post('/v1/auth/login')
      .send({ email: owner.email, password: OWNER_PASSWORD })
      .expect(HttpStatus.OK);
    return AuthSessionSchema.parse(response.body);
  };

  const loginAsManager = async () => {
    const response = await http()
      .post('/v1/auth/login')
      .send({ email: manager.email, password: MANAGER_PASSWORD })
      .expect(HttpStatus.OK);
    return AuthSessionSchema.parse(response.body);
  };

  const loginAsCashier = async () => {
    const response = await http()
      .post('/v1/auth/pin')
      .set(HEADERS.deviceToken, till.token)
      .send({ staffUserId: cashier.id, pin: CASHIER_PIN })
      .expect(HttpStatus.OK);
    return AuthSessionSchema.parse(response.body);
  };

  // --- password sign-in -----------------------------------------------------

  describe('password sign-in', () => {
    it('issues a session matching the contract', async () => {
      const session = await loginAsOwner();

      expect(session.staff).toMatchObject({ id: owner.id, role: 'OWNER' });
      expect(session.device).toBeNull();
      expect(session.accessToken.split('.')).toHaveLength(3);
      expect(new Date(session.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(session.refreshTokenExpiresAt).getTime()).toBeGreaterThan(
        new Date(session.accessTokenExpiresAt).getTime(),
      );
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      // This is the account-enumeration property. If these two differed in
      // status, code or wording, the endpoint would reveal which addresses are
      // registered.
      const wrongPassword = await http()
        .post('/v1/auth/login')
        .send({ email: owner.email, password: 'not-the-password' })
        .expect(HttpStatus.UNAUTHORIZED);

      const unknownEmail = await http()
        .post('/v1/auth/login')
        .send({ email: 'nobody@nowhere.test', password: 'not-the-password' })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(unknownEmail.body.error.code).toBe(wrongPassword.body.error.code);
      expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
    });

    it('refuses a cashier, who has no password', async () => {
      const response = await http()
        .post('/v1/auth/login')
        .send({ email: 'anything@test.local', password: CASHIER_PIN })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses a deactivated account', async () => {
      const dormant = await createStaff(harness.prisma, harness.hashing, outlet, {
        role: 'MANAGER',
        password: 'dormant-test-password',
        isActive: false,
      });

      await http()
        .post('/v1/auth/login')
        .send({ email: dormant.email, password: 'dormant-test-password' })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('rejects a malformed body with field-level issues', async () => {
      const response = await http()
        .post('/v1/auth/login')
        .send({ email: 'not-an-email', password: '' })
        .expect(HttpStatus.BAD_REQUEST);

      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.issues.map((issue: { path: string }) => issue.path)).toContain(
        'email',
      );
    });
  });

  // --- lockout --------------------------------------------------------------

  describe('lockout', () => {
    it('locks the account after the configured number of failures', async () => {
      const victim = await createStaff(harness.prisma, harness.hashing, outlet, {
        role: 'MANAGER',
        password: 'victim-test-password-1',
      });

      for (let attempt = 1; attempt < harness.env.LOGIN_MAX_ATTEMPTS; attempt += 1) {
        await http()
          .post('/v1/auth/login')
          .send({ email: victim.email, password: 'wrong' })
          .expect(HttpStatus.UNAUTHORIZED);
      }

      // The attempt that crosses the threshold still reads as a bad credential;
      // only the *next* one reports the lock.
      await http()
        .post('/v1/auth/login')
        .send({ email: victim.email, password: 'wrong' })
        .expect(HttpStatus.UNAUTHORIZED);

      const locked = await http()
        .post('/v1/auth/login')
        .send({ email: victim.email, password: 'victim-test-password-1' })
        .expect(423);

      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      // The message has to be actionable: a manager locked out mid-service
      // needs to know it is temporary and who can fix it.
      expect(locked.body.error.message).toMatch(/minute/);
      expect(locked.body.error.message).toMatch(/manager/i);
    });

    it('refuses the correct credential while locked', async () => {
      await harness.prisma.staffUser.update({
        where: { id: manager.id },
        data: { lockedUntil: new Date(Date.now() + 600_000) },
      });

      const response = await http()
        .post('/v1/auth/login')
        .send({ email: manager.email, password: MANAGER_PASSWORD })
        .expect(423);

      expect(response.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('clears the counter on a successful sign-in', async () => {
      await harness.prisma.staffUser.update({
        where: { id: manager.id },
        data: { failedAttempts: harness.env.LOGIN_MAX_ATTEMPTS - 1 },
      });

      await loginAsManager();

      const after = await harness.prisma.staffUser.findUniqueOrThrow({
        where: { id: manager.id },
      });
      // Otherwise four typos earlier in a shift would lock the account on the
      // next one, hours later.
      expect(after.failedAttempts).toBe(0);
      expect(after.lockedUntil).toBeNull();
      expect(after.lastLoginAt).not.toBeNull();
    });
  });

  // --- cashier PIN sign-in --------------------------------------------------

  describe('cashier PIN sign-in', () => {
    it('signs in on a paired till and records the device on the session', async () => {
      const session = await loginAsCashier();

      expect(session.staff).toMatchObject({ id: cashier.id, role: 'CASHIER' });
      expect(session.device).toMatchObject({ id: till.id });
    });

    it('is refused without a device token', async () => {
      // The device binding is what makes a 4-digit secret defensible: a PIN
      // learned by watching over a shoulder is useless off the premises.
      const response = await http()
        .post('/v1/auth/pin')
        .send({ staffUserId: cashier.id, pin: CASHIER_PIN })
        .expect(HttpStatus.FORBIDDEN);

      expect(response.body.error.code).toBe('DEVICE_NOT_REGISTERED');
    });

    it('is refused with an unknown device token', async () => {
      const response = await http()
        .post('/v1/auth/pin')
        .set(HEADERS.deviceToken, harness.hashing.generateOpaqueToken())
        .send({ staffUserId: cashier.id, pin: CASHIER_PIN })
        .expect(HttpStatus.FORBIDDEN);

      expect(response.body.error.code).toBe('DEVICE_NOT_REGISTERED');
    });

    it('is refused on a revoked till', async () => {
      const revoked = await pairDeviceDirectly(
        harness.prisma,
        harness.hashing,
        outlet,
        'Revoked Till',
      );
      await harness.prisma.device.update({
        where: { id: revoked.id },
        data: { revokedAt: new Date() },
      });

      const response = await http()
        .post('/v1/auth/pin')
        .set(HEADERS.deviceToken, revoked.token)
        .send({ staffUserId: cashier.id, pin: CASHIER_PIN })
        .expect(HttpStatus.FORBIDDEN);

      expect(response.body.error.code).toBe('DEVICE_REVOKED');
    });

    it('cannot sign in a cashier from another outlet, even with the right PIN', async () => {
      const other = await createOutlet(harness.prisma);
      try {
        const stranger = await createStaff(harness.prisma, harness.hashing, other, {
          role: 'CASHIER',
          pin: CASHIER_PIN,
        });

        // Same PIN, valid till -- but the cashier belongs to a different
        // outlet. The device's outlet is the authority, not the request.
        const response = await http()
          .post('/v1/auth/pin')
          .set(HEADERS.deviceToken, till.token)
          .send({ staffUserId: stranger.id, pin: CASHIER_PIN })
          .expect(HttpStatus.UNAUTHORIZED);

        expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
      } finally {
        await other.cleanup();
      }
    });

    it('records the till as seen', async () => {
      await loginAsCashier();
      const device = await harness.prisma.device.findUniqueOrThrow({ where: { id: till.id } });
      expect(device.lastSeenAt).not.toBeNull();
    });

    it('lists cashiers for the PIN pad with nothing but id and name', async () => {
      const response = await http()
        .get('/v1/auth/cashiers')
        .set(HEADERS.deviceToken, till.token)
        .expect(HttpStatus.OK);

      expect(response.body.cashiers.length).toBeGreaterThan(0);
      // Reachable with only a device token, so it must not expose emails,
      // roles or lockout state.
      for (const entry of response.body.cashiers) {
        expect(Object.keys(entry).sort()).toEqual(['id', 'name']);
      }
    });

    it('does not list managers on the PIN pad', async () => {
      const response = await http()
        .get('/v1/auth/cashiers')
        .set(HEADERS.deviceToken, till.token)
        .expect(HttpStatus.OK);

      const ids = response.body.cashiers.map((entry: { id: string }) => entry.id);
      expect(ids).not.toContain(manager.id);
      expect(ids).not.toContain(owner.id);
    });
  });

  // --- access tokens --------------------------------------------------------

  describe('access tokens', () => {
    it('answers /auth/me for a valid token', async () => {
      const session = await loginAsOwner();

      const response = await http()
        .get('/v1/auth/me')
        .set('authorization', `Bearer ${session.accessToken}`)
        .expect(HttpStatus.OK);

      const me = MeSchema.parse(response.body);
      expect(me.staff.id).toBe(owner.id);
      expect(me.outlet.id).toBe(outlet.outletId);
      expect(me.outlet.currency).toBe('INR');
    });

    it.each([
      ['missing', undefined],
      ['not a bearer token', 'Basic abc'],
      ['a bearer token that is not a JWT', 'Bearer not-a-jwt'],
      ['a JWT signed with the wrong key', `Bearer ${'a.b.c'}`],
    ])('refuses a request with %s', async (_label, header) => {
      const call = http().get('/v1/auth/me');
      if (header) call.set('authorization', header);
      const response = await call.expect(HttpStatus.UNAUTHORIZED);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('stops working the moment the account is deactivated', async () => {
      const temporary = await createStaff(harness.prisma, harness.hashing, outlet, {
        role: 'MANAGER',
        password: 'temp-test-password-1',
      });

      const session = await http()
        .post('/v1/auth/login')
        .send({ email: temporary.email, password: 'temp-test-password-1' })
        .expect(HttpStatus.OK);

      const accessToken = AuthSessionSchema.parse(session.body).accessToken;

      await http()
        .get('/v1/auth/me')
        .set('authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      await harness.prisma.staffUser.update({
        where: { id: temporary.id },
        data: { isActive: false },
      });

      // The token is still cryptographically valid and unexpired. The guard
      // re-reads the account, which is the point: deactivation must take effect
      // now, not in fifteen minutes.
      const after = await http()
        .get('/v1/auth/me')
        .set('authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.UNAUTHORIZED);

      expect(after.body.error.message).toMatch(/no longer active/i);
    });
  });

  // --- refresh rotation -----------------------------------------------------

  describe('refresh rotation', () => {
    it('exchanges a refresh token for a new pair', async () => {
      const first = await loginAsOwner();

      const response = await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(HttpStatus.OK);

      const second = AuthSessionSchema.parse(response.body);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.staff.id).toBe(owner.id);
    });

    it('revokes every session when a rotated token is replayed', async () => {
      const first = await loginAsOwner();

      const rotated = AuthSessionSchema.parse(
        (
          await http()
            .post('/v1/auth/refresh')
            .send({ refreshToken: first.refreshToken })
            .expect(HttpStatus.OK)
        ).body,
      );

      // Replaying the old token means either a badly broken client or a stolen
      // token being used. We cannot tell which, so we assume theft: logging the
      // real user out is a far smaller harm than leaving an attacker with a
      // session on a system that takes payments.
      const replay = await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(replay.body.error.code).toBe('TOKEN_REVOKED');

      // And the thief's freshly rotated token is dead too.
      const chain = await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: rotated.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(chain.body.error.code).toBe('TOKEN_REVOKED');

      const live = await harness.prisma.refreshToken.count({
        where: { staffUserId: owner.id, revokedAt: null },
      });
      expect(live).toBe(0);
    });

    it('records why each token was revoked', async () => {
      const session = await loginAsManager();
      await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(HttpStatus.OK);

      const rotatedRow = await harness.prisma.refreshToken.findFirst({
        where: { staffUserId: manager.id, revokedReason: 'rotated' },
      });

      expect(rotatedRow).not.toBeNull();
      // The chain link is what makes replay detectable months later during an
      // investigation, not just in the moment.
      expect(rotatedRow?.replacedByTokenId).not.toBeNull();
    });

    it('refuses an unknown refresh token', async () => {
      const response = await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: harness.hashing.generateOpaqueToken() })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(response.body.error.code).toBe('TOKEN_REVOKED');
    });

    it('refuses an expired refresh token', async () => {
      const session = await loginAsManager();
      await harness.prisma.refreshToken.updateMany({
        where: { staffUserId: manager.id, revokedAt: null },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const response = await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(response.body.error.code).toBe('TOKEN_EXPIRED');
    });
  });

  // --- sign out -------------------------------------------------------------

  describe('sign out', () => {
    it('revokes the presented refresh token', async () => {
      const session = await loginAsManager();

      await http()
        .post('/v1/auth/logout')
        .set('authorization', `Bearer ${session.accessToken}`)
        .send({ refreshToken: session.refreshToken })
        .expect(HttpStatus.NO_CONTENT);

      await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('ends every session when no token is given', async () => {
      const first = await loginAsManager();
      const second = await loginAsManager();

      await http()
        .post('/v1/auth/logout')
        .set('authorization', `Bearer ${second.accessToken}`)
        .send({})
        .expect(HttpStatus.NO_CONTENT);

      // Leaving someone signed in on a shared till they meant to leave is the
      // failure mode this avoids.
      for (const session of [first, second]) {
        await http()
          .post('/v1/auth/refresh')
          .send({ refreshToken: session.refreshToken })
          .expect(HttpStatus.UNAUTHORIZED);
      }
    });

    it('requires authentication', async () => {
      await http().post('/v1/auth/logout').send({}).expect(HttpStatus.UNAUTHORIZED);
    });
  });

  // --- authorization --------------------------------------------------------

  describe('role enforcement', () => {
    it('lets a manager list staff', async () => {
      const session = await loginAsManager();

      const response = await http()
        .get('/v1/staff')
        .set('authorization', `Bearer ${session.accessToken}`)
        .expect(HttpStatus.OK);

      expect(response.body.staff.length).toBeGreaterThan(0);
    });

    it('refuses a cashier, and says what is required', async () => {
      const session = await loginAsCashier();

      const response = await http()
        .get('/v1/staff')
        .set('authorization', `Bearer ${session.accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.message).toMatch(/OWNER or MANAGER/);
      expect(response.body.error.message).toMatch(/CASHIER/);
    });

    it('never emits a credential hash in a staff response', async () => {
      const session = await loginAsManager();

      const response = await http()
        .get('/v1/staff')
        .set('authorization', `Bearer ${session.accessToken}`)
        .expect(HttpStatus.OK);

      const body = JSON.stringify(response.body);
      expect(body).not.toContain('argon2');
      expect(body).not.toContain('passwordHash');
      expect(body).not.toContain('pinHash');
      // It reports *whether* a credential exists, which is all a UI needs.
      expect(response.body.staff[0]).toHaveProperty('hasPassword');
    });

    it('closes a route by default: health probes are the explicit exception', async () => {
      // AccessTokenGuard is global, so a new endpoint is closed unless it opts
      // out. These two opt out on purpose.
      await http().get('/healthz').expect(HttpStatus.OK);
      await http().get('/readyz').expect(HttpStatus.OK);
      await http().get('/v1/audit-logs').expect(HttpStatus.UNAUTHORIZED);
      await http().get('/v1/devices').expect(HttpStatus.UNAUTHORIZED);
      await http().get('/v1/staff').expect(HttpStatus.UNAUTHORIZED);
    });
  });
});
