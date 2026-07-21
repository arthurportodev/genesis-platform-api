import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { OrganizationAuditModule } from '../organization-audit/organization-audit.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { InvitationsController } from './controllers/invitations.controller';
import { InvitationDeliveryOutbox } from './entities/invitation-delivery-outbox.entity';
import { OrganizationCommandIdempotency } from './entities/organization-command-idempotency.entity';
import { OrganizationInvitation } from './entities/organization-invitation.entity';
import {
  DisabledInvitationIssuanceReadiness,
  INVITATION_ISSUANCE_READINESS,
} from './ports/invitation-issuance-readiness.port';
import {
  INVITATION_TOKEN_KEYRING,
  UnavailableInvitationTokenKeyring,
} from './ports/invitation-token-keyring.port';
import { PENDING_INVITATION_REVOKER } from './ports/pending-invitation-revoker.port';
import { InvitationTokenCodec } from './services/invitation-token-codec.service';
import { InvitationsService } from './services/invitations.service';

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
  controllers: [InvitationsController],
  providers: [
    DisabledInvitationIssuanceReadiness,
    {
      provide: INVITATION_ISSUANCE_READINESS,
      useExisting: DisabledInvitationIssuanceReadiness,
    },
    {
      provide: INVITATION_TOKEN_KEYRING,
      useClass: UnavailableInvitationTokenKeyring,
    },
    InvitationTokenCodec,
    InvitationsService,
    {
      provide: PENDING_INVITATION_REVOKER,
      useExisting: InvitationsService,
    },
  ],
  exports: [PENDING_INVITATION_REVOKER],
})
export class InvitationsModule {}
