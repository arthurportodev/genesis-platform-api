import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import { RuntimeHealthStateService } from '../src/health/runtime-health-state.service';
import { configurePublicHealthEndpoint } from '../src/main';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';

jest.mock('../src/app.module', () => ({ AppModule: class AppModule {} }));

describe('Runtime health endpoints (e2e)', () => {
  let app: NestExpressApplication;
  let runtime: RuntimeHealthStateService;
  let healthService: HealthService;
  const query = jest.fn();

  beforeEach(async () => {
    query.mockReset();
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        RuntimeHealthStateService,
        { provide: DataSource, useValue: { query } },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    runtime = app.get(RuntimeHealthStateService);
    healthService = app.get(HealthService);
    configurePublicHealthEndpoint(app, healthService);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => app.close());

  it('keeps liveness available during startup without querying PostgreSQL', async () => {
    const response = await get('/api/v1/health/live').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps readiness unavailable before startup completes', async () => {
    const response = await get('/api/v1/health/ready').expect(503);

    expect(response.body).toEqual({ status: 'unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(query).not.toHaveBeenCalled();
  });

  it('gives public and internal routes the same readiness semantics', async () => {
    runtime.markReady();
    query.mockResolvedValue([{ '?column?': 1 }]);

    const publicResponse = await get('/health').expect(200);
    const compatibility = await get('/api/v1/health').expect(200);
    const explicit = await get('/api/v1/health/ready').expect(200);

    expect(publicResponse.body).toEqual({ status: 'ok' });
    expect(compatibility.body).toEqual(publicResponse.body);
    expect(explicit.body).toEqual(publicResponse.body);
    expect(publicResponse.headers['cache-control']).toBe('no-store');
    expect(compatibility.headers['cache-control']).toBe('no-store');
    expect(explicit.headers['cache-control']).toBe('no-store');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('returns a sanitized 503 when PostgreSQL is unavailable', async () => {
    runtime.markReady();
    query.mockRejectedValue(new Error('postgres://user:secret@internal/db'));

    const response = await get('/api/v1/health/ready').expect(503);

    expect(response.body).toEqual({ status: 'unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toMatch(
      /secret|postgres|database|version|stack/i,
    );
  });

  it('disables all readiness routes immediately while draining', async () => {
    runtime.markReady();
    runtime.beginDraining();

    await get('/health').expect(503).expect({ status: 'unavailable' });
    await get('/api/v1/health').expect(503).expect({ status: 'unavailable' });
    await get('/api/v1/health/ready')
      .expect(503)
      .expect({ status: 'unavailable' });
    await get('/api/v1/health/live').expect(200).expect({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not report liveness after the runtime has stopped', async () => {
    runtime.onApplicationShutdown();

    await get('/api/v1/health/live')
      .expect(503)
      .expect({ status: 'unavailable' });
  });

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path);
  }
});
