/**
 * PATCH /users/me/nickname 통합 e2e (LRR P2T1 PR Q H-5).
 *
 * UpdateNicknameDto 검증 + service 흐름 + DB 갱신·응답 shape 회귀.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('PATCH /users/me/nickname (e2e, H-5)', () => {
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

  it('정상 nickname → 200 + DB 갱신 + { nickname } 응답', async () => {
    const { accessToken } = await signInAsUser(app, { nickname: '원래닉네임' });

    const res = await request(app.getHttpServer())
      .patch('/users/me/nickname')
      .set(bearer(accessToken))
      .send({ nickname: '새닉네임' })
      .expect(200);

    expect(res.body.data).toEqual({ nickname: '새닉네임' });
  });

  it('미인증 → 401', () => {
    return request(app.getHttpServer())
      .patch('/users/me/nickname')
      .send({ nickname: 'x' })
      .expect(401);
  });

  it('빈 nickname → 400 (MinLength)', async () => {
    const { accessToken } = await signInAsUser(app);
    return request(app.getHttpServer())
      .patch('/users/me/nickname')
      .set(bearer(accessToken))
      .send({ nickname: '' })
      .expect(400);
  });

  it('21자 nickname → 400 (MaxLength 20)', async () => {
    const { accessToken } = await signInAsUser(app);
    return request(app.getHttpServer())
      .patch('/users/me/nickname')
      .set(bearer(accessToken))
      .send({ nickname: 'a'.repeat(21) })
      .expect(400);
  });

  it('nickname 미전송 → 400', async () => {
    const { accessToken } = await signInAsUser(app);
    return request(app.getHttpServer())
      .patch('/users/me/nickname')
      .set(bearer(accessToken))
      .send({})
      .expect(400);
  });

  it('unknown 필드 → 400 (forbidNonWhitelisted)', async () => {
    const { accessToken } = await signInAsUser(app);
    return request(app.getHttpServer())
      .patch('/users/me/nickname')
      .set(bearer(accessToken))
      .send({ nickname: 'ok', isAdmin: true })
      .expect(400);
  });

  it('이모지 nickname → 200 (UTF-8 통과)', async () => {
    const { accessToken } = await signInAsUser(app);
    return request(app.getHttpServer())
      .patch('/users/me/nickname')
      .set(bearer(accessToken))
      .send({ nickname: '취준생👨‍💻' })
      .expect(200);
  });
});
