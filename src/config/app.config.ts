import { registerAs } from '@nestjs/config';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export const WEB_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-CSRF-Token',
  'X-Organization-Id',
  'If-Match',
  'Idempotency-Key',
] as const;

export const WEB_EXPOSED_HEADERS = [
  'ETag',
  'Location',
  'Idempotency-Replayed',
  'Retry-After',
] as const;

const TENANT_SCOPED_PATH_PREFIXES = [
  '/api/v1/invitations',
  '/api/v1/leads',
  '/api/v1/members',
] as const;

export function buildWebCorsOptions(frontendUrl: string): CorsOptions {
  return {
    origin: frontendUrl,
    credentials: true,
    allowedHeaders: [...WEB_ALLOWED_HEADERS],
    exposedHeaders: [...WEB_EXPOSED_HEADERS],
  };
}

export function isSensitiveWebResponse(
  path: string,
  organizationHeader: string | undefined,
): boolean {
  return (
    path.startsWith('/api/v1/auth') ||
    organizationHeader !== undefined ||
    TENANT_SCOPED_PATH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}

export interface AppConfig {
  environment: string;
  name: string;
  version: string;
  port: number;
  frontendUrl: string;
  trustProxyHops: number;
  publicReplicaCount: number;
}

export function resolveApiPublicReplicaCount(): number {
  const canonical = process.env.API_PUBLIC_REPLICA_COUNT?.trim();
  const legacy = process.env.INVITATION_PUBLIC_REPLICA_COUNT?.trim();
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    throw new Error(
      'API_PUBLIC_REPLICA_COUNT conflicts with INVITATION_PUBLIC_REPLICA_COUNT.',
    );
  }
  return Number(canonical ?? legacy ?? 1);
}

export default registerAs('app', (): AppConfig => ({
  environment: process.env.NODE_ENV ?? 'development',
  name: process.env.APP_NAME as string,
  version: process.env.APP_VERSION as string,
  port: Number(process.env.PORT ?? 3000),
  frontendUrl: process.env.FRONTEND_URL as string,
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),
  publicReplicaCount: resolveApiPublicReplicaCount(),
}));
