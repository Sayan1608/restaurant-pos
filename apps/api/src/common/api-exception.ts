import { HttpException } from '@nestjs/common';
import { ERROR_STATUS, type ErrorCode, type FieldIssue } from '@pos/contracts';

/**
 * The only exception this codebase throws on purpose.
 *
 * Carrying the machine-readable `code` means the HTTP status is derived from
 * the domain error rather than chosen by hand at each call site, and the POS
 * client can switch on a stable value instead of matching English text.
 */
export class ApiException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly issues?: FieldIssue[],
  ) {
    super(message, ERROR_STATUS[code]);
  }

  static notFound(what: string): ApiException {
    return new ApiException('NOT_FOUND', `${what} not found.`);
  }

  static validation(issues: FieldIssue[]): ApiException {
    return new ApiException('VALIDATION_FAILED', 'Request validation failed.', issues);
  }

  static rule(message: string): ApiException {
    return new ApiException('RULE_VIOLATION', message);
  }

  static conflict(message: string): ApiException {
    return new ApiException('CONFLICT', message);
  }
}
