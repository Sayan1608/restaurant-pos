import { ApiErrorSchema, type ErrorCode, HEADERS } from '@pos/contracts';
import type { ZodType } from 'zod';

/**
 * The single HTTP client.
 *
 * Every response is parsed against the contract schema before it reaches a
 * component, so a server change that breaks the shape fails loudly here rather
 * than rendering `undefined` into a total on a bill. Errors arrive as a typed
 * ApiClientError carrying the machine-readable code and the request id.
 */

export class ApiClientError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK_ERROR' | 'BAD_RESPONSE',
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  /** True when retrying the same request could plausibly succeed. */
  get isRetryable(): boolean {
    return (
      this.code === 'NETWORK_ERROR' ||
      this.code === 'DEPENDENCY_UNAVAILABLE' ||
      this.code === 'RATE_LIMITED' ||
      (this.status ?? 0) >= 500
    );
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Required on money-affecting mutations; makes a retry a no-op server-side. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /**
   * Non-2xx statuses whose body is still a valid, meaningful payload rather
   * than an error. `/readyz` answers 503 *with* the dependency list when
   * something is down -- treating that as an exception throws away exactly the
   * information the screen needs to show.
   */
  acceptStatuses?: readonly number[];
}

export async function apiRequest<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, idempotencyKey, signal, acceptStatuses = [] } = options;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey ? { [HEADERS.idempotencyKey]: idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new ApiClientError(
      'NETWORK_ERROR',
      cause instanceof Error && cause.name === 'AbortError'
        ? 'Request cancelled.'
        : 'Cannot reach the server. Check the connection and try again.',
    );
  }

  const requestId = response.headers.get(HEADERS.requestId) ?? undefined;
  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok && !acceptStatuses.includes(response.status)) {
    const parsed = ApiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiClientError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
        parsed.data.error.requestId,
      );
    }
    throw new ApiClientError(
      'BAD_RESPONSE',
      `Server returned ${response.status} with an unrecognised body.`,
      response.status,
      requestId,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError(
      'BAD_RESPONSE',
      `Response from ${path} did not match the expected shape: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
      response.status,
      requestId,
    );
  }

  return parsed.data;
}
