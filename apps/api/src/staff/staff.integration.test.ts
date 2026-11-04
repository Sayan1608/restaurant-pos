import { HttpStatus } from '@nestjs/common';
import { AuthSessionSchema, HEADERS, StaffUserSchema } from '@pos/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
 * Staff administration, with the privilege-escalation paths explicitly closed.
 *
 * Requires the database: `pnpm db:up && pnpm db:migrate`.
 */
describe('staff administration (integration)', () => {
  let harness: TestApp;
  let outlet: OutletFixture;
  let owner: StaffFixture;
  let manager: StaffFixture;
  let ownerToken: string;
  let managerToken: string;
  let till: { id: string; token: string };

  const PASSWORD = 'admin-test-password-1';

  const http = () => request(harness.app.getHttpServer());

  const tokenFor = async (email: string | null, password: string) =>
    AuthSessionSchema.parse(
      (await http().post('/v1/auth/login').send({ email, password }).expect(HttpStatus.OK)).body,
    ).accessToken;

  beforeAll(async () => {
    harness = await bootTestApp();
    outlet = await createOutlet(harness.prisma);

    owner = await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'OWNER',
      password: PASSWORD,
    });
    manager = await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'MANAGER',
      password: PASSWORD,
    });
    till = await pairDeviceDirectly(harness.prisma, harness.hashing, outlet);

    ownerToken = await tokenFor(owner.email, PASSWORD);
    managerToken = await tokenFor(manager.email, PASSWORD);
  }, 60_000);

  afterAll(async () => {
    await outlet?.cleanup();
    await harness?.close();
  });

  describe('creating staff', () => {
    it('creates a cashier with a PIN who can then sign in', async () => {
      const created = await http()
        .post('/v1/staff')
        .set('authorization', `Bearer ${managerToken}`)
        .send({ name: 'New Cashier', role: 'CASHIER', pin: '8642' })
        .expect(HttpStatus.CREATED);

      const staff = StaffUserSchema.parse(created.body);
      expect(staff).toMatchObject({ name: 'New Cashier', role: 'CASHIER', hasPin: true });
      expect(staff.hasPassword).toBe(false);

      await http()
        .post('/v1/auth/pin')
        .set(HEADERS.deviceToken, till.token)
        .send({ staffUserId: staff.id, pin: '8642' })
        .expect(HttpStatus.OK);
    });

    it('requires a PIN for a cashier', async () => {
      const response = await http()
        .post('/v1/staff')
        .set('authorization', `Bearer ${managerToken}`)
        .send({ name: 'No Credential', role: 'CASHIER' })
        .expect(HttpStatus.BAD_REQUEST);

      expect(response.body.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'pin' })]),
      );
    });

    it('refuses to give a cashier a password', async () => {
      // The two sign-in flows mean different things. A cashier with a password
      // could sign in from anywhere, defeating the device binding.
      const response = await http()
        .post('/v1/staff')
        .set('authorization', `Bearer ${managerToken}`)
        .send({ name: 'Hybrid', role: 'CASHIER', pin: '1111', password: 'a-long-password-here' })
        .expect(HttpStatus.BAD_REQUEST);

      expect(response.body.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'password' })]),
      );
    });

    it('requires an email and password for a manager', async () => {
      const response = await http()
        .post('/v1/staff')
        .set('authorization', `Bearer ${managerToken}`)
        .send({ name: 'Bare Manager', role: 'MANAGER' })
        .expect(HttpStatus.BAD_REQUEST);

      const paths = response.body.error.issues.map((issue: { path: string }) => issue.path);
      expect(paths).toContain('email');
      expect(paths).toContain('password');
    });

    it('enforces a minimum password length', async () => {
      await http()
        .post('/v1/staff')
        .set('authorization', `Bearer ${managerToken}`)
        .send({ name: 'Weak', role: 'MANAGER', email: 'weak@test.local', password: 'short' })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it.each(['123', '1234567', 'abcd', '12a4'])('rejects %s as a PIN', async (pin) => {
      await http()
        .post('/v1/staff')
        .set('authorization', `Bearer ${managerToken}`)
        .send({ name: 'Bad PIN', role: 'CASHIER', pin })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('refuses a duplicate email', async () => {
      const response = await http()
        .post('/v1/staff')
        .set('authorization', `Bearer ${managerToken}`)
        .send({
          name: 'Clash',
          role: 'MANAGER',
          email: manager.email,
          password: 'another-long-password',
        })
        .expect(HttpStatus.CONFLICT);

      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('stops a manager from creating an owner', async () => {
      // Otherwise a manager could promote themselves sideways into
      // unrestricted access.
      const response = await http()
        .post('/v1/staff')
        .set('authorization', `Bearer ${managerToken}`)
        .send({
          name: 'Self Promotion',
          role: 'OWNER',
          email: 'escalate@test.local',
          password: 'a-long-enough-password',
        })
        .expect(HttpStatus.FORBIDDEN);

      expect(response.body.error.message).toMatch(/only an owner/i);
    });

    it('lets an owner create an owner', async () => {
      await http()
        .post('/v1/staff')
        .set('authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Second Owner',
          role: 'OWNER',
          email: 'owner2@test.local',
          password: 'a-long-enough-password',
        })
        .expect(HttpStatus.CREATED);
    });
  });

  describe('updating staff', () => {
    it('renames and deactivates', async () => {
      const target = await createStaff(harness.prisma, harness.hashing, outlet, {
        role: 'CASHIER',
        pin: '2222',
      });

      const renamed = await http()
        .patch(`/v1/staff/${target.id}`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ name: 'Renamed Person' })
        .expect(HttpStatus.OK);
      expect(renamed.body.name).toBe('Renamed Person');

      const deactivated = await http()
        .patch(`/v1/staff/${target.id}`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ isActive: false })
        .expect(HttpStatus.OK);
      expect(deactivated.body.isActive).toBe(false);
    });

    it('ends the sessions of someone it deactivates', async () => {
      const target = await createStaff(harness.prisma, harness.hashing, outlet, {
        role: 'CASHIER',
        pin: '3333',
      });

      const session = AuthSessionSchema.parse(
        (
          await http()
            .post('/v1/auth/pin')
            .set(HEADERS.deviceToken, till.token)
            .send({ staffUserId: target.id, pin: '3333' })
            .expect(HttpStatus.OK)
        ).body,
      );

      await http()
        .patch(`/v1/staff/${target.id}`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ isActive: false })
        .expect(HttpStatus.OK);

      // Immediately, not whenever the refresh token would have expired.
      await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('refuses to let someone deactivate themselves', async () => {
      // Locking yourself out of your own POS mid-service is not a mistake worth
      // allowing.
      const response = await http()
        .patch(`/v1/staff/${manager.id}`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ isActive: false })
        .expect(422);

      expect(response.body.error.message).toMatch(/your own account/i);
    });

    it('stops a manager from changing an owner', async () => {
      const response = await http()
        .patch(`/v1/staff/${owner.id}`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ name: 'Demoted Owner' })
        .expect(HttpStatus.FORBIDDEN);

      expect(response.body.error.message).toMatch(/only an owner/i);
    });

    it('rejects an empty update', async () => {
      await http()
        .patch(`/v1/staff/${manager.id}`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('cannot touch staff in another outlet, and says "not found"', async () => {
      const other = await createOutlet(harness.prisma);
      try {
        const stranger = await createStaff(harness.prisma, harness.hashing, other, {
          role: 'CASHIER',
          pin: '4444',
        });

        const response = await http()
          .patch(`/v1/staff/${stranger.id}`)
          .set('authorization', `Bearer ${managerToken}`)
          .send({ name: 'Hijacked' })
          .expect(HttpStatus.NOT_FOUND);

        // "Not found" rather than "forbidden": confirming the id exists
        // elsewhere would itself leak information across tenants.
        expect(response.body.error.code).toBe('NOT_FOUND');
      } finally {
        await other.cleanup();
      }
    });
  });

  describe('resetting credentials', () => {
    it('resets a PIN, clears the lockout and ends existing sessions', async () => {
      const target = await createStaff(harness.prisma, harness.hashing, outlet, {
        role: 'CASHIER',
        pin: '5555',
      });

      const session = AuthSessionSchema.parse(
        (
          await http()
            .post('/v1/auth/pin')
            .set(HEADERS.deviceToken, till.token)
            .send({ staffUserId: target.id, pin: '5555' })
            .expect(HttpStatus.OK)
        ).body,
      );

      await harness.prisma.staffUser.update({
        where: { id: target.id },
        data: { lockedUntil: new Date(Date.now() + 600_000), failedAttempts: 5 },
      });

      const reset = await http()
        .put(`/v1/staff/${target.id}/pin`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ pin: '6666' })
        .expect(HttpStatus.OK);

      // This is the "my cashier is locked out mid-service" remedy.
      expect(reset.body.lockedUntil).toBeNull();

      await http()
        .post('/v1/auth/pin')
        .set(HEADERS.deviceToken, till.token)
        .send({ staffUserId: target.id, pin: '6666' })
        .expect(HttpStatus.OK);

      // The old PIN is dead, and so are sessions opened with it.
      await http()
        .post('/v1/auth/pin')
        .set(HEADERS.deviceToken, till.token)
        .send({ staffUserId: target.id, pin: '5555' })
        .expect(HttpStatus.UNAUTHORIZED);

      await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('refuses to give a manager a PIN', async () => {
      const response = await http()
        .put(`/v1/staff/${manager.id}/pin`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ pin: '7777' })
        .expect(422);

      expect(response.body.error.message).toMatch(/only a cashier/i);
    });

    it('sets a password and ends existing sessions', async () => {
      const target = await createStaff(harness.prisma, harness.hashing, outlet, {
        role: 'MANAGER',
        password: PASSWORD,
      });
      const session = AuthSessionSchema.parse(
        (
          await http()
            .post('/v1/auth/login')
            .send({ email: target.email, password: PASSWORD })
            .expect(HttpStatus.OK)
        ).body,
      );

      await http()
        .put(`/v1/staff/${target.id}/password`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ password: 'a-brand-new-password-1' })
        .expect(HttpStatus.OK);

      await http()
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);

      await http()
        .post('/v1/auth/login')
        .send({ email: target.email, password: 'a-brand-new-password-1' })
        .expect(HttpStatus.OK);
    });

    it('refuses to give a cashier a password', async () => {
      const target = await createStaff(harness.prisma, harness.hashing, outlet, {
        role: 'CASHIER',
        pin: '1212',
      });

      await http()
        .put(`/v1/staff/${target.id}/password`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ password: 'a-long-enough-password' })
        .expect(422);
    });

    it("stops a manager from changing an owner's password", async () => {
      // The clearest escalation path there is: reset the owner's password, then
      // sign in as them.
      const response = await http()
        .put(`/v1/staff/${owner.id}/password`)
        .set('authorization', `Bearer ${managerToken}`)
        .send({ password: 'manager-takes-over-1' })
        .expect(HttpStatus.FORBIDDEN);

      expect(response.body.error.message).toMatch(/only an owner/i);

      // And the owner's real password still works.
      await http()
        .post('/v1/auth/login')
        .send({ email: owner.email, password: PASSWORD })
        .expect(HttpStatus.OK);
    });
  });

  describe('listing', () => {
    it('shows only the caller’s outlet', async () => {
      const other = await createOutlet(harness.prisma);
      try {
        const stranger = await createStaff(harness.prisma, harness.hashing, other, {
          role: 'CASHIER',
          pin: '9999',
        });

        const response = await http()
          .get('/v1/staff')
          .set('authorization', `Bearer ${managerToken}`)
          .expect(HttpStatus.OK);

        const ids = response.body.staff.map((entry: { id: string }) => entry.id);
        expect(ids).toContain(manager.id);
        expect(ids).not.toContain(stranger.id);
      } finally {
        await other.cleanup();
      }
    });
  });
});
