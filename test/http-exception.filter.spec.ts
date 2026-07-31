import { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

describe('HttpExceptionFilter', () => {
  it('does not reflect query strings or raw internal errors', () => {
    let responseBody: unknown;
    const json = jest.fn((body: unknown) => {
      responseBody = body;
    });
    const status = jest.fn().mockReturnValue({ json });
    const request = {
      method: 'GET',
      path: '/api/v1/members/private-id',
      url: '/api/v1/members/private-id?token=secret',
      route: { path: '/members/:id' },
      genesisRequestContext: {
        requestId: 'request-1',
        correlationId: 'correlation-1',
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    new HttpExceptionFilter().catch(
      new Error('postgres://user:secret@database/internal'),
      host,
    );

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/v1/members/private-id' }),
    );
    const response = JSON.stringify(responseBody);
    const log = stderr.mock.calls.map(([value]) => String(value)).join('');
    expect(response).not.toContain('token=secret');
    expect(response).not.toContain('postgres://');
    expect(log).not.toContain('postgres://');
    stderr.mockRestore();
  });
});
