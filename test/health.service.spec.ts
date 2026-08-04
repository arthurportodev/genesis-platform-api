import { DataSource } from 'typeorm';
import {
  HealthService,
  READINESS_TIMEOUT_MS,
} from '../src/health/health.service';
import { RuntimeHealthStateService } from '../src/health/runtime-health-state.service';

describe('HealthService', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps liveness independent from PostgreSQL', () => {
    const query = jest.fn();
    const service = createService(query);

    expect(service.checkLiveness()).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not query PostgreSQL before startup completes', async () => {
    const query = jest.fn();
    const service = createService(query);

    await expect(service.checkReadiness()).resolves.toEqual({
      status: 'unavailable',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns a minimal ready response after SELECT 1 succeeds', async () => {
    const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const service = createService(query, readyRuntime());

    await expect(service.checkReadiness()).resolves.toEqual({ status: 'ok' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns unavailable without exposing a PostgreSQL error', async () => {
    const query = jest
      .fn()
      .mockRejectedValue(new Error('postgres://user:secret@database/internal'));
    const service = createService(query, readyRuntime());

    const response = await service.checkReadiness();

    expect(response).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  it('returns unavailable on the deterministic database deadline', async () => {
    jest.useFakeTimers();
    const query = jest.fn().mockReturnValue(new Promise(() => undefined));
    const service = createService(query, readyRuntime());

    const response = service.checkReadiness();
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await expect(response).resolves.toEqual({ status: 'unavailable' });
  });

  it('does not query PostgreSQL while draining', async () => {
    const query = jest.fn();
    const runtime = readyRuntime();
    runtime.beginDraining();
    const service = createService(query, runtime);

    await expect(service.checkReadiness()).resolves.toEqual({
      status: 'unavailable',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when draining begins during the database query', async () => {
    let finishQuery = (): void => {
      throw new Error('database query did not start');
    };
    const query = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishQuery = resolve;
        }),
    );
    const runtime = readyRuntime();
    const service = createService(query, runtime);

    const response = service.checkReadiness();
    runtime.beginDraining();
    finishQuery();

    await expect(response).resolves.toEqual({ status: 'unavailable' });
  });
});

function readyRuntime(): RuntimeHealthStateService {
  const runtime = new RuntimeHealthStateService();
  runtime.markReady();
  return runtime;
}

function createService(
  query: jest.Mock,
  runtime = new RuntimeHealthStateService(),
): HealthService {
  return new HealthService({ query } as unknown as DataSource, runtime);
}
