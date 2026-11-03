import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { type ApiError, type ErrorCode, HEADERS } from '@pos/contracts';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

import { ENV } from '../config/config.module.js';
import { type Env } from '../config/env.js';
import { ApiException } from './api-exception.js';

/**
 * Turns every thrown thing into the one error envelope declared in
 * @pos/contracts. Nothing else in the API formats an error response.
 *
 * Two rules it enforces:
 *  - A 5xx never leaks an internal message to the client. The detail goes to
 *    the log, keyed by the same requestId the client is handed, so support can
 *    join the two without the customer reading a stack trace.
 *  - Every response carries a requestId, including errors raised before any
 *    controller ran.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(@Inject(ENV) private readonly env: Env) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();

    const requestId = String(request.id ?? request.headers[HEADERS.requestId] ?? 'unknown');
    const { status, body } = this.describe(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { requestId, path: request.url, method: request.method, err: exception },
        'Unhandled error',
      );
    } else {
      this.logger.debug(
        { requestId, path: request.url, code: body.error.code },
        'Request rejected',
      );
    }

    response.status(status).json(body);
  }

  private describe(exception: unknown, requestId: string): { status: number; body: ApiError } {
    const timestamp = new Date().toISOString();
    const envelope = (
      code: ErrorCode,
      message: string,
      issues?: ApiError['error']['issues'],
    ): ApiError => ({
      error: { code, message, ...(issues ? { issues } : {}), requestId, timestamp },
    });

    if (exception instanceof ApiException) {
      return {
        status: exception.getStatus(),
        body: envelope(exception.code, exception.message, exception.issues),
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: envelope(
          'VALIDATION_FAILED',
          'Request validation failed.',
          exception.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode =
        status === HttpStatus.NOT_FOUND
          ? 'NOT_FOUND'
          : status === HttpStatus.UNAUTHORIZED
            ? 'UNAUTHENTICATED'
            : status === HttpStatus.FORBIDDEN
              ? 'FORBIDDEN'
              : status === HttpStatus.TOO_MANY_REQUESTS
                ? 'RATE_LIMITED'
                : status >= 500
                  ? 'INTERNAL_ERROR'
                  : 'MALFORMED_REQUEST';

      const message =
        status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'Something went wrong.' : exception.message;

      return { status, body: envelope(code, message) };
    }

    // Anything unrecognised is a bug. Say nothing useful to the caller.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: envelope(
        'INTERNAL_ERROR',
        this.env.NODE_ENV === 'production'
          ? 'Something went wrong.'
          : `Unhandled ${exception instanceof Error ? exception.name : typeof exception}: ` +
              `${exception instanceof Error ? exception.message : String(exception)}`,
      ),
    };
  }
}
