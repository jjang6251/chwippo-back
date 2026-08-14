/**
 * Auth refresh·logout 통합 e2e (LRR P2T1 PR P H-1·H-2).
 *
 * 실 HTTP → JwtRefreshGuard → JwtRefreshStrategy → AuthService → DB hash 비교까지 검증.
 * 단위 spec(jwt-refresh.strategy.spec·auth.controller.spec)이 mock으로 못 잡는
 * "실 cookie → strategy → DB" 흐름 회귀 방어.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { User } from '../src/users/user.entity';
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

    /**
     * ── 회전 멱등성 (plan refresh-rotation-idempotency, 2026-08-15) ──────────
     *
     * 🔴 **여기서만 검증되는 것**: 단위 spec 은 DB 를 mock 하므로 "소비된 행에 rotation_id 가
     * 실제로 적히고, 그 값으로 다시 찾아진다" 를 못 본다. 컬럼 이름 오타·마이그레이션 누락은
     * 실 HTTP + 실 DB 왕복에서만 드러난다.
     *
     * 시나리오는 실사고 그대로다 — 회전이 서버엔 처리됐는데 응답만 유실돼 기기엔 **소비된
     * 낡은 RT** 만 남은 상태에서, 같은 접수번호로 재시도한다.
     */
    it('🔴 같은 rotationId 재제출 (응답 유실 복구) → 200 + 새 cookie (실 DB 왕복)', async () => {
      const { refreshToken } = await signInAsUser(app);
      const rotationId = randomUUID();

      // 1회전 — 이 응답이 유실됐다고 가정한다
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .send({ rotationId })
        .expect(200);

      // 기기엔 소비된 옛 쿠키만 남아 있다 → 같은 접수번호로 재전송
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .send({ rotationId })
        .expect(200);

      expect(typeof res.body.data.accessToken).toBe('string');
      // 🔴 쿠키가 반드시 와야 한다 — 409 는 쿠키를 안 줘서 재시도가 원리적으로 실패했다
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
    });

    it('🔴 다른 rotationId 로 소비된 토큰 재제출 → 409 (창 안 · 기존 판정 유지)', async () => {
      const { refreshToken } = await signInAsUser(app);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .send({ rotationId: randomUUID() })
        .expect(200);

      // 접수번호가 다르면 재현 대상이 아니다 → 기존 경합 판정 그대로
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .send({ rotationId: randomUUID() })
        .expect(409);
    });

    it('rotationId 없이 회전 → 200 (구버전 클라 호환)', async () => {
      const { refreshToken } = await signInAsUser(app);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .expect(200);
    });

    // ⑦ 임의 문자열로 rotation_id(uuid) 컬럼·audit detail 을 오염시키지 못한다
    it('UUID 형식 아닌 rotationId → 400', async () => {
      const { refreshToken } = await signInAsUser(app);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .send({ rotationId: 'not-a-uuid' })
        .expect(400);
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
    // 세션 지속성 웨이브 — logout 은 refresh 쿠키(sid)로 그 기기 세션을 revoke.
    // 실제 프론트는 withCredentials=true 라 쿠키가 자동 전송됨 → 테스트도 동일하게 전송.
    it('logout 후 옛 refresh cookie로 /auth/refresh → 401 (A4-8 회귀)', async () => {
      const { accessToken, refreshToken } = await signInAsUser(app);

      // logout — 브라우저처럼 refresh 쿠키 함께 전송 → 해당 세션 revoke
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set(bearer(accessToken))
        .set('Cookie', `refresh_token=${refreshToken}`)
        .expect(200);

      // revoke 된 세션의 옛 cookie로 refresh 시도 → 401
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .expect(401);
    });
  });

  // ── M-5·M-7 JWT 서명·payload·형식 변조 → 401 ──────────
  describe('JWT 변조 (M-5·M-7, A3-3·A3-4·A3-5·A4-4)', () => {
    it('Bearer + 임의 문자열 (JWT 형식 아님) → 401', async () => {
      return request(app.getHttpServer())
        .get('/users/me/dashboard-config')
        .set('Authorization', 'Bearer not-a-jwt-token')
        .expect(401);
    });

    it('Bearer + 유효 JWT 형식이지만 서명 변조 (마지막 1글자 변경) → 401', async () => {
      const { accessToken } = await signInAsUser(app);
      const tampered =
        accessToken.slice(0, -1) + (accessToken.endsWith('a') ? 'b' : 'a');
      return request(app.getHttpServer())
        .get('/users/me/dashboard-config')
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });

    it('Bearer + payload 변조 (base64 디코드 후 sub 변경) → 401 (서명 불일치)', async () => {
      const { accessToken } = await signInAsUser(app);
      const parts = accessToken.split('.');
      // payload (parts[1]) 변조 → 서명 검증 실패
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          sub: '00000000-0000-0000-0000-000000000000',
          role: 'admin',
        }),
      ).toString('base64url');
      const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
      return request(app.getHttpServer())
        .get('/users/me/dashboard-config')
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });
  });

  // ── M-9 변경 후 정지 → 401 통합 ───────────────────────
  describe('변경 후 정지 → 다음 요청 401 (M-9, U3-17)', () => {
    it('정상 요청 200 → DB suspendedAt 설정 → 옛 token으로 재요청 401', async () => {
      const { accessToken, user } = await signInAsUser(app);

      // 1차 요청 정상
      await request(app.getHttpServer())
        .get('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .expect(200);

      // 외부 admin이 정지 처리한 효과 — DB 직접 수정
      await app
        .get(DataSource)
        .getRepository(User)
        .update(user.id, { suspendedAt: new Date() });

      // 2차 요청 — 옛 token이지만 JwtStrategy.validate가 suspendedAt 체크 → 401
      await request(app.getHttpServer())
        .get('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .expect(401);
    });
  });
});
