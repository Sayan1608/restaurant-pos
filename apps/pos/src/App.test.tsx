import type { SessionStaff } from '@pos/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { sessionStore } from './lib/session-store';

/**
 * The three states a till can be in, driven through the real components:
 * unpaired, paired-but-locked, and signed in.
 *
 * These assert what a cashier sees, not what a function returns -- the whole
 * point of Step 2's UI is that the right screen appears at the right moment.
 */

const DEVICE_ID = '55555555-5555-5555-5555-555555555555';
const SECOND_CASHIER_ID = '66666666-6666-6666-6666-666666666666';

const OUTLET = {
  id: '33333333-3333-3333-3333-333333333333',
  name: 'Spice Garden - MG Road',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
};

const CASHIER = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Priya Menon',
  email: null,
  role: 'CASHIER' as const,
  tenantId: '22222222-2222-2222-2222-222222222222',
  outletId: OUTLET.id,
};

const MANAGER = {
  ...CASHIER,
  id: '44444444-4444-4444-4444-444444444444',
  name: 'Vikram Shah',
  email: 'vikram@test.local',
  role: 'MANAGER' as const,
};

const session = (
  staff: SessionStaff = CASHIER,
  device: { id: string; name: string } | null = null,
) => ({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  staff,
  device,
});

const liveness = {
  status: 'ok',
  service: 'pos-api',
  version: '0.1.0-dev',
  uptimeSeconds: 5,
  timestamp: new Date().toISOString(),
};

const readiness = {
  status: 'ok',
  dependencies: [{ name: 'postgres', status: 'up', latencyMs: 3 }],
  timestamp: new Date().toISOString(),
};

const errorBody = (code: string, message: string) => ({
  error: { code, message, requestId: 'req_test', timestamp: new Date().toISOString() },
});

type Route = { status: number; body: unknown };

/** A tiny fake server, so the tests exercise the real client and real screens. */
function fakeApi(routes: Record<string, Route | ((body: unknown) => Route)>) {
  const calls: Array<{ url: string; body: unknown }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const parsed = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body: parsed });

    const key = Object.keys(routes).find((candidate) => url.includes(candidate));
    const route = key ? routes[key] : undefined;

    if (!route) {
      return new Response(JSON.stringify(errorBody('NOT_FOUND', `no route for ${url}`)), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    const resolved = typeof route === 'function' ? route(parsed) : route;
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const PROBES = {
  '/healthz': { status: 200, body: liveness },
  '/readyz': { status: 200, body: readiness },
};

describe('till states', () => {
  beforeEach(() => {
    window.localStorage.clear();
    sessionStore.clearSession();
    sessionStore.clearDevice();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('unpaired', () => {
    it('asks for a pairing code', async () => {
      fakeApi(PROBES);
      render(<App />);

      expect(await screen.findByRole('heading', { name: 'Pair this till' })).toBeInTheDocument();
      expect(screen.getByLabelText(/pairing code/i)).toBeInTheDocument();
    });

    it('will not submit an incomplete code', async () => {
      fakeApi(PROBES);
      render(<App />);
      await screen.findByRole('heading', { name: 'Pair this till' });

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/pairing code/i), 'ABC');

      expect(screen.getByRole('button', { name: /pair till/i })).toBeDisabled();
    });

    it('pairs with a valid code and then asks who is on the till', async () => {
      fakeApi({
        ...PROBES,
        '/v1/devices/pair': {
          status: 201,
          body: {
            device: {
              id: DEVICE_ID,
              outletId: OUTLET.id,
              name: 'Counter Till 1',
              pairedAt: new Date().toISOString(),
              lastSeenAt: null,
              revokedAt: null,
              isActive: true,
            },
            deviceToken: 'device-token-1',
            outlet: { id: OUTLET.id, name: OUTLET.name },
          },
        },
        '/v1/auth/cashiers': {
          status: 200,
          body: { cashiers: [{ id: CASHIER.id, name: CASHIER.name }] },
        },
      });

      render(<App />);
      await screen.findByRole('heading', { name: 'Pair this till' });

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/pairing code/i), 'BSS5BYPT');
      await user.click(screen.getByRole('button', { name: /pair till/i }));

      expect(
        await screen.findByRole('heading', { name: /who is on the till/i }),
      ).toBeInTheDocument();
      expect(sessionStore.getDeviceToken()).toBe('device-token-1');
    });

    it('shows the server message when the code is refused', async () => {
      fakeApi({
        ...PROBES,
        '/v1/devices/pair': {
          status: 422,
          body: errorBody(
            'PAIRING_CODE_INVALID',
            'That pairing code is not valid. Ask a manager for a new one.',
          ),
        },
      });

      render(<App />);
      await screen.findByRole('heading', { name: 'Pair this till' });

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/pairing code/i), 'WRONGCOD');
      await user.click(screen.getByRole('button', { name: /pair till/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/i);
      expect(sessionStore.getDeviceToken()).toBeNull();
    });

    it('offers manager sign-in as a way past the pairing screen', async () => {
      fakeApi(PROBES);
      render(<App />);
      await screen.findByRole('heading', { name: 'Pair this till' });

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /sign in as a manager/i }));

      expect(screen.getByRole('heading', { name: /manager sign in/i })).toBeInTheDocument();
    });
  });

  describe('paired but locked', () => {
    beforeEach(() => {
      sessionStore.saveDevice('device-token-1', { id: DEVICE_ID, name: 'Counter Till 1' });
    });

    it('lists the cashiers on the till', async () => {
      fakeApi({
        ...PROBES,
        '/v1/auth/cashiers': {
          status: 200,
          body: {
            cashiers: [
              { id: CASHIER.id, name: 'Priya Menon' },
              { id: SECOND_CASHIER_ID, name: 'Rahul Das' },
            ],
          },
        },
      });

      render(<App />);

      expect(await screen.findByRole('button', { name: 'Priya Menon' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Rahul Das' })).toBeInTheDocument();
      expect(screen.getByText('Counter Till 1')).toBeInTheDocument();
    });

    it('signs a cashier in through the PIN pad', async () => {
      const { calls } = fakeApi({
        ...PROBES,
        '/v1/auth/cashiers': {
          status: 200,
          body: { cashiers: [{ id: CASHIER.id, name: 'Priya Menon' }] },
        },
        '/v1/auth/pin': {
          status: 200,
          body: session(CASHIER, { id: DEVICE_ID, name: 'Counter Till 1' }),
        },
        '/v1/auth/me': {
          status: 200,
          body: {
            staff: CASHIER,
            device: { id: DEVICE_ID, name: 'Counter Till 1' },
            outlet: OUTLET,
          },
        },
      });

      render(<App />);
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Priya Menon' }));
      expect(screen.getByText(/signing in as/i)).toBeInTheDocument();

      for (const digit of ['1', '2', '3', '4']) {
        await user.click(screen.getByRole('button', { name: digit }));
      }
      await user.click(screen.getByRole('button', { name: /^sign in$/i }));

      // The outlet name appears in both the banner and the session card, so
      // scope the assertion to the banner rather than matching loosely.
      const banner = await screen.findByRole('banner');
      expect(within(banner).getByText(/Spice Garden - MG Road/)).toBeInTheDocument();
      expect(within(banner).getByText('Priya Menon')).toBeInTheDocument();

      // The PIN is sent with the chosen cashier's id -- never a bare PIN that
      // would have to be unique across the outlet.
      const pinCall = calls.find((call) => call.url.includes('/v1/auth/pin'));
      expect(pinCall?.body).toEqual({ staffUserId: CASHIER.id, pin: '1234' });
    });

    it('surfaces a lockout in words the cashier can act on', async () => {
      fakeApi({
        ...PROBES,
        '/v1/auth/cashiers': {
          status: 200,
          body: { cashiers: [{ id: CASHIER.id, name: 'Priya Menon' }] },
        },
        '/v1/auth/pin': {
          status: 423,
          body: errorBody(
            'ACCOUNT_LOCKED',
            'Too many failed attempts. Try again in 15 minutes, or ask a manager to reset it.',
          ),
        },
      });

      render(<App />);
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Priya Menon' }));
      for (const digit of ['0', '0', '0', '0']) {
        await user.click(screen.getByRole('button', { name: digit }));
      }
      await user.click(screen.getByRole('button', { name: /^sign in$/i }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/15 minutes/);
      expect(alert).toHaveTextContent(/manager/i);
    });

    it('drops back to pairing if the server says the till was unpaired', async () => {
      fakeApi({
        ...PROBES,
        '/v1/auth/cashiers': {
          status: 200,
          body: { cashiers: [{ id: CASHIER.id, name: 'Priya Menon' }] },
        },
        '/v1/auth/pin': {
          status: 403,
          body: errorBody('DEVICE_REVOKED', 'This till has been unpaired.'),
        },
      });

      render(<App />);
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Priya Menon' }));
      for (const digit of ['1', '2', '3', '4']) {
        await user.click(screen.getByRole('button', { name: digit }));
      }
      await user.click(screen.getByRole('button', { name: /^sign in$/i }));

      // Sitting on a PIN pad that can never succeed would be the worse outcome.
      expect(await screen.findByRole('heading', { name: 'Pair this till' })).toBeInTheDocument();
      expect(sessionStore.getDeviceToken()).toBeNull();
    });

    it('clears the entered digits', async () => {
      fakeApi({
        ...PROBES,
        '/v1/auth/cashiers': {
          status: 200,
          body: { cashiers: [{ id: CASHIER.id, name: 'Priya Menon' }] },
        },
      });

      render(<App />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Priya Menon' }));

      await user.click(screen.getByRole('button', { name: '1' }));
      await user.click(screen.getByRole('button', { name: '2' }));
      expect(screen.getByRole('status')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('2 of 6'),
      );

      await user.click(screen.getByRole('button', { name: /clear/i }));
      expect(screen.getByRole('status')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('0 of 6'),
      );
    });
  });

  describe('restoring a session', () => {
    it('turns a stored refresh token back into a signed-in till', async () => {
      sessionStore.saveDevice('device-token-1', { id: DEVICE_ID, name: 'Counter Till 1' });
      window.localStorage.setItem('pos.refreshToken', 'stored-refresh');

      fakeApi({
        ...PROBES,
        '/v1/auth/refresh': {
          status: 200,
          body: session(CASHIER, { id: DEVICE_ID, name: 'Counter Till 1' }),
        },
        '/v1/auth/me': {
          status: 200,
          body: {
            staff: CASHIER,
            device: { id: DEVICE_ID, name: 'Counter Till 1' },
            outlet: OUTLET,
          },
        },
      });

      render(<App />);

      // This is what makes a tablet reload invisible to the cashier.
      const banner = await screen.findByRole('banner');
      expect(within(banner).getByText('Priya Menon')).toBeInTheDocument();
      expect(within(banner).getByText(/Counter Till 1/)).toBeInTheDocument();
    });

    it('falls back to the PIN pad when the stored token is dead', async () => {
      sessionStore.saveDevice('device-token-1', { id: DEVICE_ID, name: 'Counter Till 1' });
      window.localStorage.setItem('pos.refreshToken', 'stale-refresh');

      fakeApi({
        ...PROBES,
        '/v1/auth/refresh': {
          status: 401,
          body: errorBody('TOKEN_REVOKED', 'Refresh token is not recognised.'),
        },
        '/v1/auth/cashiers': {
          status: 200,
          body: { cashiers: [{ id: CASHIER.id, name: 'Priya Menon' }] },
        },
      });

      render(<App />);

      expect(
        await screen.findByRole('heading', { name: /who is on the till/i }),
      ).toBeInTheDocument();
      expect(sessionStore.getRefreshToken()).toBeNull();
    });
  });

  describe('signed in', () => {
    beforeEach(() => {
      sessionStore.saveDevice('device-token-1', { id: DEVICE_ID, name: 'Counter Till 1' });
      window.localStorage.setItem('pos.refreshToken', 'stored-refresh');
    });

    const signedInApi = (extra: Record<string, Route> = {}) =>
      fakeApi({
        ...PROBES,
        '/v1/auth/refresh': {
          status: 200,
          body: session(MANAGER, { id: DEVICE_ID, name: 'Counter Till 1' }),
        },
        '/v1/auth/me': {
          status: 200,
          body: {
            staff: MANAGER,
            device: { id: DEVICE_ID, name: 'Counter Till 1' },
            outlet: OUTLET,
          },
        },
        // A manager's home screen now includes the Tills section.
        '/v1/devices': {
          status: 200,
          body: {
            devices: [
              {
                id: DEVICE_ID,
                outletId: OUTLET.id,
                name: 'Counter Till 1',
                pairedAt: new Date().toISOString(),
                lastSeenAt: null,
                revokedAt: null,
                isActive: true,
              },
            ],
          },
        },
        ...extra,
      });

    it('shows who is on the till, on which device, at which outlet', async () => {
      signedInApi();
      render(<App />);

      const banner = await screen.findByRole('banner');
      expect(within(banner).getByText('Vikram Shah')).toBeInTheDocument();
      expect(within(banner).getByText('MANAGER')).toBeInTheDocument();
      // Who, on which till, at which outlet -- the Step 2 session banner.
      expect(within(banner).getByText(/Spice Garden - MG Road/)).toHaveTextContent(
        'Counter Till 1',
      );
    });

    it('reports the API connection', async () => {
      signedInApi();
      render(<App />);

      await screen.findByText('Vikram Shah');
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Online'));
    });

    it('still formats money through the shared integer-paise formatter', async () => {
      signedInApi();
      render(<App />);

      await screen.findByText('Vikram Shah');
      expect(screen.getByText('₹1,00,000.00')).toBeInTheDocument();
      expect(screen.getByText('₹0.07')).toBeInTheDocument();
    });

    it('hands over to the next cashier without unpairing the till', async () => {
      signedInApi({
        '/v1/auth/logout': { status: 204, body: null },
        '/v1/auth/cashiers': {
          status: 200,
          body: { cashiers: [{ id: CASHIER.id, name: 'Priya Menon' }] },
        },
      });

      render(<App />);
      await screen.findByText('Vikram Shah');

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /hand over/i }));

      expect(
        await screen.findByRole('heading', { name: /who is on the till/i }),
      ).toBeInTheDocument();
      // The till stays paired: a shift change is not a re-install.
      expect(sessionStore.getDeviceToken()).toBe('device-token-1');
      expect(sessionStore.getRefreshToken()).toBeNull();
    });

    it('marks steps 1 and 2 done on the roadmap', async () => {
      signedInApi();
      render(<App />);
      await screen.findByText('Vikram Shah');

      const roadmap = screen.getByText('Build roadmap').closest('div');
      expect(roadmap).not.toBeNull();
      expect(
        within(roadmap as HTMLElement).getByText('Staff auth, devices & audit log'),
      ).toBeInTheDocument();
      expect(within(roadmap as HTMLElement).getByText('Menu management')).toBeInTheDocument();
    });
  });

  describe('manager sign-in', () => {
    it('signs in with an email and password', async () => {
      const { calls } = fakeApi({
        ...PROBES,
        '/v1/auth/login': { status: 200, body: session(MANAGER) },
        '/v1/auth/me': { status: 200, body: { staff: MANAGER, device: null, outlet: OUTLET } },
      });

      render(<App />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: /sign in as a manager/i }));

      await user.type(screen.getByLabelText(/email/i), 'vikram@test.local');
      await user.type(screen.getByLabelText(/password/i), 'manager-dev-password-1');
      await user.click(screen.getByRole('button', { name: /^sign in$/i }));

      expect(await screen.findByText('Vikram Shah')).toBeInTheDocument();

      const loginCall = calls.find((call) => call.url.includes('/v1/auth/login'));
      expect(loginCall?.body).toEqual({
        email: 'vikram@test.local',
        password: 'manager-dev-password-1',
      });
    });

    it('shows the server message on bad credentials and keeps the email', async () => {
      fakeApi({
        ...PROBES,
        '/v1/auth/login': {
          status: 401,
          body: errorBody('INVALID_CREDENTIALS', 'Those sign-in details are not correct.'),
        },
      });

      render(<App />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: /sign in as a manager/i }));

      await user.type(screen.getByLabelText(/email/i), 'vikram@test.local');
      await user.type(screen.getByLabelText(/password/i), 'wrong');
      await user.click(screen.getByRole('button', { name: /^sign in$/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/not correct/i);
      // Retyping the address after a typo in the password is a needless
      // annoyance mid-service.
      expect(screen.getByLabelText(/email/i)).toHaveValue('vikram@test.local');
      expect(screen.getByLabelText(/password/i)).toHaveValue('');
    });
  });
});
