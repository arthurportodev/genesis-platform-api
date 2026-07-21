import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationAuditLog } from './entities/organization-audit-log.entity';
import { OrganizationAuditService } from './services/organization-audit.service';

@Module({
  imports: [TypeOrmModule.forFeature([OrganizationAuditLog])],
  providers: [OrganizationAuditService],
  exports: [OrganizationAuditService],
})
export class OrganizationAuditModule {}
