import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

describe('AppModule', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';
    process.env.APP_NAME = 'Genesis Platform API';
    process.env.APP_VERSION = '0.1.0';
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = '5432';
    process.env.DATABASE_NAME = 'genesis_platform_test';
    process.env.DATABASE_USER = 'genesis';
    process.env.DATABASE_PASSWORD = 'test-only';
    process.env.FRONTEND_URL = 'http://localhost:5173';
  });

  it('initializes the main module', async () => {
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue({
        entityMetadatas: [],
        getRepository: jest.fn(),
        options: { type: 'postgres' },
        query: jest.fn(),
      })
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
