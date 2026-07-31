import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import invitationConfig from './invitation.config';
import leadConfig from './lead.config';
import membershipConfig from './membership.config';
import { validateEnvironment } from './environment.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        invitationConfig,
        leadConfig,
        membershipConfig,
      ],
      validate: validateEnvironment,
    }),
  ],
})
export class ConfigurationModule {}
