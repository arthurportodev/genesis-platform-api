import { Module } from '@nestjs/common';
import { RoleGuard } from './guards/role.guard';

@Module({
  providers: [RoleGuard],
  exports: [RoleGuard],
})
export class AuthorizationModule {}
