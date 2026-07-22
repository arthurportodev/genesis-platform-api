import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';
import appConfig from './app.config';
import databaseConfig from './database.config';
import invitationConfig from './invitation.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, databaseConfig, invitationConfig],
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'production')
          .default('development'),
        APP_NAME: Joi.string().trim().required(),
        APP_VERSION: Joi.string().trim().required(),
        DATABASE_HOST: Joi.string().trim().required(),
        DATABASE_PORT: Joi.number().port().default(5432),
        DATABASE_NAME: Joi.string().trim().required(),
        DATABASE_USER: Joi.string().trim().required(),
        DATABASE_PASSWORD: Joi.string().min(1).required(),
        DATABASE_RUNTIME_ROLE: Joi.string()
          .pattern(/^[a-z_][a-z0-9_]{0,62}$/)
          .required(),
        INVITATION_WORKER_ENABLED: Joi.string()
          .valid('true', 'false')
          .default('false'),
        INVITATION_WORKER_HEALTH_PORT: Joi.number().port().default(3001),
        INVITATION_ACCEPTANCE_URL: Joi.string()
          .uri({ scheme: ['http', 'https'] })
          .allow('')
          .default(''),
        INVITATION_EMAIL_FROM: Joi.string()
          .trim()
          .max(320)
          .allow('')
          .default(''),
        INVITATION_TOKEN_CURRENT_VERSION: Joi.alternatives()
          .try(Joi.number().integer().min(1).max(32767), Joi.string().valid(''))
          .optional(),
        INVITATION_TOKEN_KEYS: Joi.string().allow('').optional(),
        RESEND_API_KEY: Joi.string().min(1).allow('').optional(),
        RESEND_API_URL: Joi.string()
          .uri({ scheme: ['https'] })
          .default('https://api.resend.com/emails'),
      }),
      validationOptions: { abortEarly: false },
    }),
  ],
})
export class InvitationWorkerConfigurationModule {}
