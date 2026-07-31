import { CallHandler, ExecutionContext } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { of } from 'rxjs';
import { HttpLoggingInterceptor } from '../src/common/logging/http-logging.interceptor';

describe('HttpLoggingInterceptor', () => {
  it('logs only the route template and allowlisted request metadata', () => {
    const output = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const request = {
      method: 'GET',
      baseUrl: '/api/v1',
      route: { path: '/members/:id' },
      originalUrl: '/api/v1/members/private-id?email=person@example.com',
      genesisRequestContext: {
        requestId: 'request-1',
        correlationId: 'correlation-1',
      },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;

    new HttpLoggingInterceptor().intercept(context, {
      handle: () => of(null),
    } as CallHandler);
    response.emit('finish');

    const log = output.mock.calls.map(([value]) => String(value)).join('');
    expect(log).toContain('/api/v1/members/:id');
    expect(log).not.toContain('private-id');
    expect(log).not.toContain('person@example.com');
    output.mockRestore();
  });
});
