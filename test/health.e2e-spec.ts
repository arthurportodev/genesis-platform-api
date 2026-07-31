import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import { RuntimeHealthStateService } from '../src/health/runtime-health-state.service';

describe('Health endpoints (e2e)', () => {
  let app: INestApplication;
  let runtime: RuntimeHealthStateService;
  const query = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        RuntimeHealthStateService,
        { provide: DataSource, useValue: { query } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    runtime = app.get(RuntimeHealthStateService);
    await app.init();
  });

  afterAll(async () => app.close());

  it('liveness is minimal and does not query PostgreSQL', async () => {
    query.mockClear();
    await request(app.getHttpServer() as Server)
      .get('/api/v1/health/live')
      .expect(200)
      .expect({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('readiness stays unavailable before startup completion', async () => {
    await request(app.getHttpServer() as Server)
      .get('/api/v1/health/ready')
      .expect(503)
      .expect({ status: 'unavailable' });
  });

  it('readiness and its compatibility alias use PostgreSQL', async () => {
    runtime.markReady();
    query.mockResolvedValue([{ '?column?': 1 }]);

    await request(app.getHttpServer() as Server)
      .get('/api/v1/health/ready')
      .expect(200)
      .expect({ status: 'ok' });
    await request(app.getHttpServer() as Server)
      .get('/api/v1/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('returns 503 without internal detail when PostgreSQL is unavailable', async () => {
    query.mockRejectedValueOnce(new Error('database secret unavailable'));
    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/health/ready')
      .expect(503);

    expect(response.body).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(response.body)).not.toContain('database secret');
  });

  it('turns readiness off while keeping liveness during draining', async () => {
    runtime.beginDraining('SIGTERM');
    await request(app.getHttpServer() as Server)
      .get('/api/v1/health/ready')
      .expect(503);
    await request(app.getHttpServer() as Server)
      .get('/api/v1/health/live')
      .expect(200);
  });
});
