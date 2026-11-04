import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiClientError, apiRequest } from './api';

const PayloadSchema = z.object({ id: z.string(), total: z.number() });

/**
 * The mock is given fetch's real signature so the assertions below can inspect
 * the second argument (headers, method, body). A zero-argument mock infers a
 * `[]` call tuple and makes `calls[0][1]` a type error.
 */
function respondWith(body: unknown, init: ResponseInit = {}) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_srv' },
        ...init,
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The RequestInit that fetch was actually called with. */
function initOf(fetchMock: ReturnType<typeof respondWith>, call = 0): RequestInit {
  return fetchMock.mock.calls[call]?.[1] ?? {};
}

const errorBody = (code: string, message: string) => ({
  error: {
    code,
    message,
    requestId: 'req_srv',
    timestamp: new Date().toISOString(),
  },
});

describe('apiRequest()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed body on success', async () => {
    respondWith({ id: 'o_1', total: 24950 });

    await expect(apiRequest('/v1/orders/o_1', PayloadSchema)).resolves.toEqual({
      id: 'o_1',
      total: 24950,
    });
  });

  it('sends a GET with no content-type and no body', async () => {
    const fetchMock = respondWith({ id: 'o_1', total: 1 });

    await apiRequest('/v1/orders/o_1', PayloadSchema);

    const init = initOf(fetchMock);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('serialises a body and sets content-type on a mutation', async () => {
    const fetchMock = respondWith({ id: 'o_1', total: 1 });

    await apiRequest('/v1/orders', PayloadSchema, {
      method: 'POST',
      body: { quantity: 2 },
    });

    const init = initOf(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"quantity":2}');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('forwards the idempotency key, which is what makes a retry safe', async () => {
    const fetchMock = respondWith({ id: 'o_1', total: 1 });

    await apiRequest('/v1/orders', PayloadSchema, {
      method: 'POST',
      body: {},
      idempotencyKey: 'key_abc',
    });

    const init = initOf(fetchMock);
    expect(init.headers).toMatchObject({ 'idempotency-key': 'key_abc' });
  });

  it('omits the idempotency header when none is given', async () => {
    const fetchMock = respondWith({ id: 'o_1', total: 1 });

    await apiRequest('/v1/orders', PayloadSchema, { method: 'POST', body: {} });

    const init = initOf(fetchMock);
    expect(init.headers).not.toHaveProperty('idempotency-key');
  });

  it('turns a server error envelope into a typed ApiClientError', async () => {
    respondWith(errorBody('PAYMENT_TOTAL_MISMATCH', 'Payments do not sum to the total.'), {
      status: 422,
    });

    const error = await apiRequest('/v1/orders/o_1/finalize', PayloadSchema).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiClientError);
    const clientError = error as ApiClientError;
    expect(clientError.code).toBe('PAYMENT_TOTAL_MISMATCH');
    expect(clientError.message).toBe('Payments do not sum to the total.');
    expect(clientError.status).toBe(422);
    // The request id must survive to the UI: it is how support finds the log line.
    expect(clientError.requestId).toBe('req_srv');
  });

  it('flags an unrecognised error body rather than trusting it', async () => {
    respondWith({ oops: true }, { status: 500 });

    const error = (await apiRequest('/v1/orders', PayloadSchema).catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.code).toBe('BAD_RESPONSE');
    expect(error.status).toBe(500);
  });

  it('rejects a 200 whose body does not match the contract', async () => {
    // The dangerous case: the server "succeeded" but renamed a field. Without
    // this check the UI would render undefined into a total.
    respondWith({ id: 'o_1', total: '24950' });

    const error = (await apiRequest('/v1/orders/o_1', PayloadSchema).catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.code).toBe('BAD_RESPONSE');
    expect(error.message).toContain('total');
  });

  it('survives a non-JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );

    const error = (await apiRequest('/v1/orders', PayloadSchema).catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.code).toBe('BAD_RESPONSE');
    expect(error.status).toBe(502);
  });

  it('reports a network failure in words a cashier can act on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const error = (await apiRequest('/healthz', PayloadSchema).catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('Check the connection');
  });

  it('distinguishes a cancelled request from a dead connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        throw abort;
      }),
    );

    const error = (await apiRequest('/healthz', PayloadSchema).catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toBe('Request cancelled.');
  });

  it('returns the body of an accepted non-2xx status', async () => {
    // /readyz answers 503 carrying the dependency list. Discarding that body
    // would hide which dependency is down.
    respondWith({ id: 'o_1', total: 1 }, { status: 503 });

    await expect(apiRequest('/readyz', PayloadSchema, { acceptStatuses: [503] })).resolves.toEqual({
      id: 'o_1',
      total: 1,
    });
  });

  it('still rejects an accepted status whose body does not match', async () => {
    respondWith({ nonsense: true }, { status: 503 });

    const error = (await apiRequest('/readyz', PayloadSchema, { acceptStatuses: [503] }).catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.code).toBe('BAD_RESPONSE');
  });

  it('does not accept a status that was not listed', async () => {
    respondWith(errorBody('INTERNAL_ERROR', 'boom'), { status: 500 });

    const error = (await apiRequest('/readyz', PayloadSchema, { acceptStatuses: [503] }).catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('passes the abort signal through to fetch', async () => {
    const fetchMock = respondWith({ id: 'o_1', total: 1 });
    const controller = new AbortController();

    await apiRequest('/healthz', PayloadSchema, { signal: controller.signal });

    expect(initOf(fetchMock).signal).toBe(controller.signal);
  });
});

describe('ApiClientError.isRetryable', () => {
  it.each([
    ['NETWORK_ERROR' as const, undefined, true],
    ['DEPENDENCY_UNAVAILABLE' as const, 503, true],
    ['RATE_LIMITED' as const, 429, true],
    ['INTERNAL_ERROR' as const, 500, true],
    ['VALIDATION_FAILED' as const, 400, false],
    ['NOT_FOUND' as const, 404, false],
    // A rejected payment must never be retried automatically -- that is how a
    // customer gets charged twice.
    ['PAYMENT_TOTAL_MISMATCH' as const, 422, false],
  ])('%s (%s) -> %s', (code, status, expected) => {
    expect(new ApiClientError(code, 'x', status).isRetryable).toBe(expected);
  });
});
