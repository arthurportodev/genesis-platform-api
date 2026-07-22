import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app.config';
import { MembershipConfig } from '../../config/membership.config';
import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { MembershipsController } from './controllers/memberships.controller';
import { Membership } from './entities/membership.entity';
import { MembershipReadRateLimitGuard } from './guards/membership-read-rate-limit.guard';
import { MembershipCommandRateLimitGuard } from './guards/membership-command-rate-limit.guard';
import { MembershipReadinessGuard } from './guards/membership-readiness.guard';
import {
  MEMBERSHIP_READINESS,
  OperationalMembershipReadiness,
} from './ports/membership-readiness.port';
import { MembershipReadRateLimiter } from './services/membership-read-rate-limiter.service';
import { MembershipsService } from './services/memberships.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Membership]),
    AuthModule,
    AuthorizationModule,
    TenantContextModule,
  ],
  controllers: [MembershipsController],
  providers: [
    MembershipsService,
    {
      provide: MEMBERSHIP_READINESS,
      inject: [ConfigService, DataSource],
      useFactory: (config: ConfigService, dataSource: DataSource) =>
        new OperationalMembershipReadiness(
          config.getOrThrow<AppConfig>('app').publicReplicaCount,
          dataSource,
        ),
    },
    {
      provide: MembershipReadRateLimiter,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new MembershipReadRateLimiter(
          config.getOrThrow<MembershipConfig>('membership'),
        ),
    },
    MembershipReadRateLimitGuard,
    MembershipCommandRateLimitGuard,
    MembershipReadinessGuard,
  ],
})
export class MembershipsModule {}
