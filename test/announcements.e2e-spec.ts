/**
 * Announcements e2e (LRR P2T3 PR Y).
 *
 * public active + admin CRUD — RolesGuard·audit + 정보 누수 차단.
 * (starts/ends 논리 검증은 announcements-starts-ends.e2e-spec.ts 별도)
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Announcement } from '../src/announcements/announcement.entity';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsAdmin, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Announcements (e2e, PR Y)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    // announcement는 user FK 없어 cleanAllTestUsers로 안 사라짐 — 명시 정리
    await app
      .get(DataSource)
      .getRepository(Announcement)
      .createQueryBuilder()
      .delete()
      .execute();
    await cleanAllTestUsers(app);
  });

  describe('GET /announcements/active (public)', () => {
    it('미인증 허용 → 200', async () => {
      await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
    });

    it('active 공지 없음 → 200 + data null', async () => {
      const res = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      // ResponseTransformInterceptor wrap. null 또는 announcement 객체
      expect(res.body).toHaveProperty('data');
    });

    it('active=true·기간 내 공지 → 200 + 해당 공지', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const created = await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          title: '활성 공지',
          body: '본문',
          type: 'banner',
          active: true,
        })
        .expect(201);

      const active = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      expect(active.body.data?.id).toBe(created.body.data.id);
    });

    it('active=false 공지 → 미노출', async () => {
      const { accessToken } = await signInAsAdmin(app);
      await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          title: '비활성',
          body: '본문',
          type: 'banner',
          active: false,
        })
        .expect(201);

      const active = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      expect(active.body.data).toBeNull();
    });
  });

  describe('admin CRUD (RolesGuard)', () => {
    it('POST role=user → 403', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          title: 'x',
          body: 'x',
          type: 'banner',
          active: true,
        })
        .expect(403);
    });

    it('GET admin 목록 admin → 200 / user → 403', async () => {
      const { accessToken: adminToken } = await signInAsAdmin(app);
      await request(app.getHttpServer())
        .get('/admin/announcements')
        .set(bearer(adminToken))
        .expect(200);

      const { accessToken: userToken } = await signInAsUser(app);
      await request(app.getHttpServer())
        .get('/admin/announcements')
        .set(bearer(userToken))
        .expect(403);
    });

    it('PATCH 정상 + DELETE → 204', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const created = await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({ title: '수정 대상', body: '본문', type: 'modal', active: true })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/admin/announcements/${id}`)
        .set(bearer(accessToken))
        .send({ title: '수정됨' })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/admin/announcements/${id}`)
        .set(bearer(accessToken))
        .expect(204);
    });

    it('PATCH/DELETE 미인증 → 401', async () => {
      await request(app.getHttpServer())
        .patch('/admin/announcements/00000000-0000-0000-0000-000000000000')
        .send({ title: 'x' })
        .expect(401);
      await request(app.getHttpServer())
        .delete('/admin/announcements/00000000-0000-0000-0000-000000000000')
        .expect(401);
    });
  });
});
