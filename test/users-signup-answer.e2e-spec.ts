/**
 * POST /users/me/signup-answer — **온보딩 답변 선점**의 실 DB 검증.
 *
 * 「이미 답변했나」 판정이 사전 조회에서 **UPDATE 의 WHERE** 로 내려갔다
 * (`users.service.ts` `claimSignupAnswer`). 그 조건은 SQL 이라 목으로는 원리적으로
 * 검증되지 않는다 — 유닛 spec 이 확인하는 건 「0행이면 400」이고, 정작 「진짜로 0행이
 * 나오는가」는 실 Postgres 만 답할 수 있다.
 *
 * ## 시나리오 (먼저 나열하고 코드를 짰다)
 *  1. 첫 답변 → 204 · 컬럼 기록 · 담은 회사만큼 PLANNED 카드
 *  2. 🔴 같은 사용자가 다시 → 400 「이미 답변하셨어요.」 · **카드가 안 늘어난다**
 *  3. 🔴 동시 2건 → 하나만 204, 나머지는 400 · 카드는 한 벌뿐 (더블 탭·재전송)
 *  4. 건너뛰기(빈 답변)도 「답변 완료」라 두 번째는 400
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';
import { User } from '../src/users/user.entity';
import { Application } from '../src/applications/application.entity';

describe('POST /users/me/signup-answer (e2e)', () => {
  let app: INestApplication<App>;

  const post = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/users/me/signup-answer')
      .set(bearer(token))
      .send(body);

  const readUser = async (id: string) => {
    const found = await app
      .get(DataSource)
      .getRepository(User)
      .findOneBy({ id });
    if (!found) throw new Error(`user ${id} 가 사라졌다`);
    return found;
  };

  const countCards = (userId: string) =>
    app.get(DataSource).getRepository(Application).countBy({ userId });

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

  it('1) 첫 답변 → 204 · 컬럼 기록 · 담은 회사만큼 PLANNED 카드', async () => {
    const { accessToken, user } = await signInAsUser(app);

    await post(accessToken, {
      jobCategories: [],
      seriesId: 'it',
      jobTitle: '백엔드 개발자',
      pickedCompanies: ['네이버', '카카오'],
    }).expect(204);

    const after = await readUser(user.id);
    expect(after.signupJobCategories).toEqual([]);
    expect(after.signupSeriesId).toBe('it');
    expect(after.signupJobTitle).toBe('백엔드 개발자');
    expect(after.onboardedAt).toBeInstanceOf(Date);
    expect(await countCards(user.id)).toBe(2);
  });

  it('2) 🔴 두 번째 답변 → 400 · 카드가 안 늘어난다', async () => {
    const { accessToken, user } = await signInAsUser(app);

    await post(accessToken, {
      jobCategories: [],
      seriesId: 'it',
      pickedCompanies: ['네이버'],
    }).expect(204);

    const res = await post(accessToken, {
      jobCategories: [],
      seriesId: 'it',
      pickedCompanies: ['카카오'],
    }).expect(400);
    expect(JSON.stringify(res.body)).toContain('이미 답변하셨어요.');

    expect(await countCards(user.id)).toBe(1);
  });

  /**
   * 🔴 이 테스트가 이 파일의 존재 이유다 — 사전 조회 시절엔 **둘 다 통과**해 카드가 두 벌
   * 생겼다. 읽기·쓰기 사이의 창이 UPDATE 안으로 접혔는지는 실 DB 에서만 드러난다.
   */
  it('3) 🔴 동시 2건 → 하나만 204 · 카드는 한 벌뿐', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const body = {
      jobCategories: [],
      seriesId: 'it',
      pickedCompanies: ['네이버', '카카오'],
    };

    const results = await Promise.all([
      post(accessToken, body),
      post(accessToken, body),
    ]);

    const codes = results.map((r) => r.status).sort((a, b) => a - b);
    expect(codes).toEqual([204, 400]);
    expect(await countCards(user.id)).toBe(2);
  });

  it('4) 건너뛰기도 답변 완료 — 두 번째는 400 · 카드 0', async () => {
    const { accessToken, user } = await signInAsUser(app);

    await post(accessToken, { jobCategories: [] }).expect(204);
    await post(accessToken, { jobCategories: [] }).expect(400);

    expect(await countCards(user.id)).toBe(0);
    expect((await readUser(user.id)).onboardedAt).toBeInstanceOf(Date);
  });
});
