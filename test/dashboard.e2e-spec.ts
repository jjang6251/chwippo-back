/**
 * Dashboard e2e (LRR P2T3 PR Y).
 *
 * stats·dday·interview-review 3 라우트 — 본인 데이터 + 미인증·타인 격리.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Application } from '../src/applications/application.entity';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Dashboard (e2e, PR Y)', () => {
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

  describe('GET /dashboard/stats', () => {
    it('0건 사용자 → 모두 0', async () => {
      const { accessToken } = await signInAsUser(app);
      const res = await request(app.getHttpServer())
        .get('/dashboard/stats')
        .set(bearer(accessToken))
        .expect(200);
      expect(res.body.data).toMatchObject({
        total: 0,
        inProgress: 0,
        passed: 0,
        interviewsAttended: 0,
      });
    });

    it('미인증 → 401', async () => {
      return request(app.getHttpServer()).get('/dashboard/stats').expect(401);
    });

    it('IN_PROGRESS·PASSED·FAILED 카드 카운트', async () => {
      const { user, accessToken } = await signInAsUser(app);
      const repo = app.get(DataSource).getRepository(Application);
      for (const status of ['IN_PROGRESS', 'PASSED', 'FAILED'] as const) {
        await repo.save(
          repo.create({ userId: user.id, companyName: `${status} 사`, status }),
        );
      }
      const res = await request(app.getHttpServer())
        .get('/dashboard/stats')
        .set(bearer(accessToken))
        .expect(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.inProgress).toBe(1);
      expect(res.body.data.passed).toBe(1);
    });
  });

  describe('GET /dashboard/dday', () => {
    it('0건 → 빈 배열', async () => {
      const { accessToken } = await signInAsUser(app);
      const res = await request(app.getHttpServer())
        .get('/dashboard/dday')
        .set(bearer(accessToken))
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('미인증 → 401', async () => {
      return request(app.getHttpServer()).get('/dashboard/dday').expect(401);
    });
  });

  describe('GET /dashboard/interview-review', () => {
    it('정상 0건', async () => {
      const { accessToken } = await signInAsUser(app);
      const res = await request(app.getHttpServer())
        .get('/dashboard/interview-review')
        .set(bearer(accessToken))
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('미인증 → 401', async () => {
      return request(app.getHttpServer())
        .get('/dashboard/interview-review')
        .expect(401);
    });
  });
});
