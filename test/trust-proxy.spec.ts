import { Controller, Get, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Request } from 'express';
import request from 'supertest';
import { configureTrustProxy } from '../src/config/trust-proxy';

@Controller()
class ClientIpController {
  @Get('client-ip')
  getClientIp(@Req() incomingRequest: Request): { ip: string | undefined } {
    return { ip: incomingRequest.ip };
  }
}

describe('Trust proxy configuration', () => {
  it('does not trust a spoofed X-Forwarded-For header by default', async () => {
    const app = await createApp(0);
    const response = await request(app.getHttpServer())
      .get('/client-ip')
      .set('X-Forwarded-For', '203.0.113.10')
      .expect(200);

    const body: unknown = response.body;
    expect(body).not.toEqual({ ip: '203.0.113.10' });
    await app.close();
  });

  it('uses the forwarded client address behind one trusted proxy hop', async () => {
    const app = await createApp(1);
    const response = await request(app.getHttpServer())
      .get('/client-ip')
      .set('X-Forwarded-For', '203.0.113.11')
      .expect(200);

    const body: unknown = response.body;
    expect(body).toEqual({ ip: '203.0.113.11' });
    await app.close();
  });

  async function createApp(hops: number): Promise<NestExpressApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [ClientIpController],
    }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(app, hops);
    await app.init();
    return app;
  }
});
