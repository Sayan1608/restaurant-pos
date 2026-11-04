import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiErrorSchema } from '@pos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { parseEnv } from '../config/env.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { ApiException } from './api-exception.js';

const env = (nodeEnv: 'development' | 'production') =>
  parseEnv({
    NODE_ENV: nodeEnv,
    DATABASE_URL: 'postgresql://pos:pos@localhost:5432/pos',
  });

function capture(exception: unknown, nodeEnv: 'development' | 'production' = 'development') {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req_abc', url: '/v1/orders', method: 'POST', headers: {} }),
      getResponse: () => ({ status }),
    }),
  };

  new AllExceptionsFilter(env(nodeEnv)).catch(exception, host as never);

  return {
    status: status.mock.calls[0]?.[0] as number,
    body: json.mock.calls[0]?.[0] as ReturnType<typeof ApiErrorSchema.parse>,
  };
}

describe('AllExceptionsFilter', () => {
  it('renders an ApiException into the shared envelope', () => {
    const { status, body } = capture(ApiException.notFound('Order'));

    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Order not found.');
    expect(body.error.requestId).toBe('req_abc');
  });

  it('carries field issues through on a validation failure', () => {
    const { status, body } = capture(
      ApiException.validation([{ path: 'lines.0.quantity', message: 'Must be positive.' }]),
    );

    expect(status).toBe(HttpStatus.BAD_REQUEST);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.issues).toEqual([{ path: 'lines.0.quantity', message: 'Must be positive.' }]);
  });

  it('flattens a raw ZodError thrown outside a pipe', () => {
    const parsed = z.object({ phone: z.string().min(10) }).safeParse({ phone: '12' });
    expect(parsed.success).toBe(false);

    const { status, body } = capture(parsed.success ? null : parsed.error);
    expect(status).toBe(HttpStatus.BAD_REQUEST);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.issues?.[0]?.path).toBe('phone');
  });

  it('maps a built-in Nest exception onto a contract code', () => {
    const { status, body } = capture(new NotFoundException('nope'));
    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it.each([
    [new UnauthorizedException(), HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED'],
    [new ForbiddenException(), HttpStatus.FORBIDDEN, 'FORBIDDEN'],
    [
      new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS),
      HttpStatus.TOO_MANY_REQUESTS,
      'RATE_LIMITED',
    ],
    [new BadRequestException('bad'), HttpStatus.BAD_REQUEST, 'MALFORMED_REQUEST'],
    [
      new HttpException('upstream died', HttpStatus.BAD_GATEWAY),
      HttpStatus.BAD_GATEWAY,
      'INTERNAL_ERROR',
    ],
  ])('maps a $1 framework exception to the right contract code', (thrown, status, code) => {
    const result = capture(thrown);
    expect(result.status).toBe(status);
    expect(result.body.error.code).toBe(code);
  });

  it('hides the message of a 5xx framework exception but keeps a 4xx one', () => {
    expect(capture(new HttpException('database on fire', 503)).body.error.message).toBe(
      'Something went wrong.',
    );
    expect(capture(new BadRequestException('quantity must be positive')).body.error.message).toBe(
      'quantity must be positive',
    );
  });

  it('never leaks an internal message in production', () => {
    const { status, body } = capture(new Error('connection string pw=hunter2'), 'production');

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Something went wrong.');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('does surface the detail in development, where it helps', () => {
    const { body } = capture(new Error('kaboom'), 'development');
    expect(body.error.message).toContain('kaboom');
  });

  it('always produces a contract-valid body', () => {
    for (const thrown of [new Error('x'), ApiException.rule('no'), 'a string', 42, null]) {
      const { body } = capture(thrown);
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    }
  });
});
