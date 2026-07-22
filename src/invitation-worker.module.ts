import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvitationWorkerConfigurationModule } from './config/invitation-worker-configuration.module';
import { InvitationConfig } from './config/invitation.config';
import { AppConfig } from './config/app.config';
import { DatabaseModule } from './database/database.module';
import { InvitationDeliveryWorkerService } from './modules/invitations/delivery/invitation-delivery-worker.service';
import { INVITATION_EMAIL_DELIVERY } from './modules/invitations/delivery/invitation-email-delivery.port';
import { InvitationEmailV1Renderer } from './modules/invitations/delivery/invitation-email-v1.renderer';
import { ResendInvitationEmailAdapter } from './modules/invitations/delivery/resend-invitation-email.adapter';
import {
  ConfiguredInvitationTokenKeyring,
  INVITATION_TOKEN_KEYRING,
} from './modules/invitations/ports/invitation-token-keyring.port';
import { InvitationTokenCodec } from './modules/invitations/services/invitation-token-codec.service';
import { InvitationWorkerRuntimeState } from './invitation-worker-runtime-state';
import { InvitationWorkerHealthController } from './invitation-worker-health.controller';
import { InvitationWorkerHealthService } from './invitation-worker-health.service';
import { InvitationWorkerObservability } from './modules/invitations/delivery/invitation-worker-observability.service';

@Injectable()
export class InvitationWorkerRunner
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(InvitationWorkerRunner.name);
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly worker: InvitationDeliveryWorkerService,
    private readonly config: ConfigService,
    private readonly runtime: InvitationWorkerRuntimeState,
  ) {}

  onApplicationBootstrap(): void {
    const invitation = this.config.getOrThrow<InvitationConfig>('invitation');
    if (!invitation.workerEnabled) {
      this.logger.warn('Invitation worker is disabled.');
      return;
    }
    this.runtime.heartbeat();
    this.loopPromise = this.loop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.loopPromise === null) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), 10_000);
    });
    const outcome = await Promise.race([
      this.loopPromise.then(() => 'drained' as const),
      deadline,
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (outcome === 'timeout') {
      this.logger.warn('Invitation worker drain deadline reached.');
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const outcome = await this.worker.processOnce();
        this.consecutiveFailures = 0;
        this.runtime.heartbeat();
        if (outcome === 'idle')
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
      } catch {
        this.consecutiveFailures += 1;
        this.logger.error('Invitation worker iteration failed.');
        if (this.consecutiveFailures >= 3) this.runtime.markFatal();
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}

@Module({
  imports: [InvitationWorkerConfigurationModule, DatabaseModule],
  controllers: [InvitationWorkerHealthController],
  providers: [
    {
      provide: INVITATION_TOKEN_KEYRING,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const invitation = config.getOrThrow<InvitationConfig>('invitation');
        return new ConfiguredInvitationTokenKeyring(
          invitation.tokenKeys,
          invitation.tokenCurrentVersion,
        );
      },
    },
    InvitationTokenCodec,
    {
      provide: InvitationEmailV1Renderer,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const invitation = config.getOrThrow<InvitationConfig>('invitation');
        if (
          invitation.workerEnabled &&
          (!invitation.acceptanceUrl || !invitation.emailFrom)
        ) {
          throw new Error(
            'Worker requires invitation acceptance URL and sender.',
          );
        }
        return new InvitationEmailV1Renderer({
          acceptanceUrl: invitation.acceptanceUrl,
          from: invitation.emailFrom,
        });
      },
    },
    {
      provide: INVITATION_EMAIL_DELIVERY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const invitation = config.getOrThrow<InvitationConfig>('invitation');
        const app = config.getOrThrow<AppConfig>('app');
        if (invitation.workerEnabled && invitation.resendApiKey === null) {
          throw new Error('Worker requires RESEND_API_KEY.');
        }
        return new ResendInvitationEmailAdapter({
          apiKey: invitation.resendApiKey ?? 'disabled',
          apiUrl: invitation.resendApiUrl,
          userAgent: `genesis-platform/${app.version}`,
          timeoutMs: 10_000,
        });
      },
    },
    InvitationDeliveryWorkerService,
    InvitationWorkerObservability,
    InvitationWorkerRuntimeState,
    InvitationWorkerHealthService,
    InvitationWorkerRunner,
  ],
})
export class InvitationWorkerModule {}
