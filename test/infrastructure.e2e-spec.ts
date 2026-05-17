/**
 * Infrastructure e2e (LRR P2T1 PR P M-26·M-27·M-28).
 *
 * main.ts의 body size·CORS·trust proxy 같은 횡단 인프라 회귀 검증.
 * 단위 spec으로는 보장 안 됨 — 실 Express 미들웨어 체인 통과 흐름.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Infrastructure (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    await cleanAllTestUsers(app);
  });

  // ── M-26 body size 256kb cap ──────────────────────────
  describe('Body size 256kb cap (M-26 INF-1·INF-2)', () => {
    it('256kb 초과 body → 413 (M-32 fix 적용 후)', async () => {
      const { accessToken } = await signInAsUser(app);

      // 약 260kb의 nickname 시도 — express bodyParser PayloadTooLargeError(status 413)
      // AllExceptionsFilter가 4xx err.status 보존하도록 PR T (M-32)에서 수정 → 정확히 413.
      const huge = 'x'.repeat(260 * 1024);

      const res = await request(app.getHttpServer())
        .patch('/users/me/nickname')
        .set(bearer(accessToken))
        .send({ nickname: huge });

      expect(res.status).toBe(413);
    });

    it('200kb body → bodyParser 통과 + DTO MaxLength로 400', async () => {
      const { accessToken } = await signInAsUser(app);

      const big = 'x'.repeat(200 * 1024);

      await request(app.getHttpServer())
        .patch('/users/me/nickname')
        .set(bearer(accessToken))
        .send({ nickname: big })
        .expect(400);
    });
  });

  // ── M-27 Content-Type 검증 ────────────────────────────
  describe('Content-Type 처리 (M-27 INF-3·INF-4·INF-5)', () => {
    it('Content-Type 미지정 + non-JSON body → DTO 검증 실패 (400)', async () => {
      const { accessToken } = await signInAsUser(app);

      // body 자체가 empty/raw text → DTO nickname 미수신 → 400
      await request(app.getHttpServer())
        .patch('/users/me/nickname')
        .set(bearer(accessToken))
        .set('Content-Type', 'text/plain')
        .send('not json text')
        .expect(400);
    });
  });

  // ── M-28 CORS origin ──────────────────────────────────
  describe('CORS 설정 (M-28 INF-6~INF-8)', () => {
    it('preflight (OPTIONS) → 204 + 설정된 origin·credentials 헤더', async () => {
      const res = await request(app.getHttpServer())
        .options('/health')
        .set('Origin', process.env.FRONTEND_URL || 'http://localhost:5173')
        .set('Access-Control-Request-Method', 'GET')
        .expect(204);

      expect(res.headers['access-control-allow-origin']).toBe(
        process.env.FRONTEND_URL || 'http://localhost:5173',
      );
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    // 주: origin이 문자열로 설정된 경우 server는 origin 무관하게 항상 설정값을 반환.
    // 실제 CORS 차단은 브라우저가 응답의 Allow-Origin vs 자신의 origin 비교로 수행.
    // 서버 단에서 origin별 차단을 검증하려면 origin을 function으로 설정해야 함.
    it('FRONTEND_URL이 string으로 설정 — 응답 Allow-Origin은 항상 설정값', async () => {
      const res = await request(app.getHttpServer())
        .options('/health')
        .set('Origin', 'https://evil.example.com')
        .set('Access-Control-Request-Method', 'GET');

      // 서버는 origin과 무관하게 설정된 FRONTEND_URL 반환 (cors 패키지 동작)
      // 브라우저는 응답의 Allow-Origin(localhost:5173) vs 자신 origin(evil.com) 다르면 차단
      expect(res.headers['access-control-allow-origin']).toBe(
        process.env.FRONTEND_URL || 'http://localhost:5173',
      );
    });
  });
});
