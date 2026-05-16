import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import helmet from 'helmet';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('App (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // prod main.ts와 같은 helmet·x-powered-by 설정 적용
    const expressApp =
      moduleFixture.createNestApplication<NestExpressApplication>();
    expressApp.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        crossOriginEmbedderPolicy: false,
      }),
    );
    expressApp.disable('x-powered-by');
    app = expressApp;
    await app.init();
  });

  it('/health (GET) 200', () => {
    return request(app.getHttpServer()).get('/health').expect(200);
  });

  describe('보안 헤더 (Helmet)', () => {
    it('x-powered-by 헤더 부재 (Express signature 제거)', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('x-content-type-options: nosniff', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('x-frame-options 존재 (Clickjacking 방어)', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['x-frame-options']).toBeDefined();
    });

    it('referrer-policy 존재', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['referrer-policy']).toBeDefined();
    });
  });

  afterEach(async () => {
    await app.close();
  });
});
