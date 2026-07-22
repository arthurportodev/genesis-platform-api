import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InvitationWorkerHealthService } from '../src/invitation-worker-health.service';
import { InvitationWorkerRuntimeState } from '../src/invitation-worker-runtime-state';
import { InvitationDeliveryWorkerService } from '../src/modules/invitations/delivery/invitation-delivery-worker.service';

describe('InvitationWorkerHealthService', () => {
  const config = (enabled = true) =>
    ({
      getOrThrow: jest.fn().mockReturnValue({ workerEnabled: enabled }),
    }) as unknown as ConfigService;

  function fixture(options?: {
    enabled?: boolean;
    dbFails?: boolean;
    keyringReady?: boolean;
  }): {
    health: InvitationWorkerHealthService;
    runtime: InvitationWorkerRuntimeState;
    worker: jest.Mocked<
      Pick<
        InvitationDeliveryWorkerService,
        'isKeyringReady' | 'refreshOperationalGauges'
      >
    >;
  } {
    const dataSource = {
      query: options?.dbFails
        ? jest.fn().mockRejectedValue(new Error('db'))
        : jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as unknown as DataSource;
    const worker = {
      isKeyringReady: jest
        .fn()
        .mockResolvedValue(options?.keyringReady ?? true),
      refreshOperationalGauges: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new InvitationWorkerRuntimeState();
    const health = new InvitationWorkerHealthService(
      dataSource,
      config(options?.enabled ?? true),
      worker as unknown as InvitationDeliveryWorkerService,
      runtime,
    );
    return { health, runtime, worker };
  }

  it('is ready with a live loop, runtime database, configuration and keyring', async () => {
    const { health, runtime } = fixture();
    runtime.heartbeat();
    await expect(health.status()).resolves.toEqual({ healthy: true });
  });

  it.each([
    ['database unavailable', { dbFails: true }],
    ['worker disabled', { enabled: false }],
    ['keyring incomplete', { keyringReady: false }],
  ])('returns unhealthy when %s', async (_name, options) => {
    const { health, runtime } = fixture(options);
    runtime.heartbeat();
    await expect(health.status()).resolves.toEqual({ healthy: false });
  });

  it('returns unhealthy without a recent heartbeat or after fatal state', async () => {
    const { health, runtime } = fixture();
    await expect(health.status()).resolves.toEqual({ healthy: false });
    runtime.heartbeat();
    runtime.markFatal();
    await expect(health.status()).resolves.toEqual({ healthy: false });
  });

  it('stays healthy during a provider call within timeout margin and expires when stopped', () => {
    const runtime = new InvitationWorkerRuntimeState();
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    runtime.heartbeat();
    expect(runtime.isHealthy(16_000)).toBe(true);
    expect(runtime.isHealthy(31_001)).toBe(false);
    jest.restoreAllMocks();
  });

  it('does not probe the email provider', async () => {
    const { health, runtime, worker } = fixture();
    runtime.heartbeat();
    await health.status();
    expect(worker.isKeyringReady).toHaveBeenCalledTimes(1);
    expect(Object.keys(worker)).toEqual([
      'isKeyringReady',
      'refreshOperationalGauges',
    ]);
  });
});
