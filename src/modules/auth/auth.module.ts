import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthSessionsModule } from '../auth-sessions/auth-sessions.module';
import { AuthSession } from '../auth-sessions/entities/auth-session.entity';
import { User } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccessTokenGuard } from './guards/access-token.guard';
import { AuthAuditService } from './services/auth-audit.service';
import { InMemoryLoginRateLimiter } from './services/in-memory-login-rate-limiter.service';
import { LoginRateLimiter } from './services/login-rate-limiter.port';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';

@Module({
  imports: [
    JwtModule.register({}),
    TypeOrmModule.forFeature([User, AuthSession]),
    AuthSessionsModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthAuditService,
    PasswordService,
    TokenService,
    AccessTokenGuard,
    {
      provide: LoginRateLimiter,
      useClass: InMemoryLoginRateLimiter,
    },
  ],
})
export class AuthModule {}
