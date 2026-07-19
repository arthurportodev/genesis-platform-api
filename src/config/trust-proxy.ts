import { NestExpressApplication } from '@nestjs/platform-express';

export function configureTrustProxy(
  app: NestExpressApplication,
  hops: number,
): void {
  app.set('trust proxy', hops);
}
