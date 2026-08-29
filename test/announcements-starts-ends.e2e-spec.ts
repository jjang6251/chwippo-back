/**
 * Announcements starts/ends 논리 검증 e2e (LRR P2T3 PR X — MED-T3-1).
 *
 * starts_at > ends_at 입력 시 service에서 400. create/update 모두 차단.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Announcement } from '../src/announcements/announcement.entity';
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
    await app
      .get(DataSource)
      .getRepository(Announcement)
      .createQueryBuilder()
      .delete()
      .execute();
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

  /**
   * 창(starts/ends) 판정은 실 DB 질의라 mock 으로는 검증이 안 된다 — 여기서만 확인한다.
   * 상대 시각으로 만들어 날짜가 지나도 썩지 않게 한다.
   */
  describe('GET /announcements/active 창 판정', () => {
    const dayFromNow = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString();

    const activeList = async () => {
      const res = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      return res.body.data as { id: string }[];
    };

    it('ends_at 이 과거면 active=true 여도 제외', async () => {
      const { accessToken } = await signInAsAdmin(app);
      await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          ...baseBody,
          starts_at: dayFromNow(-10),
          ends_at: dayFromNow(-1),
        })
        .expect(201);

      expect(await activeList()).toEqual([]);
    });

    it('starts_at 이 미래면 아직 제외', async () => {
      const { accessToken } = await signInAsAdmin(app);
      await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({ ...baseBody, starts_at: dayFromNow(1) })
        .expect(201);

      expect(await activeList()).toEqual([]);
    });

    it('창 안(과거 시작·미래 종료)이면 포함', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const created = await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          ...baseBody,
          starts_at: dayFromNow(-1),
          ends_at: dayFromNow(1),
        })
        .expect(201);

      const list = await activeList();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(created.body.data.id);
    });

    it('창 밖 배너 + 창 안 모달 → 모달만', async () => {
      const { accessToken } = await signInAsAdmin(app);
      await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({ ...baseBody, ends_at: dayFromNow(-1) })
        .expect(201);
      const modal = await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({ ...baseBody, type: 'modal', starts_at: dayFromNow(-1) })
        .expect(201);

      const list = await activeList();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(modal.body.data.id);
    });
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
