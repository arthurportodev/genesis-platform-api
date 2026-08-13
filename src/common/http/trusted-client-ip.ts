import { isIP } from 'node:net';
import { NextFunction, Request, Response } from 'express';

const TRUSTED_CLIENT_IP = Symbol('genesis.trusted-client-ip');

const INTERNAL_AND_FORWARDING_HEADERS = new Set([
  'cf-connecting-ip',
  'client-ip',
  'fastly-client-ip',
  'fly-client-ip',
  'forwarded',
  'true-client-ip',
  'via',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-envoy-external-address',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-forwarded-server',
  'x-original-forwarded-for',
  'x-proxyuser-ip',
  'x-real-ip',
  'x-genesis-client-ip',
  'x-genesis-origin-key',
  'x-genesis-proxy-attested',
]);

type RequestWithTrustedClientIp = Request & {
  [TRUSTED_CLIENT_IP]?: string;
};

function hasUnsafeAscii(value: string, includeSpace: boolean): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127 || code < (includeSpace ? 33 : 32)) return true;
  }
  return false;
}

function canonicalizeIpv4(value: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const canonical: string[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    canonical.push(String(octet));
  }
  return canonical.join('.');
}

function canonicalizeIpv6(value: string): string | null {
  const mappedIpv4 = value.match(/^::ffff:(.+)$/iu)?.[1];
  if (mappedIpv4) {
    const canonicalIpv4 = canonicalizeIpv4(mappedIpv4);
    return canonicalIpv4 ? `::ffff:${canonicalIpv4}` : null;
  }
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

export function canonicalizeClientIp(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > 45 ||
    value !== value.trim() ||
    value.includes(',') ||
    value.includes('%') ||
    hasUnsafeAscii(value, true)
  ) {
    return null;
  }
  const version = isIP(value);
  if (version === 4) return canonicalizeIpv4(value);
  if (version === 6) return canonicalizeIpv6(value);
  return null;
}

function rawHeaderValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function redactInternalHeaders(request: Request): void {
  for (const name of Object.keys(request.headers)) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith('x-genesis-') ||
      INTERNAL_AND_FORWARDING_HEADERS.has(lower)
    ) {
      delete request.headers[name];
    }
  }
  const redacted: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index] ?? '';
    const lower = name.toLowerCase();
    if (
      lower.startsWith('x-genesis-') ||
      INTERNAL_AND_FORWARDING_HEADERS.has(lower)
    ) {
      continue;
    }
    redacted.push(name, request.rawHeaders[index + 1] ?? '');
  }
  request.rawHeaders.splice(0, request.rawHeaders.length, ...redacted);
}

export function createTrustedWebProxyMiddleware(
  enabled: boolean,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    if (
      !enabled ||
      (request.path !== '/api/v1' && !request.path.startsWith('/api/v1/'))
    ) {
      next();
      return;
    }

    const attestationValues = rawHeaderValues(
      request,
      'x-genesis-proxy-attested',
    );
    const clientIpValues = rawHeaderValues(request, 'x-genesis-client-ip');
    const leakedKeyValues = rawHeaderValues(request, 'x-genesis-origin-key');
    const canonical =
      clientIpValues.length === 1
        ? canonicalizeClientIp(clientIpValues[0])
        : null;

    const valid =
      attestationValues.length === 1 &&
      attestationValues[0] === 'v1' &&
      clientIpValues.length === 1 &&
      canonical !== null &&
      canonical === clientIpValues[0] &&
      leakedKeyValues.length === 0;

    redactInternalHeaders(request);
    if (!valid) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(403).json({
        statusCode: 403,
        message: 'Request provenance validation failed.',
      });
      return;
    }

    (request as RequestWithTrustedClientIp)[TRUSTED_CLIENT_IP] = canonical;
    next();
  };
}

export function getTrustedClientIp(request: Request): string | null {
  const trusted = (request as RequestWithTrustedClientIp)[TRUSTED_CLIENT_IP];
  if (trusted) return trusted;
  const fallback = request.ip || request.socket.remoteAddress;
  return fallback ? canonicalizeClientIp(fallback) : null;
}
