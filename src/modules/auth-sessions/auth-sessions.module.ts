import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthAuditLog } from './entities/auth-audit-log.entity';
import { AuthRefreshToken } from './entities/auth-refresh-token.entity';
import { AuthSession } from './entities/auth-session.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuthSession, AuthRefreshToken, AuthAuditLog]),
  ],
  exports: [TypeOrmModule],
})
export class AuthSessionsModule {}
