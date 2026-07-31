import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { HttpLoggingInterceptor } from './common/logging/http-logging.interceptor';
import { requestContextMiddleware } from './common/logging/request-context.middleware';
import {
  configureStructuredLogging,
  StructuredLogger,
  writeStructuredLog,
} from './common/logging/structured-logger';
import {
  AppConfig,
  buildWebCorsOptions,
  isSensitiveWebResponse,
} from './config/app.config';
import { configureTrustProxy } from './config/trust-proxy';
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
  writeTimeout: (signal: ShutdownSignal) => void;
}

const shutdownDeadlineDependencies: ShutdownDeadlineDependencies = {
  setTimer: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimer: (timer) => clearTimeout(timer),
  onExit: (listener) => process.once('exit', listener),
  exit: (code) => process.exit(code),
  writeTimeout: (signal) =>
    writeStructuredLog('fatal', {
      event: 'runtime.shutdown_timeout',
      signal,
      errorType: 'shutdown_timeout',
    }),
};

export function createShutdownSignalHandler(
  runtimeState: RuntimeHealthStateService,
  dependencies: ShutdownDeadlineDependencies = shutdownDeadlineDependencies,
): (signal: ShutdownSignal) => void {
  let shutdownStarted = false;

  return (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    runtimeState.beginDraining(signal);
    const deadline = dependencies.setTimer(() => {
      dependencies.writeTimeout(signal);
      dependencies.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    dependencies.onExit(() => dependencies.clearTimer(deadline));
  };
}

function installShutdownDeadline(
  runtimeState: RuntimeHealthStateService,
): void {
  const handleSignal = createShutdownSignalHandler(runtimeState);
  for (const signal of SHUTDOWN_SIGNALS) {
    process.prependOnceListener(signal, () => handleSignal(signal));
  }
}

export function configureShutdownHooks(app: NestExpressApplication): void {
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS], { useProcessExit: true });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: false,
  });
  const configService = app.get(ConfigService);
  const config = configService.getOrThrow<AppConfig>('app');
  configureStructuredLogging({
    service: config.name,
    version: config.version,
    environment: process.env.NODE_ENV ?? 'development',
  });
  app.useLogger(new StructuredLogger());
  const runtimeState = app.get(RuntimeHealthStateService);

  configureTrustProxy(app, config.trustProxyHops);
  app.setGlobalPrefix('api/v1');
  app.enableCors(buildWebCorsOptions(config.frontendUrl));
  app.use(requestContextMiddleware);
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
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
    new HttpLoggingInterceptor(),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  configureShutdownHooks(app);
  installShutdownDeadline(runtimeState);

  await app.listen(config.port);
  runtimeState.markReady();
  writeStructuredLog('log', { event: 'runtime.started' });
}

if (require.main === module) void bootstrap();
