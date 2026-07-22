import { ConfigService } from '@nestjs/config';
import { InvitationWorkerRuntimeState } from '../src/invitation-worker-runtime-state';
import { InvitationDeliveryWorkerService } from '../src/modules/invitations/delivery/invitation-delivery-worker.service';

describe('InvitationWorkerRunner dependency injection', () => {
  it('emits constructor metadata required by the production Nest container', async () => {
    process.env.APP_NAME ??= 'Genesis Platform API';
    process.env.APP_VERSION ??= 'test';
    process.env.DATABASE_HOST ??= 'localhost';
    process.env.DATABASE_NAME ??= 'genesis_platform_test';
    process.env.DATABASE_USER ??= 'genesis_runtime';
    process.env.DATABASE_PASSWORD ??= 'test-runtime-password';
    process.env.DATABASE_RUNTIME_ROLE ??= 'genesis_runtime';

    const { InvitationWorkerRunner } =
      await import('../src/invitation-worker.module');

    expect(
      Reflect.getMetadata('design:paramtypes', InvitationWorkerRunner),
    ).toEqual([
      InvitationDeliveryWorkerService,
      ConfigService,
      InvitationWorkerRuntimeState,
    ]);
  });
});
