/**
 * GET·PATCH /users/me/dashboard-config 통합 e2e (LRR P2T1 PR Q H-7).
 *
 * DTO 검증 (IsIn·IsBoolean·ArrayMaxSize·forbidNonWhitelisted) +
 * service 비즈(stats 첫 위치 enforce·DEFAULT_SECTIONS) 전체 흐름.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Users dashboard-config (e2e, H-7)', () => {
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

  // ── GET ──────────────────────────────────────────────
  describe('GET /users/me/dashboard-config', () => {
    it('처음 호출 (DB null) → DEFAULT_SECTIONS (stats·dday·todos + W3 activity_streak·status_doughnut)', async () => {
      const { accessToken } = await signInAsUser(app);

      const res = await request(app.getHttpServer())
        .get('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .expect(200);

      expect(res.body.data.sections).toEqual([
        { id: 'stats', visible: true },
        { id: 'dday', visible: true },
        { id: 'todos', visible: true },
        { id: 'activity_streak', visible: true },
        { id: 'status_doughnut', visible: true },
      ]);
    });

    it('미인증 → 401', () => {
      return request(app.getHttpServer())
        .get('/users/me/dashboard-config')
        .expect(401);
    });
  });

  // ── PATCH ────────────────────────────────────────────
  describe('PATCH /users/me/dashboard-config', () => {
    const validSections = [
      { id: 'stats', visible: true },
      { id: 'dday', visible: true },
      { id: 'cover_letter_quick', visible: false },
    ];

    it('정상 sections → 200 + DB JSONB 저장 + GET 응답에 W3 lazy merge 자동 append', async () => {
      const { accessToken } = await signInAsUser(app);

      const res = await request(app.getHttpServer())
        .patch('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .send({ sections: validSections })
        .expect(200);

      // PATCH 응답 = 저장한 그대로 (lazy merge 안 함)
      expect(res.body.data.sections).toEqual(validSections);

      // GET으로 재확인 — W3 lazy merge 로 activity_streak/status_doughnut 자동 append
      const getRes = await request(app.getHttpServer())
        .get('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .expect(200);
      expect(getRes.body.data.sections).toEqual([
        ...validSections,
        { id: 'activity_streak', visible: true },
        { id: 'status_doughnut', visible: true },
      ]);
    });

    it('sections[0].id !== "stats" → 400 (stats 첫 위치 enforce)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .patch('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .send({
          sections: [
            { id: 'dday', visible: true },
            { id: 'stats', visible: true },
          ],
        })
        .expect(400);
    });

    it('unknown section ID → 400 (IsIn)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .patch('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .send({
          sections: [
            { id: 'stats', visible: true },
            { id: 'unknown_section', visible: true },
          ],
        })
        .expect(400);
    });

    it('visible boolean 아님 → 400 (IsBoolean)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .patch('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .send({
          sections: [{ id: 'stats', visible: 'true' }],
        })
        .expect(400);
    });

    it('sections 21개 → 400 (ArrayMaxSize 20 — LRR PR K L-7)', async () => {
      const { accessToken } = await signInAsUser(app);
      const tooMany = Array.from({ length: 21 }, () => ({
        id: 'stats',
        visible: true,
      }));
      return request(app.getHttpServer())
        .patch('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .send({ sections: tooMany })
        .expect(400);
    });

    it('sections[*]에 unknown 필드 → 400 (forbidNonWhitelisted nested)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .patch('/users/me/dashboard-config')
        .set(bearer(accessToken))
        .send({
          sections: [{ id: 'stats', visible: true, order: 1 }],
        })
        .expect(400);
    });

    it('미인증 → 401', () => {
      return request(app.getHttpServer())
        .patch('/users/me/dashboard-config')
        .send({ sections: validSections })
        .expect(401);
    });
  });
});
