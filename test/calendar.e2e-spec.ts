/**
 * Calendar e2e (LRR P2T3 PR Y).
 *
 * events·daily-notes CRUD + carry-over — 본인 데이터 + IDOR 회귀 (PR H 해소된 404 패턴).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { DailyNote } from '../src/calendar/daily-note.entity';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Calendar (e2e, PR Y)', () => {
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

  describe('GET /calendar/events', () => {
    it('정상 (year·month) → 200 + 빈 배열', async () => {
      const { accessToken } = await signInAsUser(app);
      const res = await request(app.getHttpServer())
        .get('/calendar/events?year=2026&month=6')
        .set(bearer(accessToken))
        .expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('year 문자열 → 400 (ParseIntPipe)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .get('/calendar/events?year=abc&month=6')
        .set(bearer(accessToken))
        .expect(400);
    });

    it('미인증 → 401', async () => {
      return request(app.getHttpServer())
        .get('/calendar/events?year=2026&month=6')
        .expect(401);
    });
  });

  describe('GET·POST·PATCH·DELETE /calendar/daily-notes', () => {
    it('POST 정상 → 201 + GET으로 조회', async () => {
      const { accessToken } = await signInAsUser(app);
      const created = await request(app.getHttpServer())
        .post('/calendar/daily-notes')
        .set(bearer(accessToken))
        .send({ date: '2026-06-10', content: '면접 준비' })
        .expect(201);
      expect(created.body.data.content).toBe('면접 준비');

      const list = await request(app.getHttpServer())
        .get('/calendar/daily-notes?date=2026-06-10')
        .set(bearer(accessToken))
        .expect(200);
      expect(list.body.data).toHaveLength(1);
    });

    it('POST 잘못된 date 형식 → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/calendar/daily-notes')
        .set(bearer(accessToken))
        .send({ date: '2026/06/10', content: 'x' })
        .expect(400);
    });

    it('PATCH /:id 정상 + IDOR 회귀 (타인 id → 404)', async () => {
      const { user, accessToken } = await signInAsUser(app);
      const created = await request(app.getHttpServer())
        .post('/calendar/daily-notes')
        .set(bearer(accessToken))
        .send({ date: '2026-06-11', content: '원본' })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/calendar/daily-notes/${id}`)
        .set(bearer(accessToken))
        .send({ content: '수정' })
        .expect(200);

      // 타인 사용자
      const { accessToken: otherToken } = await signInAsUser(app, {
        kakaoIdSuffix: 'other',
      });
      await request(app.getHttpServer())
        .patch(`/calendar/daily-notes/${id}`)
        .set(bearer(otherToken))
        .send({ content: 'hijack' })
        .expect(404);

      // DB로 직접 검증 — 본인 content는 '수정'
      const ds = app.get(DataSource);
      const note = await ds.getRepository(DailyNote).findOneBy({ id });
      expect(note?.content).toBe('수정');
      expect(note?.userId).toBe(user.id);
    });

    it('DELETE /:id 정상 → 200', async () => {
      const { accessToken } = await signInAsUser(app);
      const created = await request(app.getHttpServer())
        .post('/calendar/daily-notes')
        .set(bearer(accessToken))
        .send({ date: '2026-06-12', content: '삭제 대상' })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/calendar/daily-notes/${created.body.data.id}`)
        .set(bearer(accessToken))
        .expect(200);
    });

    it('PATCH /:id/carry-over → 본인 OK + 타인 → 404', async () => {
      const { accessToken } = await signInAsUser(app);
      const created = await request(app.getHttpServer())
        .post('/calendar/daily-notes')
        .set(bearer(accessToken))
        .send({ date: '2026-06-10', content: '이월' })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/calendar/daily-notes/${created.body.data.id}/carry-over`)
        .set(bearer(accessToken))
        .expect(200);

      const { accessToken: otherToken } = await signInAsUser(app, {
        kakaoIdSuffix: 'other',
      });
      await request(app.getHttpServer())
        .patch(`/calendar/daily-notes/${created.body.data.id}/carry-over`)
        .set(bearer(otherToken))
        .expect(404);
    });
  });
});
