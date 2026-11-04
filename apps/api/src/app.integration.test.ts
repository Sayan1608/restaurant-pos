import { HttpStatus, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LivenessSchema, ReadinessSchema } from '@pos/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { ENV } from './config/config.module.js';
import { type Env } from './config/env.js';

/**
 * Boots the entire application -- real modules, real logger, real database --
 * and drives it over HTTP exactly as a client would.
 *
 * The controller unit tests stub Prisma to assert shapes and status codes
 * quickly; this one answers the question they cannot: does the whole thing
 * actually stand up and talk to Postgres?
 *
 * Requires the database: `pnpm db:up && pnpm db:migrate`.
 */
describe('application (integration)', () => {
  let app: INestApplication;
  let env: Env;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    env = app.get<Env>(ENV);
    configureApp(app, env);
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('validated its environment while booting', () => {
    expect(env.DATABASE_URL).toMatch(/^postgres(ql)?:\/\//);
    expect(env.PORT).toBeGreaterThan(0);
  });

  it('serves liveness outside the version prefix', async () => {
    const response = await request(app.getHttpServer()).get('/healthz').expect(HttpStatus.OK);
    expect(LivenessSchema.parse(response.body).status).toBe('ok');
  });

  it('does not serve the probes under the version prefix', async () => {
    await request(app.getHttpServer()).get('/v1/healthz').expect(HttpStatus.NOT_FOUND);
  });

  it('reports the real database as up in readiness', async () => {
    const response = await request(app.getHttpServer()).get('/readyz').expect(HttpStatus.OK);
    const body = ReadinessSchema.parse(response.body);

    expect(body.status).toBe('ok');
    expect(body.dependencies).toEqual([
      expect.objectContaining({ name: 'postgres', status: 'up' }),
    ]);
  });

  it('stamps every response with a request id', async () => {
    const response = await request(app.getHttpServer()).get('/healthz').expect(HttpStatus.OK);
    expect(response.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('honours an upstream request id so a trace survives the proxy', async () => {
    const response = await request(app.getHttpServer())
      .get('/healthz')
      .set('x-request-id', 'trace-from-the-edge')
      .expect(HttpStatus.OK);

    expect(response.headers['x-request-id']).toBe('trace-from-the-edge');
  });

  it('answers an unknown versioned route with the shared error envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/orders/does-not-exist')
      .expect(HttpStatus.NOT_FOUND);

    expect(response.body.error).toMatchObject({
      code: 'NOT_FOUND',
      requestId: expect.any(String),
    });
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('sets the security headers helmet is there for', async () => {
    const response = await request(app.getHttpServer()).get('/healthz').expect(HttpStatus.OK);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    // Must not advertise the framework.
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the configured POS origin and exposes the request id to it', async () => {
    const origin = env.CORS_ORIGINS[0];
    expect(origin).toBeDefined();

    const response = await request(app.getHttpServer())
      .get('/healthz')
      .set('Origin', origin as string)
      .expect(HttpStatus.OK);

    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-expose-headers']).toContain('x-request-id');
  });

  it('refuses an origin that is not configured', async () => {
    const response = await request(app.getHttpServer())
      .get('/healthz')
      .set('Origin', 'https://evil.example.com')
      .expect(HttpStatus.OK);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
