import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { OrganizationAuditModule } from '../organization-audit/organization-audit.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { InvitationsController } from './controllers/invitations.controller';
import { InvitationAcceptanceController } from './controllers/invitation-acceptance.controller';
import { InvitationConfig } from '../../config/invitation.config';
import { InvitationDeliveryOutbox } from './entities/invitation-delivery-outbox.entity';
import { OrganizationCommandIdempotency } from './entities/organization-command-idempotency.entity';
import { OrganizationInvitation } from './entities/organization-invitation.entity';
import {
  ConfiguredInvitationIssuanceReadiness,
  INVITATION_ISSUANCE_READINESS,
} from './ports/invitation-issuance-readiness.port';
import {
  INVITATION_ACCEPTANCE_READINESS,
  OperationalInvitationAcceptanceReadiness,
} from './ports/invitation-acceptance-readiness.port';
import {
  ConfiguredInvitationTokenKeyring,
  INVITATION_TOKEN_KEYRING,
} from './ports/invitation-token-keyring.port';
import { PENDING_INVITATION_REVOKER } from './ports/pending-invitation-revoker.port';
import { InvitationTokenCodec } from './services/invitation-token-codec.service';
import { InvitationsService } from './services/invitations.service';
import { InvitationAcceptanceService } from './services/invitation-acceptance.service';
import { InvitationAcceptanceRateLimiter } from './services/invitation-acceptance-rate-limiter.service';
import {
  InvitationAcceptIpRateLimitGuard,
  InvitationAcceptUserIpRateLimitGuard,
  InvitationInspectRateLimitGuard,
} from './guards/invitation-acceptance-rate-limit.guards';
import { NoStoreInterceptor } from './interceptors/no-store.interceptor';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrganizationInvitation,
      OrganizationCommandIdempotency,
      InvitationDeliveryOutbox,
    ]),
    AuthModule,
    TenantContextModule,
    AuthorizationModule,
    OrganizationAuditModule,
  ],
  controllers: [InvitationsController, InvitationAcceptanceController],
  providers: [
    {
      provide: INVITATION_ISSUANCE_READINESS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new ConfiguredInvitationIssuanceReadiness(
          config.getOrThrow<InvitationConfig>('invitation').issuanceReady,
        ),
    },
    {
      provide: INVITATION_ACCEPTANCE_READINESS,
      inject: [ConfigService, INVITATION_TOKEN_KEYRING, DataSource],
      useFactory: (
        config: ConfigService,
        keyring: ConfiguredInvitationTokenKeyring,
        dataSource: DataSource,
      ) => {
        const invitation = config.getOrThrow<InvitationConfig>('invitation');
        return new OperationalInvitationAcceptanceReadiness(
          invitation.acceptanceReady,
          keyring,
          dataSource,
        );
      },
    },
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
    InvitationsService,
    InvitationAcceptanceService,
    InvitationAcceptanceRateLimiter,
    InvitationInspectRateLimitGuard,
    InvitationAcceptIpRateLimitGuard,
    InvitationAcceptUserIpRateLimitGuard,
    NoStoreInterceptor,
    {
      provide: PENDING_INVITATION_REVOKER,
      useExisting: InvitationsService,
    },
  ],
  exports: [PENDING_INVITATION_REVOKER],
})
export class InvitationsModule {}
