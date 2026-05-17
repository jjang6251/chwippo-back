/**
 * Announcements starts/ends 논리 검증 e2e (LRR P2T3 PR X — MED-T3-1).
 *
 * starts_at > ends_at 입력 시 service에서 400. create/update 모두 차단.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsAdmin } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Announcements starts/ends 논리 (e2e, PR X MED-T3-1)', () => {
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

  const baseBody = {
    title: '테스트 공지',
    body: '본문',
    type: 'banner' as const,
    active: true,
  };

  it('POST: starts_at > ends_at → 400', async () => {
    const { accessToken } = await signInAsAdmin(app);
    await request(app.getHttpServer())
      .post('/admin/announcements')
      .set(bearer(accessToken))
      .send({
        ...baseBody,
        starts_at: '2026-06-10T00:00:00Z',
        ends_at: '2026-06-01T00:00:00Z',
      })
      .expect(400);
  });

  it('POST: starts_at = ends_at → 200 (경계값, 동일 순간 허용)', async () => {
    const { accessToken } = await signInAsAdmin(app);
    const same = '2026-06-10T00:00:00Z';
    await request(app.getHttpServer())
      .post('/admin/announcements')
      .set(bearer(accessToken))
      .send({ ...baseBody, starts_at: same, ends_at: same })
      .expect(201);
  });

  it('POST: starts_at·ends_at 없음 → 201 (둘 다 NULL = 무기한)', async () => {
    const { accessToken } = await signInAsAdmin(app);
    await request(app.getHttpServer())
      .post('/admin/announcements')
      .set(bearer(accessToken))
      .send(baseBody)
      .expect(201);
  });

  it('PATCH: 기존 starts_at 유지 + ends_at만 이전으로 → 400', async () => {
    const { accessToken } = await signInAsAdmin(app);
    const created = await request(app.getHttpServer())
      .post('/admin/announcements')
      .set(bearer(accessToken))
      .send({
        ...baseBody,
        starts_at: '2026-06-10T00:00:00Z',
        ends_at: '2026-06-20T00:00:00Z',
      })
      .expect(201);
    const id: string = created.body.data.id;

    await request(app.getHttpServer())
      .patch(`/admin/announcements/${id}`)
      .set(bearer(accessToken))
      .send({ ends_at: '2026-06-01T00:00:00Z' })
      .expect(400);
  });

  it('PATCH: ends_at 만 미래로 정상 변경 → 200', async () => {
    const { accessToken } = await signInAsAdmin(app);
    const created = await request(app.getHttpServer())
      .post('/admin/announcements')
      .set(bearer(accessToken))
      .send({
        ...baseBody,
        starts_at: '2026-06-10T00:00:00Z',
        ends_at: '2026-06-20T00:00:00Z',
      })
      .expect(201);
    const id: string = created.body.data.id;

    await request(app.getHttpServer())
      .patch(`/admin/announcements/${id}`)
      .set(bearer(accessToken))
      .send({ ends_at: '2026-07-01T00:00:00Z' })
      .expect(200);
  });
});
