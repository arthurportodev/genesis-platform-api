import { Request, Response } from 'express';
import {
  canonicalizeClientIp,
  createTrustedWebProxyMiddleware,
  getTrustedClientIp,
} from '../src/common/http/trusted-client-ip';

function requestWithHeaders(
  headers: Array<[string, string]>,
  path = '/api/v1/auth/bootstrap',
): Request {
  const rawHeaders = headers.flat();
  const normalized = Object.fromEntries(
    headers.map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    path,
    rawHeaders,
    headers: normalized,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

function responseRecorder(): {
  response: Response;
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  return {
    response: { status, setHeader } as unknown as Response,
    status,
    json,
    setHeader,
  };
}

describe('trusted web proxy client IP', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['2001:db8::1', '2001:db8::1'],
    ['2001:0db8:0:0:0:0:0:1', '2001:db8::1'],
    ['::ffff:192.0.2.1', '::ffff:192.0.2.1'],
  ])('canonicalizes %s', (input, expected) => {
    expect(canonicalizeClientIp(input)).toBe(expected);
  });

  it.each([
    '',
    ' 203.0.113.9',
    '203.0.113.9, 198.51.100.1',
    '203.000.113.9',
    '2001:db8::1%eth0',
    '[2001:db8::1]',
    'invalid',
  ])('rejects non-canonical or unsafe input %s', (input) => {
    expect(canonicalizeClientIp(input)).toBeNull();
  });

  it('accepts exactly one attested canonical value and redacts internal headers', () => {
    const request = requestWithHeaders([
      ['X-Genesis-Proxy-Attested', 'v1'],
      ['X-Genesis-Client-IP', '203.0.113.9'],
      ['X-Forwarded-For', '198.51.100.99'],
      ['CF-Connecting-IP', '198.51.100.98'],
      ['True-Client-IP', '198.51.100.97'],
      ['Fastly-Client-IP', '198.51.100.96'],
      ['Fly-Client-IP', '198.51.100.95'],
      ['X-Client-IP', '198.51.100.94'],
      ['X-Envoy-External-Address', '198.51.100.93'],
      ['Authorization', 'Bearer synthetic'],
    ]);
    const { response } = responseRecorder();
    const next = jest.fn();

    createTrustedWebProxyMiddleware(true)(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getTrustedClientIp(request)).toBe('203.0.113.9');
    expect(request.headers).toEqual({ authorization: 'Bearer synthetic' });
    expect(request.rawHeaders).toEqual(['Authorization', 'Bearer synthetic']);
  });

  it.each([
    { headers: [['X-Genesis-Client-IP', '203.0.113.9']] },
    {
      headers: [
        ['X-Genesis-Proxy-Attested', 'v1'],
        ['X-Genesis-Client-IP', '203.0.113.9'],
        ['X-Genesis-Client-IP', '198.51.100.1'],
      ],
    },
    {
      headers: [
        ['X-Genesis-Proxy-Attested', 'v1'],
        ['X-Genesis-Client-IP', '2001:0db8::1'],
      ],
    },
    {
      headers: [
        ['X-Genesis-Proxy-Attested', 'v1'],
        ['X-Genesis-Client-IP', '203.0.113.9'],
        ['X-Genesis-Origin-Key', 'must-never-reach-nest'],
      ],
    },
  ] as Array<{ headers: Array<[string, string]> }>)(
    'fails closed for invalid provenance %#',
    ({ headers }) => {
      const request = requestWithHeaders(headers);
      const { response, status, json, setHeader } = responseRecorder();
      const next = jest.fn();

      createTrustedWebProxyMiddleware(true)(request, response, next);

      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(403);
      expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(json).toHaveBeenCalledWith({
        statusCode: 403,
        message: 'Request provenance validation failed.',
      });
      expect(request.rawHeaders.join(' ')).not.toMatch(/x-genesis/i);
    },
  );

  it('leaves health and disabled local mode unchanged', () => {
    const request = requestWithHeaders([], '/health');
    const { response } = responseRecorder();
    const next = jest.fn();
    createTrustedWebProxyMiddleware(true)(request, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getTrustedClientIp(request)).toBe('127.0.0.1');
  });
});
