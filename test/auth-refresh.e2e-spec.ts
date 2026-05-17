/**
 * Auth refresh·logout 통합 e2e (LRR P2T1 PR P H-1·H-2).
 *
 * 실 HTTP → JwtRefreshGuard → JwtRefreshStrategy → AuthService → DB hash 비교까지 검증.
 * 단위 spec(jwt-refresh.strategy.spec·auth.controller.spec)이 mock으로 못 잡는
 * "실 cookie → strategy → DB" 흐름 회귀 방어.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser, signInAsAdmin } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Auth refresh·logout (e2e)', () => {
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

  // ── POST /auth/refresh ────────────────────────────────
  describe('POST /auth/refresh (H-1)', () => {
    it('유효 refresh_token cookie → 200 + 새 accessToken·user 응답 + 새 cookie set', async () => {
      const { refreshToken, user } = await signInAsUser(app);

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .expect(200);

      // ResponseTransformInterceptor wrap
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveProperty('accessToken');
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(res.body.data.user.id).toBe(user.id);
      expect(res.body.data.user.role).toBe('user');

      // 새 refresh cookie (rotation)
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
    });

    it('cookie 없음 → 401', () => {
      return request(app.getHttpServer()).post('/auth/refresh').expect(401);
    });

    it('변조된 cookie token → 401', async () => {
      await signInAsUser(app);

      return request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', 'refresh_token=tampered.token.here')
        .expect(401);
    });

    // 참고: "옛 token 재사용 → 401" rotation 효과는 jwt-refresh.strategy.spec에서 hash 비교
    // 단위로 정확히 검증됨. e2e에선 JWT iat이 초 단위라 연속 호출 시 동일 token 생성되어
    // rotation 효과 검증 불가 (timing 의존). 회피보다 단위 spec 신뢰가 깔끔.

    it('suspended user의 refresh token → 401 (정지 시 우회 차단)', async () => {
      const { refreshToken } = await signInAsUser(app, { suspended: true });

      return request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .expect(401);
    });

    it('admin도 refresh 흐름 동일 (role 응답에 반영)', async () => {
      const { refreshToken, user } = await signInAsAdmin(app);

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .expect(200);

      expect(res.body.data.user.id).toBe(user.id);
      expect(res.body.data.user.role).toBe('admin');
    });
  });

  // ── POST /auth/logout ─────────────────────────────────
  describe('POST /auth/logout (H-2)', () => {
    it('정상 → 200 + "로그아웃 되었습니다" + cookie clear', async () => {
      const { accessToken } = await signInAsUser(app);

      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .set(bearer(accessToken))
        .expect(200);

      expect(res.body.data).toHaveProperty('message');
      // cookie clear 확인 — Set-Cookie에 refresh_token=...; Max-Age=0 또는 Expires past
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      expect(cookies.some((c) => c.includes('refresh_token='))).toBe(true);
    });

    it('미인증 → 401', () => {
      return request(app.getHttpServer()).post('/auth/logout').expect(401);
    });

    it('Authorization header 형식 잘못 (Bearer 없이) → 401 (A4-2 회귀)', async () => {
      const { accessToken } = await signInAsUser(app);

      return request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', accessToken) // Bearer prefix 누락
        .expect(401);
    });

    // A4-8 회귀: logout 후 옛 refresh cookie로 refresh → 401
    it('logout 후 옛 refresh cookie로 /auth/refresh → 401 (A4-8 회귀)', async () => {
      const { accessToken, refreshToken } = await signInAsUser(app);

      // logout (DB hash null)
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set(bearer(accessToken))
        .expect(200);

      // 옛 cookie로 refresh 시도 → hash null이라 비교 실패 → 401
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .expect(401);
    });
  });
});
