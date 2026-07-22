import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import invitationConfig from './invitation.config';
import { environmentValidationSchema } from './environment.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, authConfig, databaseConfig, invitationConfig],
      validationSchema: environmentValidationSchema,
      validationOptions: { abortEarly: false },
    }),
  ],
})
export class ConfigurationModule {}
