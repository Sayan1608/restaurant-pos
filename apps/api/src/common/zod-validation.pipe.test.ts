import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApiException } from './api-exception.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const OrderLineSchema = z.object({
  menuItemId: z.string().uuid(),
  quantity: z.number().int().positive(),
  note: z.string().max(80).optional(),
});

const metadata = { type: 'body' } as const;

describe('ZodValidationPipe', () => {
  it('returns the parsed value on success', () => {
    const pipe = new ZodValidationPipe(OrderLineSchema);
    const input = {
      menuItemId: '3f1b7c2e-9a1d-4b8e-8f2a-1c5d6e7f8a9b',
      quantity: 2,
    };

    expect(pipe.transform(input, metadata)).toEqual(input);
  });

  it('strips keys the schema does not declare', () => {
    const pipe = new ZodValidationPipe(OrderLineSchema);

    const result = pipe.transform(
      {
        menuItemId: '3f1b7c2e-9a1d-4b8e-8f2a-1c5d6e7f8a9b',
        quantity: 1,
        // A client must never be able to smuggle its own price in.
        unitPricePaise: 1,
      },
      metadata,
    );

    expect(result).not.toHaveProperty('unitPricePaise');
  });

  it('throws an ApiException carrying every field issue', () => {
    const pipe = new ZodValidationPipe(OrderLineSchema);

    try {
      pipe.transform({ menuItemId: 'not-a-uuid', quantity: 0 }, metadata);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiException);
      const exception = error as ApiException;

      expect(exception.code).toBe('VALIDATION_FAILED');
      expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(exception.issues).toEqual([
        { path: 'menuItemId', message: expect.stringContaining('uuid') },
        { path: 'quantity', message: expect.any(String) },
      ]);
    }
  });

  it('reports a nested path in a form the UI can map to a field', () => {
    const pipe = new ZodValidationPipe(z.object({ lines: z.array(OrderLineSchema) }));

    try {
      pipe.transform({ lines: [{ menuItemId: 'x', quantity: 1 }] }, metadata);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiException).issues?.[0]?.path).toBe('lines.0.menuItemId');
    }
  });

  it('rejects a missing body rather than passing undefined along', () => {
    const pipe = new ZodValidationPipe(OrderLineSchema);
    expect(() => pipe.transform(undefined, metadata)).toThrow(ApiException);
  });
});

describe('ApiException factories', () => {
  it('notFound', () => {
    const exception = ApiException.notFound('Outlet');
    expect(exception.code).toBe('NOT_FOUND');
    expect(exception.message).toBe('Outlet not found.');
    expect(exception.getStatus()).toBe(404);
  });

  it('rule violations are 422, not 400 -- the request was well-formed', () => {
    const exception = ApiException.rule('An order cannot be paid twice.');
    expect(exception.code).toBe('RULE_VIOLATION');
    expect(exception.getStatus()).toBe(422);
  });

  it('conflict', () => {
    expect(ApiException.conflict('Already closed.').getStatus()).toBe(409);
  });

  it('validation', () => {
    const exception = ApiException.validation([{ path: 'phone', message: 'Required.' }]);
    expect(exception.getStatus()).toBe(400);
    expect(exception.issues).toHaveLength(1);
  });

  it('derives the status from the code for every code it is given', () => {
    expect(new ApiException('PAYMENT_TOTAL_MISMATCH', 'x').getStatus()).toBe(422);
    expect(new ApiException('VERSION_CONFLICT', 'x').getStatus()).toBe(409);
    expect(new ApiException('RATE_LIMITED', 'x').getStatus()).toBe(429);
    expect(new ApiException('DEPENDENCY_UNAVAILABLE', 'x').getStatus()).toBe(503);
  });
});
