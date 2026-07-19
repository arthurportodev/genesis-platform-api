import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Membership } from '../memberships/entities/membership.entity';
import { TenantContextGuard } from './guards/tenant-context.guard';
import {
  TENANT_CONTEXT_RESOLVER,
  TenantContextService,
} from './services/tenant-context.service';

@Module({
  imports: [TypeOrmModule.forFeature([Membership])],
  providers: [
    TenantContextService,
    {
      provide: TENANT_CONTEXT_RESOLVER,
      useExisting: TenantContextService,
    },
    TenantContextGuard,
  ],
  exports: [TENANT_CONTEXT_RESOLVER, TenantContextGuard],
})
export class TenantContextModule {}
