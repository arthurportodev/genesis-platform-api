import { registerAs } from '@nestjs/config';

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
