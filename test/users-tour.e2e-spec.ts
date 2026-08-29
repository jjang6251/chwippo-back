/**
 * POST /users/me/tour 통합 e2e (`plans/app-tour.md`).
 *
 * 앱 소개 투어가 **끝나는 순간 한 번** 오는 기록이라, DTO 검증 → 서비스 규칙 → DB 반영까지를
 * 실 요청으로 태운다. 특히 세 가지가 눈으로는 절대 안 잡힌다:
 *
 * - `tour_seen_at` 이 **첫 기록만 유지**되는가 (덮어쓰면 코호트가 사라진다)
 * - `tour_last_step` 은 반대로 **최신값**인가 (이탈 장면 분포의 재료)
 * - 건너뛰기(`completed:false`)가 `tour_completed_at` 을 건드리지 않는가
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';
import { User } from '../src/users/user.entity';

describe('POST /users/me/tour (e2e)', () => {
  let app: INestApplication<App>;

  /** DB 실값 — 낙관 갱신이 아니라 진짜 저장됐는지 본다 */
  const readUser = async (id: string) => {
    const repo = app.get(DataSource).getRepository(User);
    const found = await repo.findOneBy({ id });
    if (!found) throw new Error(`user ${id} 가 사라졌다`);
    return found;
  };

  const post = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/users/me/tour')
      .set(bearer(token))
      .send(body);

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

  it('완료 → 204 + 3컬럼이 전부 채워진다', async () => {
    const { accessToken, user } = await signInAsUser(app);

    await post(accessToken, { lastStep: 7, completed: true }).expect(204);

    const after = await readUser(user.id);
    expect(after.tourSeenAt).toBeInstanceOf(Date);
    expect(after.tourCompletedAt).toBeInstanceOf(Date);
    expect(after.tourLastStep).toBe(7);
  });

  it('건너뛰기(completed:false) → seenAt·lastStep 만 · completedAt 은 null', async () => {
    const { accessToken, user } = await signInAsUser(app);

    await post(accessToken, { lastStep: 3, completed: false }).expect(204);

    const after = await readUser(user.id);
    expect(after.tourSeenAt).toBeInstanceOf(Date);
    expect(after.tourCompletedAt).toBeNull();
    expect(after.tourLastStep).toBe(3);
  });

  it('🔴 두 번 호출(3 → 7 완료) — seenAt 은 유지 · lastStep 은 최신 · completedAt 세팅', async () => {
    const { accessToken, user } = await signInAsUser(app);

    await post(accessToken, { lastStep: 3, completed: false }).expect(204);
    const first = await readUser(user.id);

    await post(accessToken, { lastStep: 7, completed: true }).expect(204);

    const after = await readUser(user.id);
    // 처음 만난 시각은 그대로 (덮어쓰면 코호트 분석이 불가능해진다)
    expect(after.tourSeenAt?.getTime()).toBe(first.tourSeenAt?.getTime());
    expect(after.tourLastStep).toBe(7);
    expect(after.tourCompletedAt).toBeInstanceOf(Date);
  });

  it('경계값 1·7 은 통과한다', async () => {
    const { accessToken, user } = await signInAsUser(app);

    await post(accessToken, { lastStep: 1, completed: false }).expect(204);
    expect((await readUser(user.id)).tourLastStep).toBe(1);

    await post(accessToken, { lastStep: 7, completed: false }).expect(204);
    expect((await readUser(user.id)).tourLastStep).toBe(7);
  });

  it.each([0, 8, -1])('lastStep=%s → 400 (1~7 범위 밖)', async (lastStep) => {
    const { accessToken, user } = await signInAsUser(app);

    await post(accessToken, { lastStep, completed: false }).expect(400);

    // 튕긴 요청이 절반만 적용되면 안 된다
    expect((await readUser(user.id)).tourSeenAt).toBeNull();
  });

  it('lastStep 이 문자열 → 400', async () => {
    const { accessToken } = await signInAsUser(app);
    await post(accessToken, { lastStep: '3', completed: false }).expect(400);
  });

  it('completed 가 문자열 → 400', async () => {
    const { accessToken } = await signInAsUser(app);
    await post(accessToken, { lastStep: 3, completed: 'true' }).expect(400);
  });

  it('빈 body → 400 (둘 다 필수)', async () => {
    const { accessToken } = await signInAsUser(app);
    await post(accessToken, {}).expect(400);
  });

  it('unknown 필드 → 400 (forbidNonWhitelisted)', async () => {
    const { accessToken } = await signInAsUser(app);
    await post(accessToken, {
      lastStep: 3,
      completed: false,
      role: 'admin',
    }).expect(400);
  });

  it('미인증 → 401', () => {
    return request(app.getHttpServer())
      .post('/users/me/tour')
      .send({ lastStep: 3, completed: false })
      .expect(401);
  });

  it('🔴 타 사용자에게 영향이 없다 — 내 행만 바뀐다', async () => {
    const mine = await signInAsUser(app);
    const other = await signInAsUser(app);

    await post(mine.accessToken, { lastStep: 7, completed: true }).expect(204);

    expect((await readUser(mine.user.id)).tourCompletedAt).toBeInstanceOf(Date);

    const afterOther = await readUser(other.user.id);
    expect(afterOther.tourSeenAt).toBeNull();
    expect(afterOther.tourCompletedAt).toBeNull();
    expect(afterOther.tourLastStep).toBeNull();
  });
});
