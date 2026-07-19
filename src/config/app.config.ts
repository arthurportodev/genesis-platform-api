import { registerAs } from '@nestjs/config';

export interface AppConfig {
  environment: string;
  name: string;
  version: string;
  port: number;
  frontendUrl: string;
  trustProxyHops: number;
}

export default registerAs('app', (): AppConfig => ({
  environment: process.env.NODE_ENV ?? 'development',
  name: process.env.APP_NAME as string,
  version: process.env.APP_VERSION as string,
  port: Number(process.env.PORT ?? 3000),
  frontendUrl: process.env.FRONTEND_URL as string,
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),
}));
