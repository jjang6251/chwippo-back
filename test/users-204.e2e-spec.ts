/**
 * Users 204 응답 shape e2e (LRR P2T1 PR P H-17).
 *
 * `@HttpCode(204)` 라우트가 ResponseTransformInterceptor에 의해
 * 빈 body로 응답되는지 회귀 검증. interceptor가 빈 data wrap하지 않고
 * Express의 204 (no body) 동작을 보존하는지.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Users 204 응답 shape (e2e, H-17)', () => {
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

  it('POST /users/me/terms → 204 + body 빈 응답', async () => {
    const { accessToken } = await signInAsUser(app);

    const res = await request(app.getHttpServer())
      .post('/users/me/terms')
      .set(bearer(accessToken))
      .expect(204);

    // 204 No Content — body는 비어있어야 함 (interceptor가 빈 data wrap 안 함)
    expect(res.body).toEqual({});
    expect(res.text).toBe('');
  });

  it('POST /users/me/onboard → 204 + body 빈 응답', async () => {
    const { accessToken } = await signInAsUser(app);

    const res = await request(app.getHttpServer())
      .post('/users/me/onboard')
      .set(bearer(accessToken))
      .expect(204);

    expect(res.body).toEqual({});
    expect(res.text).toBe('');
  });
});
