import { HEADERS } from '@pos/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Options } from 'pino-http';

import { type Env } from '../config/env.js';

/**
 * Logging policy, in one testable function.
 *
 * Extracted from AppModule because three of the decisions here are load-bearing
 * and deserve tests of their own rather than being asserted only indirectly
 * through a booted server:
 *
 *  - request id propagation, which is how a support call becomes a log line;
 *  - the probe filter, without which health checks drown the log;
 *  - redaction, which keeps credentials and customer PII out of the log store.
 */
export function buildPinoHttpOptions(env: Env): Options<IncomingMessage, ServerResponse> {
  return {
    level: env.LOG_LEVEL,

    // Pretty output is a development convenience only; production logs are
    // single-line JSON so they are searchable in a log store.
    transport:
      env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
        : undefined,

    // Honour an upstream request id so a trace survives the proxy, and echo it
    // back on the response so the client can quote it.
    genReqId: (request, response) => {
      const incoming = request.headers[HEADERS.requestId];
      const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
      response.setHeader(HEADERS.requestId, id);
      return id;
    },

    // Health probes would otherwise dominate the log volume.
    autoLogging: {
      ignore: (request) => request.url === '/healthz' || request.url === '/readyz',
    },

    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["idempotency-key"]',
        'req.body.pin',
        'req.body.password',
        // Customer phone and email are PII: they belong in the database, not in
        // a log aggregator. Tightened further in Step 4.
        'req.body.phone',
        'req.body.email',
      ],
      censor: '[redacted]',
    },
  };
}
