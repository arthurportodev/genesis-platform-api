import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ContextRequest,
  getRequestContext,
} from '../logging/request-context.middleware';
import { writeStructuredLog } from '../logging/structured-logger';

interface ErrorResponse {
  statusCode: number;
  message: string | string[];
  path: string;
  timestamp: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<ContextRequest>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;

    if (!(exception instanceof HttpException)) {
      const requestContext = getRequestContext(request);
      const route = request.route as { path?: unknown } | undefined;
      writeStructuredLog('error', {
        event: 'http.unhandled_error',
        requestId: requestContext.requestId,
        correlationId: requestContext.correlationId,
        method: request.method,
        route: typeof route?.path === 'string' ? route.path : 'unknown',
        status,
        errorType: 'internal_error',
      });
    }

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      response.status(status).json(exceptionResponse);
      return;
    }

    const body: ErrorResponse = {
      statusCode: status,
      message:
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : 'Internal server error',
      path: request.path,
      timestamp: new Date().toISOString(),
    };
    response.status(status).json(body);
  }
}
