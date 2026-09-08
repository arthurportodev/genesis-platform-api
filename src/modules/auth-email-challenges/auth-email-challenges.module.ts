import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResendEmailTransport } from '../../common/email/resend-email.transport';
import { AppConfig } from '../../config/app.config';
import { InvitationConfig } from '../../config/invitation.config';
import { AuthAuditService } from '../auth/services/auth-audit.service';
import { AuthSessionsModule } from '../auth-sessions/auth-sessions.module';
import { AuthEmailChallenge } from './auth-email-challenge.entity';
import {
  AUTH_OTP_EMAIL_TRANSPORT,
  AuthEmailChallengesService,
} from './auth-email-challenges.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuthEmailChallenge]), AuthSessionsModule],
  providers: [
    AuthAuditService,
    {
      provide: AUTH_OTP_EMAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const invitation = config.getOrThrow<InvitationConfig>('invitation');
        if (!invitation.resendApiKey) return null;
        return new ResendEmailTransport({
          apiKey: invitation.resendApiKey,
          apiUrl: invitation.resendApiUrl,
          userAgent: `genesis-platform/${config.getOrThrow<AppConfig>('app').version}`,
          timeoutMs: 10_000,
        });
      },
    },
    AuthEmailChallengesService,
  ],
  exports: [AuthEmailChallengesService],
})
export class AuthEmailChallengesModule {}
