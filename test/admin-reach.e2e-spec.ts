/**
 * 도달 현황 e2e — `GET /admin/reach`.
 *
 * 🔴 **단위 spec 은 SQL 문자열만 본다.** *"`is_sample = false` 가 들어 있다"* 를 확인할 뿐,
 * 그 SQL 이 **실제로 샘플 카드를 걸러내는지**는 진짜 DB 에 넣어 봐야 안다.
 * 이 화면의 숫자는 제품 판단의 근거가 되므로, 오염 경로 두 개를 실 데이터로 고정한다:
 *
 *  ① 온보딩 샘플 카드 → 안 거르면 **온보딩 완료자 전원이 "카드" 단계 통과**
 *  ② 자소서 feature 필터 → 없으면 **노트요약 사용자가 자소서 AI 도달자**로 분류
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsAdmin, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';
import { OpsReachService } from '../src/admin/ops-reach.service';
import { Application } from '../src/applications/application.entity';

describe('도달 현황 (e2e)', () => {
  let app: INestApplication<App>;

  const fetchReach = async (token: string) => {
    // 5분 캐시가 있어 seed 후 반드시 비운다 — 안 그러면 직전 테스트의 스냅샷을 본다
    app.get(OpsReachService).resetCache();
    const res = await request(app.getHttpServer())
      .get('/admin/reach')
      .set(bearer(token))
      .expect(200);
    // 🔴 `res.body.data ?? res.body` 로 쓰면 **봉투가 있든 없든 통과**한다.
    //    실제로 그 관대함 때문에 프론트의 unwrap 누락(`undefined.toLocaleString()` 크래시)을
    //    이 파일이 못 잡았다. 봉투 형태를 계약으로 고정한다.
    expect(res.body).toHaveProperty('data');
    return res.body.data;
  };

  const addCard = (userId: string, isSample: boolean) =>
    app
      .get(DataSource)
      .getRepository(Application)
      .save(
        app
          .get(DataSource)
          .getRepository(Application)
          .create({
            userId,
            companyName: isSample ? '샘플회사' : '진짜회사',
            isSample,
          }),
      );

  const addLlmLog = (userId: string, feature: string, status = 'ok') =>
    app.get(DataSource).query(
      `INSERT INTO llm_call_logs (user_id, feature, provider, model, status)
       VALUES ($1, $2, 'mock', 'test-model', $3)`,
      [userId, feature, status],
    );

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

  describe('권한', () => {
    it('미인증 → 401', () =>
      request(app.getHttpServer()).get('/admin/reach').expect(401));

    it('일반 유저 → 403', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(app.getHttpServer())
        .get('/admin/reach')
        .set(bearer(accessToken))
        .expect(403);
    });

    it('admin → 200', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const body = await fetchReach(accessToken);
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.stageCounts).toBeDefined();
    });
  });

  // 🔴 ① — mock 으로는 못 잡는다
  it('샘플 카드만 있는 사용자는 "가입만" 단계다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'reach-sample' });
    await addCard(target.user.id, true);
    await addCard(target.user.id, true);

    const body = await fetchReach(admin.accessToken);
    const row = body.rows.find(
      (r: { userId: string }) => r.userId === target.user.id,
    );

    expect(row).toBeDefined();
    expect(row.cards).toBe(0);
    expect(row.sampleCards).toBe(2);
    expect(row.stage).toBe('signup');
  });

  it('실제 카드가 있으면 "카드" 단계로 올라간다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'reach-real' });
    await addCard(target.user.id, true);
    await addCard(target.user.id, false);

    const body = await fetchReach(admin.accessToken);
    const row = body.rows.find(
      (r: { userId: string }) => r.userId === target.user.id,
    );

    expect(row.cards).toBe(1);
    expect(row.sampleCards).toBe(1);
    expect(row.stage).toBe('card');
  });

  // 🔴 ②
  it('노트요약 AI 만 쓴 사용자는 자소서 AI 시도 0 이다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'reach-note' });
    await addLlmLog(target.user.id, 'note_summary');
    await addLlmLog(target.user.id, 'jobposting_parse');

    const body = await fetchReach(admin.accessToken);
    const row = body.rows.find(
      (r: { userId: string }) => r.userId === target.user.id,
    );

    expect(row.aiAttempts).toBe(0);
    expect(row.aiSuccesses).toBe(0);
    expect(row.stage).toBe('signup');
  });

  it('자소서 AI 는 시도·성공을 나눠 센다 (차단도 시도다)', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'reach-ai' });
    await addLlmLog(target.user.id, 'coverletter_draft_v2', 'blocked_quota');
    await addLlmLog(target.user.id, 'coverletter_chat', 'ok');
    // retry_parsing 은 1회 액션의 재시도라 시도로 세면 부풀어난다
    await addLlmLog(target.user.id, 'coverletter_chat', 'retry_parsing');

    const body = await fetchReach(admin.accessToken);
    const row = body.rows.find(
      (r: { userId: string }) => r.userId === target.user.id,
    );

    expect(row.aiAttempts).toBe(2);
    expect(row.aiSuccesses).toBe(1);
    expect(row.stage).toBe('coverletter_ai');
  });

  it('퇴역 feature 이력도 자소서 AI 로 센다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'reach-legacy' });
    await addLlmLog(target.user.id, 'coverletter', 'ok');

    const body = await fetchReach(admin.accessToken);
    const row = body.rows.find(
      (r: { userId: string }) => r.userId === target.user.id,
    );

    expect(row.aiSuccesses).toBe(1);
  });

  it('삭제된 카드는 세지 않는다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'reach-deleted' });
    const card = await addCard(target.user.id, false);
    await app
      .get(DataSource)
      .query(`UPDATE applications SET deleted_at = now() WHERE id = $1`, [
        card.id,
      ]);

    const body = await fetchReach(admin.accessToken);
    const row = body.rows.find(
      (r: { userId: string }) => r.userId === target.user.id,
    );

    expect(row.cards).toBe(0);
    expect(row.stage).toBe('signup');
  });

  it('admin 계정은 행에 없고 제외 인원으로 보고된다', async () => {
    const admin = await signInAsAdmin(app);
    const body = await fetchReach(admin.accessToken);

    expect(
      body.rows.some((r: { userId: string }) => r.userId === admin.user.id),
    ).toBe(false);
    expect(body.excludedAdmins).toBeGreaterThanOrEqual(1);
  });

  it('응답에 이메일·kakaoId 가 없다', async () => {
    const admin = await signInAsAdmin(app);
    await signInAsUser(app, {
      kakaoIdSuffix: 'reach-pii',
      email: 'leak@test.com',
    });

    const body = await fetchReach(admin.accessToken);
    const json = JSON.stringify(body);

    expect(json).not.toContain('leak@test.com');
    expect(json).not.toContain('kakao');
  });
});
