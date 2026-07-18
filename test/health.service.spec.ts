import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { HealthService } from '../src/health/health.service';

describe('HealthService', () => {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue({ version: '0.1.0' }),
  } as unknown as ConfigService;

  it('returns a healthy response when PostgreSQL responds', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as unknown as DataSource;
    const response = await new HealthService(dataSource, configService).check();

    expect(response).toMatchObject({
      status: 'ok',
      service: 'genesis-platform-api',
      version: '0.1.0',
      database: 'connected',
    });
    expect(new Date(response.timestamp).toISOString()).toBe(response.timestamp);
  });

  it('returns an unhealthy response without exposing the database error', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockRejectedValue(new Error('sensitive connection details')),
    } as unknown as DataSource;
    const response = await new HealthService(dataSource, configService).check();

    expect(response).toMatchObject({
      status: 'error',
      database: 'disconnected',
    });
    expect(response).not.toHaveProperty('error');
  });
});
