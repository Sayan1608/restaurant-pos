import { HttpStatus } from '@nestjs/common';
import { AuditPageSchema, AuthSessionSchema, HEADERS } from '@pos/contracts';
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
 * The audit trail as a product feature, not just a table.
 *
 * The question these answer is the one a manager or an auditor actually asks:
 * can I reconstruct what happened on this till, and can staff see or change
 * records about themselves?
 *
 * Requires the database: `pnpm db:up && pnpm db:migrate`.
 */
describe('audit trail (integration)', () => {
  let harness: TestApp;
  let outlet: OutletFixture;
  let manager: StaffFixture;
  let cashier: StaffFixture;
  let managerToken: string;
  let cashierToken: string;
  let till: { id: string; token: string };

  const MANAGER_PASSWORD = 'manager-test-password-1';
  const CASHIER_PIN = '9753';

  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await bootTestApp();
    outlet = await createOutlet(harness.prisma);

    manager = await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'MANAGER',
      name: 'Audit Manager',
      password: MANAGER_PASSWORD,
    });
    cashier = await createStaff(harness.prisma, harness.hashing, outlet, {
      role: 'CASHIER',
      name: 'Audit Cashier',
      pin: CASHIER_PIN,
    });
    till = await pairDeviceDirectly(harness.prisma, harness.hashing, outlet, 'Audit Till');

    // Generate a realistic spread of activity: a success, a failure, a
    // lockout-free wrong PIN, and a privileged change.
    managerToken = AuthSessionSchema.parse(
      (
        await http()
          .post('/v1/auth/login')
          .send({ email: manager.email, password: MANAGER_PASSWORD })
          .expect(HttpStatus.OK)
      ).body,
    ).accessToken;

    await http()
      .post('/v1/auth/login')
      .send({ email: manager.email, password: 'wrong-password' })
      .expect(HttpStatus.UNAUTHORIZED);

    cashierToken = AuthSessionSchema.parse(
      (
        await http()
          .post('/v1/auth/pin')
          .set(HEADERS.deviceToken, till.token)
          .send({ staffUserId: cashier.id, pin: CASHIER_PIN })
          .expect(HttpStatus.OK)
      ).body,
    ).accessToken;

    await http()
      .put(`/v1/staff/${cashier.id}/pin`)
      .set('authorization', `Bearer ${managerToken}`)
      .send({ pin: CASHIER_PIN })
      .expect(HttpStatus.OK);
  }, 60_000);

  afterAll(async () => {
    await outlet?.cleanup();
    await harness?.close();
  });

  const read = async (query = '') => {
    const response = await http()
      .get(`/v1/audit-logs${query}`)
      .set('authorization', `Bearer ${managerToken}`)
      .expect(HttpStatus.OK);
    return AuditPageSchema.parse(response.body);
  };

  it('records every kind of sign-in activity', async () => {
    const page = await read('?limit=50');
    const actions = page.entries.map((entry) => entry.action);

    expect(actions).toContain('auth.login.password');
    expect(actions).toContain('auth.login.failed');
    expect(actions).toContain('auth.login.pin');
    expect(actions).toContain('staff.pin.set');
  });

  it('returns newest first', async () => {
    const page = await read('?limit=50');
    const times = page.entries.map((entry) => new Date(entry.createdAt).getTime());

    for (let index = 1; index < times.length; index += 1) {
      expect(times[index - 1]!).toBeGreaterThanOrEqual(times[index]!);
    }
  });

  it('names the actor as they were at the time', async () => {
    const page = await read('?action=auth.login.password');
    // actorLabel is denormalised, so renaming or deactivating a staff member
    // later cannot rewrite who did what.
    expect(page.entries[0]?.actorLabel).toBe('Audit Manager');
    expect(page.entries[0]?.actorStaffId).toBe(manager.id);
  });

  it('distinguishes outcomes', async () => {
    const failures = await read('?outcome=FAILURE');
    expect(failures.entries.length).toBeGreaterThan(0);
    for (const entry of failures.entries) {
      expect(entry.outcome).toBe('FAILURE');
    }
  });

  it('filters by action prefix, so `auth.` groups naturally', async () => {
    const page = await read('?action=auth.');
    expect(page.entries.length).toBeGreaterThan(0);
    for (const entry of page.entries) {
      expect(entry.action.startsWith('auth.')).toBe(true);
    }
  });

  it('filters by actor', async () => {
    const page = await read(`?actorStaffId=${cashier.id}`);
    expect(page.entries.length).toBeGreaterThan(0);
    for (const entry of page.entries) {
      expect(entry.actorStaffId).toBe(cashier.id);
    }
  });

  it('filters by time window', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const empty = await read(`?from=${encodeURIComponent(future)}`);
    expect(empty.entries).toHaveLength(0);
    expect(empty.nextCursor).toBeNull();
  });

  it('pages with a cursor rather than an offset', async () => {
    const first = await read('?limit=2');
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await read(`?limit=2&cursor=${first.nextCursor}`);

    // Keyset paging, because the table is append-only and grows while being
    // read -- OFFSET would skip or repeat rows as it does.
    const firstIds = first.entries.map((entry) => entry.id);
    for (const entry of second.entries) {
      expect(firstIds).not.toContain(entry.id);
    }
  });

  it('reports a null cursor at the end', async () => {
    const page = await read('?limit=200');
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a nonsensical limit instead of ignoring it', async () => {
    await http()
      .get('/v1/audit-logs?limit=9999')
      .set('authorization', `Bearer ${managerToken}`)
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('never contains a credential', async () => {
    const page = await read('?limit=200');
    const serialised = JSON.stringify(page);

    expect(serialised).not.toContain('argon2');
    expect(serialised).not.toContain(CASHIER_PIN);
    expect(serialised).not.toContain(MANAGER_PASSWORD);
    expect(serialised).not.toContain(till.token);
  });

  it('is scoped to the caller’s own outlet', async () => {
    const other = await createOutlet(harness.prisma);
    try {
      const theirManager = await createStaff(harness.prisma, harness.hashing, other, {
        role: 'MANAGER',
        password: 'their-test-password-1',
      });

      await http()
        .post('/v1/auth/login')
        .send({ email: theirManager.email, password: 'their-test-password-1' })
        .expect(HttpStatus.OK);

      // Our manager must not see their outlet's activity. The outlet comes
      // from the token, not from any parameter the client can set.
      const page = await read('?limit=200');
      for (const entry of page.entries) {
        expect(entry.outletId).toBe(outlet.outletId);
      }
    } finally {
      await other.cleanup();
    }
  });

  it('is closed to cashiers', async () => {
    const response = await http()
      .get('/v1/audit-logs')
      .set('authorization', `Bearer ${cashierToken}`)
      .expect(HttpStatus.FORBIDDEN);

    // It is a record of staff behaviour, so colleagues must not read it.
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('is read-only: there is no way to write or erase a row over HTTP', async () => {
    // An audit trail that can be edited is not an audit trail. These must be
    // 404 (no such route), never 200.
    //
    // Each request is built and awaited one at a time: supertest calls
    // `server.address()` when a request starts, and constructing several
    // against a not-yet-listening server races that setup.
    await http()
      .post('/v1/audit-logs')
      .set('authorization', `Bearer ${managerToken}`)
      .send({})
      .expect(HttpStatus.NOT_FOUND);

    await http()
      .delete('/v1/audit-logs')
      .set('authorization', `Bearer ${managerToken}`)
      .expect(HttpStatus.NOT_FOUND);

    await http()
      .patch('/v1/audit-logs/00000000-0000-0000-0000-000000000000')
      .set('authorization', `Bearer ${managerToken}`)
      .send({})
      .expect(HttpStatus.NOT_FOUND);
  });

  it('carries the request id, joining an audit row to the server log line', async () => {
    const page = await read('?limit=5');
    expect(page.entries[0]?.requestId).toMatch(/.+/);
  });
});
