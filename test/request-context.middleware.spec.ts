import { Request, Response } from 'express';
import {
  ContextRequest,
  requestContextMiddleware,
} from '../src/common/logging/request-context.middleware';

describe('requestContextMiddleware', () => {
  it('preserves only a bounded safe correlation ID', () => {
    const setHeader = jest.fn();
    const request = {
      get: () => 'correlation-123',
    } as unknown as ContextRequest;

    requestContextMiddleware(
      request,
      { setHeader } as unknown as Response,
      jest.fn(),
    );

    expect(request.genesisRequestContext?.correlationId).toBe(
      'correlation-123',
    );
    expect(setHeader).toHaveBeenCalledWith(
      'X-Correlation-Id',
      'correlation-123',
    );
  });

  it('replaces unsafe input without reflecting it', () => {
    const unsafe = 'Bearer secret?email=person@example.com';
    const request = {
      get: () => unsafe,
    } as unknown as Request & ContextRequest;

    requestContextMiddleware(
      request,
      { setHeader: jest.fn() } as unknown as Response,
      jest.fn(),
    );

    expect(request.genesisRequestContext?.correlationId).toBe(
      request.genesisRequestContext?.requestId,
    );
    expect(request.genesisRequestContext?.correlationId).not.toContain(unsafe);
  });
});
