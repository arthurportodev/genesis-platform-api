import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InvitationConfig } from './config/invitation.config';
import { InvitationWorkerModule } from './invitation-worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(InvitationWorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
  const invitation = app
    .get(ConfigService)
    .getOrThrow<InvitationConfig>('invitation');
  await app.listen(invitation.workerHealthPort, '127.0.0.1');
  Logger.log('Invitation worker process started.', 'Bootstrap');
}

void bootstrap();
