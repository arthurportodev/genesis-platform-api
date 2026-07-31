import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import {
  ContextRequest,
  getRequestContext,
} from './request-context.middleware';
import { writeStructuredLog } from './structured-logger';

function routeTemplate(request: Request): string {
  const route = request.route as { path?: unknown } | undefined;
  const path = typeof route?.path === 'string' ? route.path : 'unknown';
  return `${request.baseUrl}${path}` || 'unknown';
}

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<ContextRequest>();
    const response = http.getResponse<Response>();
    const startedAt = performance.now();
    let recorded = false;

    const record = (): void => {
      if (recorded) return;
      recorded = true;
      const route = routeTemplate(request);
      if (route.startsWith('/api/v1/health/') && response.statusCode < 400) {
        return;
      }
      const requestContext = getRequestContext(request);
      writeStructuredLog(response.statusCode >= 500 ? 'error' : 'log', {
        event: 'http.request.completed',
        requestId: requestContext.requestId,
        correlationId: requestContext.correlationId,
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: performance.now() - startedAt,
        ...(response.statusCode >= 500 ? { errorType: 'http_5xx' } : {}),
      });
    };

    response.once('finish', record);
    response.once('close', record);
    return next.handle();
  }
}
