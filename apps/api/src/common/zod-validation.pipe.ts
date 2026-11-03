import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { ApiException } from './api-exception.js';

/**
 * Validates a request payload against a schema from @pos/contracts, so the
 * client and the server are checking the *same* definition rather than two
 * that drift.
 *
 * Usage: `@Body(new ZodValidationPipe(CreateOrderSchema)) body: CreateOrder`
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw ApiException.validation(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
}
