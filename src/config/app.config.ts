import { registerAs } from '@nestjs/config';

export interface AppConfig {
  environment: string;
  name: string;
  version: string;
  port: number;
  frontendUrl: string;
}

export default registerAs('app', (): AppConfig => ({
  environment: process.env.NODE_ENV ?? 'development',
  name: process.env.APP_NAME as string,
  version: process.env.APP_VERSION as string,
  port: Number(process.env.PORT ?? 3000),
  frontendUrl: process.env.FRONTEND_URL as string,
}));
