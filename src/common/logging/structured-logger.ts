import { LoggerService, LogLevel } from '@nestjs/common';

export interface StructuredLogRecord {
  event: string;
  requestId?: string;
  correlationId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  context?: string;
  signal?: string;
  errorType?: string;
}

interface LogIdentity {
  service: string;
  version: string;
  environment: string;
}

const SAFE_VALUE = /^[a-zA-Z0-9_.:/ -]{1,256}$/u;
let identity: LogIdentity = {
  service: process.env.APP_NAME ?? 'genesis-platform-api',
  version: process.env.APP_VERSION ?? 'unknown',
  environment: process.env.NODE_ENV ?? 'development',
};

function safe(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_VALUE.test(value) ? value : undefined;
}

export function configureStructuredLogging(next: LogIdentity): void {
  identity = { ...next };
}

export function writeStructuredLog(
  level: LogLevel,
  record: StructuredLogRecord,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: identity.service,
    version: identity.version,
    environment: identity.environment,
    event: safe(record.event) ?? 'application.event',
    ...(safe(record.requestId) ? { requestId: safe(record.requestId) } : {}),
    ...(safe(record.correlationId)
      ? { correlationId: safe(record.correlationId) }
      : {}),
    ...(safe(record.method) ? { method: safe(record.method) } : {}),
    ...(safe(record.route) ? { route: safe(record.route) } : {}),
    ...(Number.isInteger(record.status) ? { status: record.status } : {}),
    ...(Number.isFinite(record.durationMs)
      ? { duration: Math.max(0, Math.round(record.durationMs ?? 0)) }
      : {}),
    ...(safe(record.context) ? { context: safe(record.context) } : {}),
    ...(safe(record.signal) ? { signal: safe(record.signal) } : {}),
    ...(safe(record.errorType) ? { error: safe(record.errorType) } : {}),
  };
  const output = `${JSON.stringify(entry)}\n`;
  if (level === 'error' || level === 'warn' || level === 'fatal') {
    process.stderr.write(output);
  } else {
    process.stdout.write(output);
  }
}

export class StructuredLogger implements LoggerService {
  log(_message: unknown, context?: string): void {
    writeStructuredLog('log', { event: 'application.log', context });
  }

  error(_message: unknown, _stack?: string, context?: string): void {
    writeStructuredLog('error', {
      event: 'application.error',
      context,
      errorType: 'internal_error',
    });
  }

  warn(_message: unknown, context?: string): void {
    writeStructuredLog('warn', { event: 'application.warning', context });
  }

  debug(_message: unknown, context?: string): void {
    writeStructuredLog('debug', { event: 'application.debug', context });
  }

  verbose(_message: unknown, context?: string): void {
    writeStructuredLog('verbose', { event: 'application.verbose', context });
  }

  fatal(_message: unknown, context?: string): void {
    writeStructuredLog('fatal', {
      event: 'application.fatal',
      context,
      errorType: 'fatal_error',
    });
  }
}
