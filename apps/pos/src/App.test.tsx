import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

const liveness = {
  status: 'ok',
  service: 'pos-api',
  version: '0.1.0-dev',
  uptimeSeconds: 12,
  timestamp: new Date().toISOString(),
};

const readiness = (status: 'ok' | 'degraded', dependencyStatus: 'up' | 'down') => ({
  status,
  dependencies: [
    dependencyStatus === 'up'
      ? { name: 'postgres', status: 'up', latencyMs: 3 }
      : { name: 'postgres', status: 'down', error: 'connection refused' },
  ],
  timestamp: new Date().toISOString(),
});

function mockFetch(handler: (url: string) => { status: number; body: unknown } | 'throw') {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const result = handler(url);
    if (result === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
    });
  });
}

describe('<App />', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({ status: 200, body: liveness })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the shell and the roadmap', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Restaurant POS' })).toBeInTheDocument();
    expect(screen.getByText('Foundation & skeleton')).toBeInTheDocument();
    expect(screen.getByText('Staff auth, devices & audit log')).toBeInTheDocument();
  });

  it('reports a healthy API with its dependencies', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url.includes('readyz')
          ? { status: 200, body: readiness('ok', 'up') }
          : { status: 200, body: liveness },
      ),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));
    expect(screen.getByText('postgres')).toBeInTheDocument();
    expect(screen.getByText('up · 3ms')).toBeInTheDocument();
  });

  it('reports degraded when a dependency is down but the API answers', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url.includes('readyz')
          ? { status: 503, body: readiness('degraded', 'down') }
          : { status: 200, body: liveness },
      ),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Degraded'));
  });

  it('tells the operator how to start the stack when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => 'throw'),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText('API unreachable')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Offline');
    expect(screen.getByText(/pnpm db:up/)).toBeInTheDocument();
  });

  it('omits the latency when the server did not report one', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url.includes('readyz')
          ? {
              status: 200,
              body: {
                status: 'ok',
                dependencies: [{ name: 'postgres', status: 'up' }],
                timestamp: new Date().toISOString(),
              },
            }
          : { status: 200, body: liveness },
      ),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText('up')).toBeInTheDocument());
  });

  it('falls back to "down" when a failure has no message', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url.includes('readyz')
          ? {
              status: 503,
              body: {
                status: 'degraded',
                dependencies: [{ name: 'postgres', status: 'down' }],
                timestamp: new Date().toISOString(),
              },
            }
          : { status: 200, body: liveness },
      ),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText('down')).toBeInTheDocument());
  });

  it('renders paise through the shared formatter, not float arithmetic', () => {
    render(<App />);
    expect(screen.getByText('₹0.07')).toBeInTheDocument();
    expect(screen.getByText('₹1,234.50')).toBeInTheDocument();
    expect(screen.getByText('₹1,00,000.00')).toBeInTheDocument();
  });
});
