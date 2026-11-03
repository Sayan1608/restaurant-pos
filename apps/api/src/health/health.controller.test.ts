import { HttpStatus, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LivenessSchema, ReadinessSchema } from '@pos/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../common/all-exceptions.filter.js';
import { ENV } from '../config/config.module.js';
import { parseEnv } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/**
 * Integration test over the real HTTP layer with Prisma stubbed: it proves the
 * routing, the status codes and the response *contract*, without needing a
 * database. The database-backed tests arrive with the repositories in Step 3.
 */
describe('health endpoints', () => {
  let app: INestApplication;
  const ping = vi.fn<() => Promise<void>>();

  const env = parseEnv({
    NODE_ENV: 'test',
    APP_VERSION: '1.2.3-test',
    DATABASE_URL: 'postgresql://pos:pos@localhost:5432/pos',
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: ENV, useValue: env },
        { provide: PrismaService, useValue: { ping } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(env));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('GET /healthz', () => {
    it('is 200 and matches the liveness contract', async () => {
      const response = await request(app.getHttpServer()).get('/healthz').expect(HttpStatus.OK);

      expect(LivenessSchema.parse(response.body)).toMatchObject({
        status: 'ok',
        service: 'pos-api',
        version: '1.2.3-test',
      });
    });

    it('does not touch the database', async () => {
      ping.mockClear();
      await request(app.getHttpServer()).get('/healthz').expect(HttpStatus.OK);
      expect(ping).not.toHaveBeenCalled();
    });
  });

  describe('GET /readyz', () => {
    it('is 200 with postgres up', async () => {
      ping.mockResolvedValueOnce(undefined);

      const response = await request(app.getHttpServer()).get('/readyz').expect(HttpStatus.OK);
      const body = ReadinessSchema.parse(response.body);

      expect(body.status).toBe('ok');
      expect(body.dependencies).toHaveLength(1);
      expect(body.dependencies[0]).toMatchObject({ name: 'postgres', status: 'up' });
      expect(body.dependencies[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('is 503 and degraded with postgres down, naming the failure', async () => {
      ping.mockRejectedValueOnce(new Error('connection refused'));

      const response = await request(app.getHttpServer())
        .get('/readyz')
        .expect(HttpStatus.SERVICE_UNAVAILABLE);
      const body = ReadinessSchema.parse(response.body);

      expect(body.status).toBe('degraded');
      expect(body.dependencies[0]).toMatchObject({
        name: 'postgres',
        status: 'down',
        error: 'connection refused',
      });
    });
  });

  it('answers an unknown route with the shared error envelope', async () => {
    const response = await request(app.getHttpServer()).get('/nope').expect(HttpStatus.NOT_FOUND);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error).toHaveProperty('requestId');
  });
});
