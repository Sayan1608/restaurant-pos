import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionStore } from '../lib/session-store';
import { TillsSection } from './TillsSection';

/**
 * Till management, the screen that closes the loop on device pairing: before
 * it existed, a manager could only pair a tablet with a hand-written API call.
 */

const DEVICE_ID = '55555555-5555-5555-5555-555555555555';
const SECOND_ID = '66666666-6666-6666-6666-666666666666';
const OUTLET_ID = '33333333-3333-3333-3333-333333333333';

const till = (overrides: Record<string, unknown> = {}) => ({
  id: DEVICE_ID,
  outletId: OUTLET_ID,
  name: 'Counter Till 1',
  pairedAt: new Date().toISOString(),
  lastSeenAt: null,
  revokedAt: null,
  isActive: true,
  ...overrides,
});

const errorBody = (code: string, message: string) => ({
  error: { code, message, requestId: 'req_test', timestamp: new Date().toISOString() },
});

type Handler = (method: string, body: unknown) => { status: number; body: unknown };

function fakeApi(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });

    const key = Object.keys(handlers).find((candidate) => url.includes(candidate));
    const result = key
      ? handlers[key]!(method, body)
      : { status: 404, body: errorBody('NOT_FOUND', `no route for ${url}`) };

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

describe('<TillsSection />', () => {
  beforeEach(() => {
    window.localStorage.clear();
    sessionStore.clearSession();
    sessionStore.clearDevice();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('lists the paired tills', async () => {
    fakeApi({
      '/v1/devices': () => ({
        status: 200,
        body: {
          devices: [
            till(),
            till({
              id: SECOND_ID,
              name: 'Takeaway Till',
              isActive: false,
              revokedAt: new Date().toISOString(),
            }),
          ],
        },
      }),
    });

    render(<TillsSection />);

    expect(await screen.findByText('Counter Till 1')).toBeInTheDocument();
    expect(screen.getByText('Takeaway Till')).toBeInTheDocument();
    expect(screen.getByText(/Paired · never used/)).toBeInTheDocument();
    expect(screen.getByText(/Unpaired/)).toBeInTheDocument();
  });

  it('says so plainly when nothing is paired', async () => {
    fakeApi({ '/v1/devices': () => ({ status: 200, body: { devices: [] } }) });

    render(<TillsSection />);

    expect(await screen.findByText(/No tills paired yet/)).toBeInTheDocument();
  });

  it('will not issue a code without a name', async () => {
    fakeApi({ '/v1/devices': () => ({ status: 200, body: { devices: [] } }) });

    render(<TillsSection />);
    await screen.findByText(/No tills paired yet/);

    expect(screen.getByRole('button', { name: /pair a new till/i })).toBeDisabled();
  });

  it('issues a pairing code and shows it once, with the time remaining', async () => {
    const { calls } = fakeApi({
      '/v1/devices/pairing-codes': () => ({
        status: 201,
        body: {
          code: 'BSS5BYPT',
          deviceName: 'Counter Till 2',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }),
      '/v1/devices': () => ({ status: 200, body: { devices: [till()] } }),
    });

    render(<TillsSection />);
    await screen.findByText('Counter Till 1');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/new till name/i), 'Counter Till 2');
    await user.click(screen.getByRole('button', { name: /pair a new till/i }));

    // Read aloud across a counter, so it is shown large and selectable.
    expect(await screen.findByText('BSS5BYPT')).toBeInTheDocument();
    expect(screen.getByText(/Expires in 9:5\d · single use/)).toBeInTheDocument();
    expect(screen.getByText(/Counter Till 2/)).toBeInTheDocument();

    const created = calls.find((call) => call.url.includes('pairing-codes'));
    expect(created?.method).toBe('POST');
    expect(created?.body).toEqual({ deviceName: 'Counter Till 2' });
  });

  it('counts the code down and then marks it expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    fakeApi({
      '/v1/devices/pairing-codes': () => ({
        status: 201,
        body: {
          code: 'BSS5BYPT',
          deviceName: 'Counter Till 2',
          expiresAt: new Date(Date.now() + 3_000).toISOString(),
        },
      }),
      '/v1/devices': () => ({ status: 200, body: { devices: [] } }),
    });

    render(<TillsSection />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/new till name/i), 'Counter Till 2');
    await user.click(screen.getByRole('button', { name: /pair a new till/i }));
    await screen.findByText('BSS5BYPT');

    await vi.advanceTimersByTimeAsync(4_000);

    // A code that silently stops working is a support call; say it is expired.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Expired/));
  });

  it('clears the name field after issuing, ready for the next till', async () => {
    fakeApi({
      '/v1/devices/pairing-codes': () => ({
        status: 201,
        body: {
          code: 'BSS5BYPT',
          deviceName: 'Counter Till 2',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }),
      '/v1/devices': () => ({ status: 200, body: { devices: [] } }),
    });

    render(<TillsSection />);
    const user = userEvent.setup();

    const field = screen.getByLabelText(/new till name/i);
    await user.type(field, 'Counter Till 2');
    await user.click(screen.getByRole('button', { name: /pair a new till/i }));

    await screen.findByText('BSS5BYPT');
    expect(field).toHaveValue('');
  });

  it('surfaces a refusal from the server', async () => {
    fakeApi({
      '/v1/devices/pairing-codes': () => ({
        status: 403,
        body: errorBody('FORBIDDEN', 'This action needs OWNER or MANAGER access.'),
      }),
      '/v1/devices': () => ({ status: 200, body: { devices: [] } }),
    });

    render(<TillsSection />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/new till name/i), 'Rogue Till');
    await user.click(screen.getByRole('button', { name: /pair a new till/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/OWNER or MANAGER/);
  });

  describe('unpairing', () => {
    it('asks for confirmation first', async () => {
      fakeApi({ '/v1/devices': () => ({ status: 200, body: { devices: [till()] } }) });

      render(<TillsSection />);
      await screen.findByText('Counter Till 1');

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /^unpair$/i }));

      // Unpairing a live till mid-service deserves one deliberate second.
      expect(screen.getByRole('button', { name: /confirm unpair/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('can be cancelled', async () => {
      const { calls } = fakeApi({
        '/v1/devices': () => ({ status: 200, body: { devices: [till()] } }),
      });

      render(<TillsSection />);
      await screen.findByText('Counter Till 1');

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /^unpair$/i }));
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.getByRole('button', { name: /^unpair$/i })).toBeInTheDocument();
      expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    });

    it('unpairs on confirmation and reloads the list', async () => {
      let revoked = false;
      const { calls } = fakeApi({
        '/v1/devices/': (method) => {
          if (method === 'DELETE') {
            revoked = true;
            return {
              status: 200,
              body: till({ isActive: false, revokedAt: new Date().toISOString() }),
            };
          }
          return { status: 404, body: errorBody('NOT_FOUND', 'x') };
        },
        '/v1/devices': () => ({
          status: 200,
          body: {
            devices: [
              revoked ? till({ isActive: false, revokedAt: new Date().toISOString() }) : till(),
            ],
          },
        }),
      });

      render(<TillsSection />);
      await screen.findByText('Counter Till 1');

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /^unpair$/i }));
      await user.click(screen.getByRole('button', { name: /confirm unpair/i }));

      await waitFor(() => expect(screen.getByText(/^Unpaired/)).toBeInTheDocument());

      const deletes = calls.filter((call) => call.method === 'DELETE');
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.url).toContain(DEVICE_ID);

      // An already-unpaired till offers no Unpair button.
      const row = screen.getByText('Counter Till 1').closest('li');
      expect(within(row as HTMLElement).queryByRole('button')).toBeNull();
    });
  });
});
