/**
 * PATCH /users/me/job-profile 통합 e2e (`plans/job-role-first.md` 묶음 3).
 *
 * 온보딩 이후 희망 직무·계열을 **바꾸는 유일한 경로**라, DTO 검증 → 부분 갱신 →
 * DB 반영까지를 실 요청으로 태운다. 특히:
 *
 * - 보낸 필드만 바뀌고 안 보낸 필드는 **그대로 남는가** (spread merge 사고 회귀)
 * - 빈 body 가 조용히 204 로 통과하지 않는가
 * - 남의 행을 건드리지 않는가
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';
import { User } from '../src/users/user.entity';

describe('PATCH /users/me/job-profile (e2e)', () => {
  let app: INestApplication<App>;

  /** DB 실값 — 낙관 갱신이 아니라 진짜 저장됐는지 본다 */
  const readUser = async (id: string) => {
    const repo = app.get(DataSource).getRepository(User);
    const found = await repo.findOneBy({ id });
    if (!found) throw new Error(`user ${id} 가 사라졌다`);
    return found;
  };

  /** 온보딩을 마친 사용자 (직무·계열이 이미 차 있는 상태) */
  const seeded = async () => {
    const signed = await signInAsUser(app);
    const repo = app.get(DataSource).getRepository(User);
    await repo.update(signed.user.id, {
      signupJobTitle: '간호사',
      signupSeriesId: 'health',
    });
    return signed;
  };

  const patch = (token: string, body: object) =>
    request(app.getHttpServer())
      .patch('/users/me/job-profile')
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

  it('jobTitle 만 → 204 + 그 컬럼만 갱신 (계열은 그대로)', async () => {
    const { accessToken, user } = await seeded();

    await patch(accessToken, { jobTitle: '백엔드 개발자' }).expect(204);

    const after = await readUser(user.id);
    expect(after.signupJobTitle).toBe('백엔드 개발자');
    // 🔴 안 보낸 필드를 건드리면 「직무만 고쳤는데 계열이 지워지는」 사고다
    expect(after.signupSeriesId).toBe('health');
  });

  it('seriesId 만 → 204 + 그 컬럼만 갱신 (직무는 그대로)', async () => {
    const { accessToken, user } = await seeded();

    await patch(accessToken, { seriesId: 'it' }).expect(204);

    const after = await readUser(user.id);
    expect(after.signupSeriesId).toBe('it');
    expect(after.signupJobTitle).toBe('간호사');
  });

  it('둘 다 null → 204 + 둘 다 비워진다', async () => {
    const { accessToken, user } = await seeded();

    await patch(accessToken, { jobTitle: null, seriesId: null }).expect(204);

    const after = await readUser(user.id);
    expect(after.signupJobTitle).toBeNull();
    expect(after.signupSeriesId).toBeNull();
  });

  it('공백만 적은 jobTitle → 204 + null 저장 (채워진 값으로 세지 않는다)', async () => {
    const { accessToken, user } = await seeded();

    await patch(accessToken, { jobTitle: '   ' }).expect(204);

    expect((await readUser(user.id)).signupJobTitle).toBeNull();
  });

  it('온보딩 미완료 사용자도 채울 수 있다 → 204', async () => {
    // 건너뛴 사람이 나중에 채우는 길이 이 엔드포인트다 — 여기서 막으면 영영 못 채운다
    const { accessToken, user } = await signInAsUser(app);
    expect((await readUser(user.id)).signupJobTitle).toBeNull();

    await patch(accessToken, { jobTitle: '지상직', seriesId: 'sales' }).expect(
      204,
    );

    const after = await readUser(user.id);
    expect(after.signupJobTitle).toBe('지상직');
    expect(after.signupSeriesId).toBe('sales');
  });

  it('빈 body → 400 (바꿀 값이 없어요)', async () => {
    const { accessToken } = await seeded();
    await patch(accessToken, {}).expect(400);
  });

  it('모르는 seriesId → 400 (14개 화이트리스트)', async () => {
    const { accessToken, user } = await seeded();

    await patch(accessToken, { seriesId: 'nurse' }).expect(400);

    // 튕긴 요청이 절반만 적용되면 안 된다
    expect((await readUser(user.id)).signupSeriesId).toBe('health');
  });

  it('101자 jobTitle → 400 (MaxLength 100)', async () => {
    const { accessToken } = await seeded();
    await patch(accessToken, { jobTitle: 'a'.repeat(101) }).expect(400);
  });

  it('100자 jobTitle → 204 (경계값은 통과)', async () => {
    const { accessToken, user } = await seeded();
    const exact = 'a'.repeat(100);

    await patch(accessToken, { jobTitle: exact }).expect(204);

    expect((await readUser(user.id)).signupJobTitle).toBe(exact);
  });

  it('unknown 필드 → 400 (forbidNonWhitelisted)', async () => {
    const { accessToken } = await seeded();
    await patch(accessToken, { jobTitle: 'ok', role: 'admin' }).expect(400);
  });

  it('미인증 → 401', () => {
    return request(app.getHttpServer())
      .patch('/users/me/job-profile')
      .send({ jobTitle: '간호사' })
      .expect(401);
  });

  it('🔴 타 사용자에게 영향이 없다 — 내 행만 바뀐다', async () => {
    const mine = await seeded();
    const other = await seeded();

    await patch(mine.accessToken, {
      jobTitle: '백엔드 개발자',
      seriesId: 'it',
    }).expect(204);

    const afterMine = await readUser(mine.user.id);
    expect(afterMine.signupJobTitle).toBe('백엔드 개발자');
    expect(afterMine.signupSeriesId).toBe('it');

    const afterOther = await readUser(other.user.id);
    expect(afterOther.signupJobTitle).toBe('간호사');
    expect(afterOther.signupSeriesId).toBe('health');
  });
});
