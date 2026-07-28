import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AppConfig } from '../src/config/app.config';
import { WebSessionService } from '../src/modules/auth/services/web-session.service';

describe('WebSessionService', () => {
  const frontendUrl = 'https://app.example.com';

  it('uses __Host cookies with the required production attributes', () => {
    const service = createService('production');
    const response = createResponse();
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');

    const csrfToken = service.issueCsrfToken(response.value);
    service.setRefreshCookie(response.value, 'opaque-refresh', expiresAt);

    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(response.cookie).toHaveBeenNthCalledWith(
      1,
      '__Host-genesis_csrf',
      csrfToken,
      {
        httpOnly: false,
        secure: true,
        sameSite: 'lax',
        path: '/',
      },
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      2,
      '__Host-genesis_refresh',
      'opaque-refresh',
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        expires: expiresAt,
      },
    );
    expect(JSON.stringify(response.cookie.mock.calls)).not.toContain('domain');
  });

  it('uses separate non-secure cookies outside production and clears both', () => {
    const service = createService('test');
    const response = createResponse();

    service.issueCsrfToken(response.value);
    service.setRefreshCookie(response.value, 'opaque-refresh', new Date());
    service.clearAuthCookies(response.value);

    expect(response.cookie).toHaveBeenNthCalledWith(
      1,
      'genesis_csrf_dev',
      expect.any(String),
      expect.objectContaining({ secure: false, httpOnly: false }),
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      2,
      'genesis_refresh_dev',
      'opaque-refresh',
      expect.objectContaining({ secure: false, httpOnly: true }),
    );
    expect(response.clearCookie).toHaveBeenCalledWith(
      'genesis_refresh_dev',
      expect.objectContaining({ path: '/', sameSite: 'lax' }),
    );
    expect(response.clearCookie).toHaveBeenCalledWith(
      'genesis_csrf_dev',
      expect.objectContaining({ path: '/', sameSite: 'lax' }),
    );
  });

  it('accepts one matching cookie/header pair and the configured origin', () => {
    const service = createService('production');
    const token = 'a'.repeat(43);
    const request = createRequest(
      `__Host-genesis_csrf=${token}`,
      token,
      frontendUrl,
    );

    expect(() => service.assertCsrf(request)).not.toThrow();
  });

  it.each([
    ['missing cookie', undefined, 'a'.repeat(43), undefined],
    [
      'missing header',
      `genesis_csrf_dev=${'a'.repeat(43)}`,
      undefined,
      undefined,
    ],
    [
      'different values',
      `genesis_csrf_dev=${'a'.repeat(43)}`,
      'b'.repeat(43),
      undefined,
    ],
    [
      'invalid origin',
      `genesis_csrf_dev=${'a'.repeat(43)}`,
      'a'.repeat(43),
      'https://attacker.example',
    ],
    [
      'duplicate cookie',
      `genesis_csrf_dev=${'a'.repeat(43)}; genesis_csrf_dev=${'a'.repeat(43)}`,
      'a'.repeat(43),
      undefined,
    ],
  ])(
    'rejects %s with the same generic error',
    (_case, cookie, header, origin) => {
      const service = createService('test');
      const request = createRequest(cookie, header, origin);

      expect(() => service.assertCsrf(request)).toThrow(
        'CSRF validation failed.',
      );
    },
  );

  function createService(environment: AppConfig['environment']) {
    return new WebSessionService({
      getOrThrow: jest.fn().mockReturnValue({
        environment,
        frontendUrl,
      } satisfies Partial<AppConfig>),
    } as unknown as ConfigService);
  }

  function createResponse() {
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    return {
      cookie,
      clearCookie,
      value: { cookie, clearCookie } as unknown as Response,
    };
  }

  function createRequest(
    cookie: string | undefined,
    csrfHeader: string | undefined,
    origin: string | undefined,
  ): Request {
    const headers: Record<string, string | undefined> = {
      cookie,
      'x-csrf-token': csrfHeader,
      origin,
    };
    return {
      headers: { cookie },
      get: (name: string) => headers[name.toLowerCase()],
    } as unknown as Request;
  }
});
