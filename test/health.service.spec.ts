import { DataSource } from 'typeorm';
import { HealthService } from '../src/health/health.service';
import { RuntimeHealthStateService } from '../src/health/runtime-health-state.service';

describe('HealthService', () => {
  it('keeps liveness independent from PostgreSQL', () => {
    const query = jest.fn();
    const dataSource = { query } as unknown as DataSource;
    const runtime = new RuntimeHealthStateService();
    const service = new HealthService(dataSource, runtime);

    expect(service.checkLiveness()).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns unavailable readiness until startup completes', async () => {
    const query = jest.fn();
    const dataSource = { query } as unknown as DataSource;
    const runtime = new RuntimeHealthStateService();
    const service = new HealthService(dataSource, runtime);

    await expect(service.checkReadiness()).resolves.toEqual({
      status: 'unavailable',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns a minimal ready response when PostgreSQL responds', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as unknown as DataSource;
    const runtime = new RuntimeHealthStateService();
    runtime.markReady();

    await expect(
      new HealthService(dataSource, runtime).checkReadiness(),
    ).resolves.toEqual({ status: 'ok' });
  });

  it('returns unavailable without exposing a PostgreSQL error', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockRejectedValue(
          new Error('postgres://user:secret@database/internal'),
        ),
    } as unknown as DataSource;
    const runtime = new RuntimeHealthStateService();
    runtime.markReady();

    const response = await new HealthService(
      dataSource,
      runtime,
    ).checkReadiness();

    expect(response).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(response)).not.toContain('secret');
  });
});
