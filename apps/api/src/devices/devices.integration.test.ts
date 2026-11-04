import { HttpStatus } from '@nestjs/common';
import {
  AuthSessionSchema,
  HEADERS,
  PairedDeviceSchema,
  PairingCodeIssuedSchema,
} from '@pos/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootTestApp,
  createOutlet,
  createStaff,
  type OutletFixture,
  type StaffFixture,
  type TestApp,
} from '../test/app-harness.js';

/**
 * Device pairing, end to end.
 *
 * The properties under test are all about the pairing code being a credential:
 * single use, short lived, unguessable, and useless for learning anything when
 * it fails.
 *
 * Requires the database: `pnpm db:up && pnpm db:migrate`.
 */
describe('device pairing (integration)', () => {
  let harness: TestApp;
  let outlet: OutletFixture;
  let manager: StaffFixture;
  let cashier: StaffFixture;
  let managerToken: string;

  const MANAGER_PASSWORD = 'manager-test-password-1';
  const CASHIER_PIN = '1357';

  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await bootTestApp();
    outlet = await createOutlet(harness.prisma);

    manager = await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'MANAGER',
      password: MANAGER_PASSWORD,
    });
    cashier = await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'CASHIER',
      pin: CASHIER_PIN,
    });

    const session = await http()
      .post('/v1/auth/login')
      .send({ email: manager.email, password: MANAGER_PASSWORD })
      .expect(HttpStatus.OK);
    managerToken = AuthSessionSchema.parse(session.body).accessToken;
  }, 60_000);

  afterAll(async () => {
    await outlet?.cleanup();
    await harness?.close();
  });

  const issueCode = async (deviceName = 'Counter Till') => {
    const response = await http()
      .post('/v1/devices/pairing-codes')
      .set('authorization', `Bearer ${managerToken}`)
      .send({ deviceName })
      .expect(HttpStatus.CREATED);
    return PairingCodeIssuedSchema.parse(response.body);
  };

  it('issues a readable, time-limited code', async () => {
    const issued = await issueCode();

    expect(issued.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    const ttlMinutes = (new Date(issued.expiresAt).getTime() - Date.now()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(0);
    expect(ttlMinutes).toBeLessThanOrEqual(harness.env.PAIRING_CODE_TTL_MINUTES);
  });

  it('stores only the hash of the code', async () => {
    const issued = await issueCode('Hash Check Till');

    const row = await harness.prisma.pairingCode.findFirstOrThrow({
      where: { outletId: outlet.outletId, deviceName: 'Hash Check Till' },
    });

    // The code is a credential until redeemed, so the database must not hold it.
    expect(row.codeHash).not.toBe(issued.code);
    expect(row.codeHash).toBe(harness.hashing.fingerprint(issued.code));
  });

  it('redeems a code for a device token', async () => {
    const issued = await issueCode('Redeem Till');

    const response = await http()
      .post('/v1/devices/pair')
      .send({ code: issued.code })
      .expect(HttpStatus.CREATED);

    const paired = PairedDeviceSchema.parse(response.body);
    expect(paired.device.name).toBe('Redeem Till');
    expect(paired.device.isActive).toBe(true);
    expect(paired.outlet.id).toBe(outlet.outletId);
    expect(Buffer.from(paired.deviceToken, 'base64url')).toHaveLength(32);

    // Again: only the fingerprint is persisted, so a database leak yields no
    // working device credential.
    const row = await harness.prisma.device.findUniqueOrThrow({
      where: { id: paired.device.id },
    });
    expect(row.tokenHash).toBe(harness.hashing.fingerprint(paired.deviceToken));
  });

  it('refuses the same code twice', async () => {
    const issued = await issueCode('Single Use Till');

    await http().post('/v1/devices/pair').send({ code: issued.code }).expect(HttpStatus.CREATED);

    const second = await http().post('/v1/devices/pair').send({ code: issued.code }).expect(422);

    expect(second.body.error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('refuses an expired code', async () => {
    const issued = await issueCode('Expired Till');
    await harness.prisma.pairingCode.updateMany({
      where: { codeHash: harness.hashing.fingerprint(issued.code) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const response = await http().post('/v1/devices/pair').send({ code: issued.code }).expect(422);

    expect(response.body.error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('gives the same answer for unknown, used and expired codes', async () => {
    const used = await issueCode('Indistinguishable A');
    await http().post('/v1/devices/pair').send({ code: used.code }).expect(HttpStatus.CREATED);

    const expired = await issueCode('Indistinguishable B');
    await harness.prisma.pairingCode.updateMany({
      where: { codeHash: harness.hashing.fingerprint(expired.code) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const messages = new Set<string>();
    for (const code of [used.code, expired.code, 'ZZZZ2345']) {
      const response = await http().post('/v1/devices/pair').send({ code }).expect(422);
      messages.add(`${response.body.error.code}:${response.body.error.message}`);
    }

    // One message for every failure: the endpoint must not confirm that a code
    // exists, or that it once did.
    expect(messages.size).toBe(1);
  });

  it('rejects a code that is not even the right shape, without touching the database', async () => {
    const response = await http()
      .post('/v1/devices/pair')
      .send({ code: 'nope' })
      .expect(HttpStatus.BAD_REQUEST);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('needs manager rights to issue a code', async () => {
    // Each step awaited separately: nesting an `await` inside a supertest
    // request's own construction races the server's listen setup.
    const issued = await issueCode('Cashier Till');

    const pairResponse = await http()
      .post('/v1/devices/pair')
      .send({ code: issued.code })
      .expect(HttpStatus.CREATED);
    const paired = PairedDeviceSchema.parse(pairResponse.body);

    const cashierSession = AuthSessionSchema.parse(
      (
        await http()
          .post('/v1/auth/pin')
          .set(HEADERS.deviceToken, paired.deviceToken)
          .send({ staffUserId: cashier.id, pin: CASHIER_PIN })
          .expect(HttpStatus.OK)
      ).body,
    );

    // A cashier enrolling new tills would defeat the whole arrangement.
    await http()
      .post('/v1/devices/pairing-codes')
      .set('authorization', `Bearer ${cashierSession.accessToken}`)
      .send({ deviceName: 'Rogue Till' })
      .expect(HttpStatus.FORBIDDEN);
  });

  it('lists the outlet tills for a manager', async () => {
    const response = await http()
      .get('/v1/devices')
      .set('authorization', `Bearer ${managerToken}`)
      .expect(HttpStatus.OK);

    expect(response.body.devices.length).toBeGreaterThan(0);
    // No token or hash in the listing.
    expect(JSON.stringify(response.body)).not.toContain('tokenHash');
    expect(Object.keys(response.body.devices[0]).sort()).toEqual([
      'id',
      'isActive',
      'lastSeenAt',
      'name',
      'outletId',
      'pairedAt',
      'revokedAt',
    ]);
  });

  describe('revoking a till', () => {
    it('unpairs it and ends its sessions', async () => {
      const issued = await issueCode('Doomed Till');
      const paired = PairedDeviceSchema.parse(
        (
          await http()
            .post('/v1/devices/pair')
            .send({ code: issued.code })
            .expect(HttpStatus.CREATED)
        ).body,
      );

      const cashierSession = AuthSessionSchema.parse(
        (
          await http()
            .post('/v1/auth/pin')
            .set(HEADERS.deviceToken, paired.deviceToken)
            .send({ staffUserId: cashier.id, pin: CASHIER_PIN })
            .expect(HttpStatus.OK)
        ).body,
      );

      const revoked = await http()
        .delete(`/v1/devices/${paired.device.id}`)
        .set('authorization', `Bearer ${managerToken}`)
        .expect(HttpStatus.OK);

      expect(revoked.body.isActive).toBe(false);
      expect(revoked.body.revokedAt).not.toBeNull();

      // A lost tablet must stop working now, not when its refresh token
      // eventually expires thirty days later.
      await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: cashierSession.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);

      await http()
        .post('/v1/auth/pin')
        .set(HEADERS.deviceToken, paired.deviceToken)
        .send({ staffUserId: cashier.id, pin: CASHIER_PIN })
        .expect(HttpStatus.FORBIDDEN);
    });

    it('is idempotent', async () => {
      const issued = await issueCode('Twice Revoked Till');
      const paired = PairedDeviceSchema.parse(
        (
          await http()
            .post('/v1/devices/pair')
            .send({ code: issued.code })
            .expect(HttpStatus.CREATED)
        ).body,
      );

      const first = await http()
        .delete(`/v1/devices/${paired.device.id}`)
        .set('authorization', `Bearer ${managerToken}`)
        .expect(HttpStatus.OK);

      const second = await http()
        .delete(`/v1/devices/${paired.device.id}`)
        .set('authorization', `Bearer ${managerToken}`)
        .expect(HttpStatus.OK);

      expect(second.body.revokedAt).toBe(first.body.revokedAt);
    });

    it('cannot revoke a till belonging to another outlet', async () => {
      const other = await createOutlet(harness.prisma);
      try {
        const token = harness.hashing.generateOpaqueToken();
        const theirs = await harness.prisma.device.create({
          data: {
            tenantId: other.tenantId,
            outletId: other.outletId,
            name: 'Their Till',
            tokenHash: harness.hashing.fingerprint(token),
          },
        });

        // Answers "not found" rather than "forbidden": confirming the id exists
        // elsewhere would itself be a leak.
        const response = await http()
          .delete(`/v1/devices/${theirs.id}`)
          .set('authorization', `Bearer ${managerToken}`)
          .expect(HttpStatus.NOT_FOUND);

        expect(response.body.error.code).toBe('NOT_FOUND');

        const untouched = await harness.prisma.device.findUniqueOrThrow({
          where: { id: theirs.id },
        });
        expect(untouched.revokedAt).toBeNull();
      } finally {
        await other.cleanup();
      }
    });

    it('rejects an id that is not a UUID', async () => {
      await http()
        .delete('/v1/devices/not-a-uuid')
        .set('authorization', `Bearer ${managerToken}`)
        .expect(HttpStatus.BAD_REQUEST);
    });
  });
});
