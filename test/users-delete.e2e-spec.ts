/**
 * DELETE /users/me 통합 e2e (LRR P2T1 PR Q H-6).
 *
 * cascade FK + 이후 토큰 401 회귀 검증. 파일 없는 user로 R2 호출 회피.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { User } from '../src/users/user.entity';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('DELETE /users/me (e2e, H-6)', () => {
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

  it('정상 → 204 + DB user row 삭제', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const dataSource = app.get(DataSource);
    const userRepo = dataSource.getRepository(User);

    // 사전: user 존재
    expect(await userRepo.findOneBy({ id: user.id })).not.toBeNull();

    await request(app.getHttpServer())
      .delete('/users/me')
      .set(bearer(accessToken))
      .expect(204);

    // 사후: user 삭제됨
    expect(await userRepo.findOneBy({ id: user.id })).toBeNull();
  });

  it('탈퇴 후 옛 accessToken으로 API 호출 → 401 (JwtStrategy user 조회 실패)', async () => {
    const { accessToken } = await signInAsUser(app);

    await request(app.getHttpServer())
      .delete('/users/me')
      .set(bearer(accessToken))
      .expect(204);

    // 같은 token으로 다른 API 호출
    await request(app.getHttpServer())
      .get('/users/me/dashboard-config')
      .set(bearer(accessToken))
      .expect(401);
  });

  it('미인증 → 401', () => {
    return request(app.getHttpServer()).delete('/users/me').expect(401);
  });
});
