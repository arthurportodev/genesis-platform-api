import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { HealthController } from '../src/health/health.controller';
import { HealthResponse, HealthService } from '../src/health/health.service';

describe('Health endpoint (e2e)', () => {
  let app: INestApplication;
  const query = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: DataSource, useValue: { query } },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => ({ version: '0.1.0' }),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('GET /api/v1/health returns the expected contract', async () => {
    query.mockResolvedValueOnce([{ '?column?': 1 }]);
    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/health')
      .expect(200);
    const body = response.body as HealthResponse;

    expect(body).toMatchObject({
      status: 'ok',
      service: 'genesis-platform-api',
      version: '0.1.0',
      database: 'connected',
    });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('returns 503 when PostgreSQL is unavailable', async () => {
    query.mockRejectedValueOnce(new Error('database unavailable'));
    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/health')
      .expect(503);

    expect(response.body).toMatchObject({
      status: 'error',
      database: 'disconnected',
    });
  });
});
