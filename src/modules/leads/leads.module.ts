import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LeadConfig } from '../../config/lead.config';
import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { NoStoreInterceptor } from '../invitations/interceptors/no-store.interceptor';
import { FormLeadsController } from './controllers/form-leads.controller';
import { LeadsController } from './controllers/leads.controller';
import { LeadEntry } from './entities/lead-entry.entity';
import { LeadTimelineEvent } from './entities/lead-timeline-event.entity';
import { Lead } from './entities/lead.entity';
import { LeadCommercialCycle } from './entities/lead-commercial-cycle.entity';
import { LeadReturnReview } from './entities/lead-return-review.entity';
import { LeadActivity } from './entities/lead-activity.entity';
import { LeadNote } from './entities/lead-note.entity';
import { LeadNextAction } from './entities/lead-next-action.entity';
import { FormRateLimitGuard } from './guards/form-rate-limit.guard';
import { FormSignatureGuard } from './guards/form-signature.guard';
import {
  FormLeadReadinessGuard,
  ManualLeadReadinessGuard,
} from './guards/lead-readiness.guards';
import {
  LEAD_READINESS,
  OperationalLeadReadiness,
} from './ports/lead-readiness.port';
import { FormSignatureService } from './security/form-signature.service';
import { FormRateLimiter } from './services/form-rate-limiter.service';
import { LeadsService } from './services/leads.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Lead,
      LeadEntry,
      LeadTimelineEvent,
      LeadCommercialCycle,
      LeadReturnReview,
      LeadActivity,
      LeadNote,
      LeadNextAction,
    ]),
    AuthModule,
    AuthorizationModule,
    TenantContextModule,
  ],
  controllers: [LeadsController, FormLeadsController],
  providers: [
    LeadsService,
    FormSignatureService,
    FormRateLimiter,
    FormSignatureGuard,
    FormRateLimitGuard,
    ManualLeadReadinessGuard,
    FormLeadReadinessGuard,
    NoStoreInterceptor,
    {
      provide: LEAD_READINESS,
      inject: [ConfigService, DataSource],
      useFactory: (config: ConfigService, dataSource: DataSource) =>
        new OperationalLeadReadiness(
          config.getOrThrow<LeadConfig>('lead'),
          dataSource,
        ),
    },
  ],
})
export class LeadsModule {}
