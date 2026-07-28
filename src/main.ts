import {
  ClassSerializerInterceptor,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import {
  AppConfig,
  buildWebCorsOptions,
  isSensitiveWebResponse,
} from './config/app.config';
import { configureTrustProxy } from './config/trust-proxy';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const configService = app.get(ConfigService);
  const config = configService.getOrThrow<AppConfig>('app');

  configureTrustProxy(app, config.trustProxyHops);
  app.setGlobalPrefix('api/v1');
  app.enableCors(buildWebCorsOptions(config.frontendUrl));
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (
      isSensitiveWebResponse(request.path, request.get('x-organization-id'))
    ) {
      response.setHeader('Cache-Control', 'no-store');
    }
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(config.port);
  Logger.log(
    `${config.name} v${config.version} listening on port ${config.port}`,
    'Bootstrap',
  );
}

void bootstrap();
