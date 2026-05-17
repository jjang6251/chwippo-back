import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';

describe('App (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
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

  describe('응답 wrapping (ResponseTransformInterceptor)', () => {
    it('health 응답이 { data, message } 형태로 wrap됨', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('message', 'ok');
      expect(res.body.data).toHaveProperty('status', 'ok');
    });
  });
});
