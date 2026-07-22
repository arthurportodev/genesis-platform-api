import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InvitationConfig } from './config/invitation.config';
import { InvitationWorkerRuntimeState } from './invitation-worker-runtime-state';
import { InvitationDeliveryWorkerService } from './modules/invitations/delivery/invitation-delivery-worker.service';

@Injectable()
export class InvitationWorkerHealthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly worker: InvitationDeliveryWorkerService,
    private readonly runtime: InvitationWorkerRuntimeState,
  ) {}

  async status(): Promise<{ healthy: boolean }> {
    try {
      const invitation = this.config.getOrThrow<InvitationConfig>('invitation');
      if (!invitation.workerEnabled || !this.runtime.isHealthy()) {
        return { healthy: false };
      }
      await this.dataSource.query('SELECT 1');
      const keyringReady = await this.worker.isKeyringReady();
      await this.worker.refreshOperationalGauges();
      return { healthy: keyringReady };
    } catch {
      return { healthy: false };
    }
  }
}
