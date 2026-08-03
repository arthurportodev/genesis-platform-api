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
import { HealthResponse, HealthService } from './health/health.service';
import { RuntimeHealthStateService } from './health/runtime-health-state.service';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export const SHUTDOWN_TIMEOUT_MS = 12_000;

type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface ShutdownDeadlineDependencies {
  setTimer: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  onExit: (listener: () => void) => void;
  exit: (code: number) => never;
  logTimeout: (signal: ShutdownSignal) => void;
}

const shutdownDeadlineDependencies: ShutdownDeadlineDependencies = {
  setTimer: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimer: (timer) => clearTimeout(timer),
  onExit: (listener) => process.once('exit', listener),
  exit: (code) => process.exit(code),
  logTimeout: (signal) =>
    Logger.error(
      `Runtime shutdown deadline exceeded after ${signal}`,
      'Bootstrap',
    ),
};

export function createShutdownSignalHandler(
  runtimeState: RuntimeHealthStateService,
  dependencies: ShutdownDeadlineDependencies = shutdownDeadlineDependencies,
): (signal: ShutdownSignal) => void {
  let shutdownStarted = false;

  return (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    runtimeState.beginDraining();

    const deadline = dependencies.setTimer(() => {
      dependencies.logTimeout(signal);
      dependencies.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    dependencies.onExit(() => dependencies.clearTimer(deadline));
  };
}

export function configureShutdownHooks(app: NestExpressApplication): void {
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS], {
    useProcessExit: true,
  });
}

export function installShutdownDeadline(
  runtimeState: RuntimeHealthStateService,
): void {
  const handleSignal = createShutdownSignalHandler(runtimeState);
  for (const signal of SHUTDOWN_SIGNALS) {
    process.prependListener(signal, () => handleSignal(signal));
  }
}

export function configurePublicHealthEndpoint(
  app: NestExpressApplication,
  healthService: HealthService,
): void {
  const expressApp = app.getHttpAdapter().getInstance();

  expressApp.get('/health', async (_request: Request, response: Response) => {
    const result = await healthService.checkReadiness();
    response.setHeader('Cache-Control', 'no-store');
    response
      .status(result.status === 'ok' ? 200 : 503)
      .json(result satisfies HealthResponse);
  });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const configService = app.get(ConfigService);
  const config = configService.getOrThrow<AppConfig>('app');
  const healthService = app.get(HealthService);
  const runtimeState = app.get(RuntimeHealthStateService);

  configureTrustProxy(app, config.trustProxyHops);
  configurePublicHealthEndpoint(app, healthService);
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
  configureShutdownHooks(app);
  installShutdownDeadline(runtimeState);

  await app.listen(config.port);
  runtimeState.markReady();
  Logger.log(
    `${config.name} v${config.version} listening on port ${config.port}`,
    'Bootstrap',
  );
}

if (require.main === module) void bootstrap();
