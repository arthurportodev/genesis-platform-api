import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  requestId: string;
  correlationId: string;
}

export type ContextRequest = Request & {
  genesisRequestContext?: RequestContext;
};

const SAFE_EXTERNAL_ID = /^[a-zA-Z0-9_.:-]{1,128}$/u;

export function requestContextMiddleware(
  request: ContextRequest,
  response: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  const externalCorrelationId = request.get('x-correlation-id');
  const correlationId =
    externalCorrelationId && SAFE_EXTERNAL_ID.test(externalCorrelationId)
      ? externalCorrelationId
      : requestId;

  request.genesisRequestContext = { requestId, correlationId };
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Correlation-Id', correlationId);
  next();
}

export function getRequestContext(request: ContextRequest): RequestContext {
  return (
    request.genesisRequestContext ?? {
      requestId: 'unavailable',
      correlationId: 'unavailable',
    }
  );
}
