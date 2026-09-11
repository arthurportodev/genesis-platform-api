import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app.config';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsController } from './controllers/organizations.controller';
import { Organization } from './entities/organization.entity';
import { OrganizationCreationReadinessGuard } from './guards/organization-creation-readiness.guard';
import {
  ORGANIZATION_CREATION_READINESS,
  OperationalOrganizationCreationReadiness,
} from './ports/organization-creation-readiness.port';
import { OrganizationCreationRateLimiter } from './services/organization-creation-rate-limiter.service';
import { OrganizationsService } from './services/organizations.service';

@Module({
  imports: [TypeOrmModule.forFeature([Organization]), AuthModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    OrganizationCreationRateLimiter,
    OrganizationCreationReadinessGuard,
    {
      provide: ORGANIZATION_CREATION_READINESS,
      inject: [ConfigService, DataSource],
      useFactory: (config: ConfigService, dataSource: DataSource) =>
        new OperationalOrganizationCreationReadiness(
          config.getOrThrow<AppConfig>('app').publicReplicaCount,
          dataSource,
        ),
    },
  ],
})
export class OrganizationsModule {}
