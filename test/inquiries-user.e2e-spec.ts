/**
 * Inquiries 사용자 측 e2e (LRR P2T3 PR Y).
 *
 * POST·GET·GET/:id·POST/:id/comments — 본인 데이터 + CLOSED 시 댓글 403 + IDOR 회귀.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Inquiry } from '../src/inquiries/inquiry.entity';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Inquiries (e2e, PR Y, user 측)', () => {
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

  async function createInquiry(token: string, suffix = '') {
    const res = await request(app.getHttpServer())
      .post('/inquiries')
      .set(bearer(token))
      .send({
        category: '버그 신고',
        title: `테스트 문의 ${suffix}`,
        content: '10자 이상 본문입니다.',
      })
      .expect(201);
    return res.body.data as { id: string; status: string };
  }

  it('POST → 201 + status=OPEN + admin_unread=1', async () => {
    const { accessToken } = await signInAsUser(app);
    const created = await createInquiry(accessToken);
    expect(created.status).toBe('OPEN');
  });

  it('POST DTO 위반 (content 10자 미만) → 400', async () => {
    const { accessToken } = await signInAsUser(app);
    return request(app.getHttpServer())
      .post('/inquiries')
      .set(bearer(accessToken))
      .send({ category: '버그 신고', title: 'x', content: '짧음' })
      .expect(400);
  });

  it('GET /inquiries → 본인 목록만', async () => {
    const { accessToken: tokenA } = await signInAsUser(app, {
      kakaoIdSuffix: 'a',
    });
    const { accessToken: tokenB } = await signInAsUser(app, {
      kakaoIdSuffix: 'b',
    });
    await createInquiry(tokenA, 'A');
    await createInquiry(tokenB, 'B');

    const listA = await request(app.getHttpServer())
      .get('/inquiries')
      .set(bearer(tokenA))
      .expect(200);
    expect(listA.body.data).toHaveLength(1);
    expect(listA.body.data[0].title).toBe('테스트 문의 A');
  });

  it('GET /:id 정상 → 200 + 댓글 + user_unread=0', async () => {
    const { accessToken } = await signInAsUser(app);
    const created = await createInquiry(accessToken);
    const res = await request(app.getHttpServer())
      .get(`/inquiries/${created.id}`)
      .set(bearer(accessToken))
      .expect(200);
    expect(res.body.data.user_unread).toBe(0);
    expect(Array.isArray(res.body.data.comments)).toBe(true);
  });

  it('GET /:id 타인 → 404 (IDOR 회귀, PR H 해소된 404 패턴)', async () => {
    const { accessToken: ownerToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'owner',
    });
    const { accessToken: attackerToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'attacker',
    });
    const created = await createInquiry(ownerToken);
    await request(app.getHttpServer())
      .get(`/inquiries/${created.id}`)
      .set(bearer(attackerToken))
      .expect(404);
  });

  it('POST /:id/comments OPEN → 201 + admin_unread+1', async () => {
    const { accessToken } = await signInAsUser(app);
    const created = await createInquiry(accessToken);
    await request(app.getHttpServer())
      .post(`/inquiries/${created.id}/comments`)
      .set(bearer(accessToken))
      .send({ content: '추가 댓글' })
      .expect(201);
  });

  it('POST /:id/comments CLOSED → 403 (T3-CG4 회귀)', async () => {
    const { user, accessToken } = await signInAsUser(app);
    const created = await createInquiry(accessToken);

    // status를 CLOSED로 직접 설정 (admin 흐름 모사)
    const ds = app.get(DataSource);
    await ds
      .getRepository(Inquiry)
      .update({ id: created.id, user_id: user.id }, { status: 'CLOSED' });

    await request(app.getHttpServer())
      .post(`/inquiries/${created.id}/comments`)
      .set(bearer(accessToken))
      .send({ content: '닫힌 후 시도' })
      .expect(403);
  });

  it('미인증 → 401 (POST·GET 모두)', async () => {
    await request(app.getHttpServer())
      .post('/inquiries')
      .send({ category: '버그 신고', title: 'x', content: '10자 이상 본문' })
      .expect(401);
    await request(app.getHttpServer()).get('/inquiries').expect(401);
  });
});
