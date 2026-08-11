/**
 * 면접 질문 은행 D1 e2e (2026-08-11) — 컨트롤러가 추가·변경돼 필수.
 *
 * unit spec 이 원리적으로 못 보는 층만 여기서 본다:
 * - **DTO 층** (items 51개·잘못된 result·시각 주입) → 실제 400 인가
 * - **FK ON DELETE CASCADE** → 자손이 정말 같이 지워지는가 (mock 으로는 관측 불가)
 * - **DB 기본값** → 새 컬럼 `source` 가 옛 행에 'ai' 로 박히는가
 * - **라우트 배선** → `:id/questions/bulk` 가 `:id/generate` 등에 먹히지 않는가
 *
 * 시나리오:
 *  E1  bulk 정상 → 201 · source='user' · 트리 조회에 그대로 보인다
 *  E2  bulk 51개 → 400 (DTO ArrayMaxSize)
 *  E3  bulk 0개 → 400
 *  E4  bulk 공백만 → 400
 *  E5  bulk 501자 → 400 · 500자 → 201 (경계)
 *  E6  bulk category 화이트리스트 밖 → 400
 *  E7  bulk 타 유저 세션 → 404
 *  E8  bulk 직접 꼬리 — 내 질문 밑 OK / AI 질문 밑 400
 *  E9  🔴 DELETE 가 **자손을 같이 지운다** (2단 트리 · FK CASCADE)
 *  E10 🔴 DELETE 는 AI 질문도 허용
 *  E11 DELETE 타 유저 → 404
 *  E12 practice 정상 → 저장 · last_practiced_at 이 서버 시각으로 찍힌다
 *  E13 practice 잘못된 result → 400
 *  E14 🔴 practice 에 시각을 끼워 넣으면 400 (forbidNonWhitelisted)
 *  E15 practice 타 유저 → 404
 *  E16 PATCH 내 질문 본문 수정 → 200
 *  E17 🔴 PATCH AI 질문 본문 수정 → 400
 *  E18 🔴 PATCH AI 질문 myMemo → 200 (기존 동작 불변)
 *  E19 기존 AI 질문 행은 source='ai' 로 읽힌다 (컬럼 DEFAULT 백필)
 *
 * ── D1b (2026-08-11) — 생성 additive 전환 · ↻ · ⭐ ──
 *  E20 🔴 옛 프론트 body `{ regenerate: true }` 가 **여전히 통과**한다 (배포 창 · 400 아님)
 *  E21 generate count·category DTO 경계 → 400
 *  E22 🔴 자소서 0건 → NEED_COVERLETTER · **질문이 하나도 안 지워진다** · audit row 1건(코인 0)
 *  E23 ↻ 내 질문 → 400
 *  E24 ↻ 꼬리질문(depth 1) → 400
 *  E25 ↻ 타 유저 → 404
 *  E26 PATCH mustPrepare — AI·내 질문 양쪽 200
 *  E27 🔴 자소서 자동 연결 — 카드에만 있으면 세션에 연결하고 진행 (선점·해제까지 실 DB)
 *
 * ── D1c (2026-08-11) — 예상 코인 공개 조회 ──
 *  E28 🔴 `feature_coin_meta` 값을 고치면 `GET /me/ai-costs` 응답이 따라 바뀐다
 *  E29 비로그인 → 401 · E30 화이트리스트 밖 feature → 400 · E31 count 경계 → 400
 *
 * ── D2 (2026-08-12) — 세션 생성 자소서 게이트 제거 ──
 *  E32 🔴 자소서 없이 POST /interview-prep-sessions → 201 · coverletterIds []
 *
 * ── D2 (2026-08-12) — 면접 AI 4경로가 자소서 게이트를 공유한다 ──
 *  E33 🔴 자소서 0건 세션의 질문에 답변 생성 → NEED_COVERLETTER (코인 미차감 audit)
 *  E34 🔴 자소서 0건 세션의 질문에 꼬리질문 → NEED_COVERLETTER
 *
 * ── D2 (2026-08-12) — category 는 AI 질문에서도 고칠 수 있다 ──
 *  E35 🔴 PATCH AI 질문 category → 200 (본문은 여전히 400 — E17 과 축이 다르다)
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { FeatureCoinMeta } from '../src/ai/entities/feature-coin-meta.entity';
import { LlmCallLog } from '../src/ai/entities/llm-call-log.entity';
import { Application } from '../src/applications/application.entity';
import { ApplicationCoverletter } from '../src/applications/application-coverletter.entity';
import { InterviewPrepQuestion } from '../src/interview-prep/entities/interview-prep-question.entity';
import { InterviewPrepSession } from '../src/interview-prep/entities/interview-prep-session.entity';
import { bearer, signInAsUser } from './helpers/auth';
import { createTestApp } from './helpers/bootstrap';
import { cleanAllTestUsers } from './helpers/db';

describe('면접 질문 은행 D1 (e2e)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    await cleanAllTestUsers(app);
  });

  /**
   * 세션을 **repo 로 직접** 만든다. `POST /interview-prep-sessions` 는 직무 게이트를
   * 통과해야 해서 픽스처가 길어지는데, 여기서 보려는 건 질문 endpoint 다.
   */
  async function setupSession() {
    const { accessToken, user } = await signInAsUser(app);
    const application = await ds.getRepository(Application).save(
      ds.getRepository(Application).create({
        userId: user.id,
        companyName: '치뽀',
        jobTitle: '백엔드 개발자',
      }),
    );
    const session = await ds.getRepository(InterviewPrepSession).save(
      ds.getRepository(InterviewPrepSession).create({
        userId: user.id,
        applicationId: application.id,
        round: '1차',
      }),
    );
    return { accessToken, user, session };
  }

  /** AI 가 만든 질문 흉내 — `source` 를 **안 넘긴다** (컬럼 DEFAULT 가 'ai' 를 박는지 같이 본다) */
  async function insertAiQuestion(
    sessionId: string,
    over: Partial<InterviewPrepQuestion> = {},
  ) {
    const repo = ds.getRepository(InterviewPrepQuestion);
    return repo.save(
      repo.create({
        sessionId,
        parentQuestionId: null,
        depth: 0,
        orderIndex: 0,
        questionText: 'AI 가 만든 질문',
        ...over,
      }),
    );
  }

  const bulkUrl = (sessionId: string) =>
    `/interview-prep-sessions/${sessionId}/questions/bulk`;

  // ── bulk ──
  it('E1 bulk 정상 → 201 · source=user · 트리 조회에 그대로 보인다', async () => {
    const { accessToken, session } = await setupSession();

    const res = await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({
        items: [
          { questionText: '왜 이 직무를 골랐나요?', category: 'motivation' },
          { questionText: '가장 힘들었던 협업 경험은?' },
        ],
      })
      .expect(201);

    const created = res.body.data as Array<{
      id: string;
      source: string;
      category: string | null;
      orderIndex: number;
    }>;
    expect(created).toHaveLength(2);
    expect(created.every((q) => q.source === 'user')).toBe(true);
    expect(created[0].category).toBe('motivation');
    expect(created[1].category).toBeNull(); // 미지정 = 미분류
    expect(created[1].orderIndex).toBe(created[0].orderIndex + 1);

    const tree = await request(app.getHttpServer())
      .get(`/interview-prep-sessions/${session.id}/questions`)
      .set(bearer(accessToken))
      .expect(200);
    expect(tree.body.data).toHaveLength(2);
    expect(tree.body.data[0].source).toBe('user');
  });

  it('E2 bulk 51개 → 400', async () => {
    const { accessToken, session } = await setupSession();
    await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({
        items: Array.from({ length: 51 }, (_, i) => ({
          questionText: `질문 ${i}`,
        })),
      })
      .expect(400);
  });

  it('E3 bulk 0개 → 400', async () => {
    const { accessToken, session } = await setupSession();
    await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [] })
      .expect(400);
  });

  it('E4 bulk 공백만 → 400', async () => {
    const { accessToken, session } = await setupSession();
    await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '     ' }] })
      .expect(400);
  });

  it('E5 bulk 길이 경계 — 500자 201 · 501자 400', async () => {
    const { accessToken, session } = await setupSession();
    await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '가'.repeat(500) }] })
      .expect(201);
    await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '가'.repeat(501) }] })
      .expect(400);
  });

  it('E6 bulk category 화이트리스트 밖 → 400', async () => {
    const { accessToken, session } = await setupSession();
    await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '질문', category: 'etc' }] })
      .expect(400);
  });

  it('E7 bulk 타 유저 세션 → 404', async () => {
    const { session } = await setupSession();
    const { accessToken: attacker } = await signInAsUser(app, {
      kakaoIdSuffix: 'attacker',
    });
    await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(attacker))
      .send({ items: [{ questionText: '남의 세션에 넣기' }] })
      .expect(404);
  });

  it('E8 bulk 직접 꼬리 — 내 질문 밑 201 · AI 질문 밑 400', async () => {
    const { accessToken, session } = await setupSession();
    const mine = await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '내가 받은 기출' }] })
      .expect(201);
    const myRootId = mine.body.data[0].id as string;

    const tail = await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({
        items: [{ questionText: '그 근거는?', parentQuestionId: myRootId }],
      })
      .expect(201);
    expect(tail.body.data[0].depth).toBe(1);

    const aiQ = await insertAiQuestion(session.id);
    await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({
        items: [{ questionText: 'AI 질문 밑에', parentQuestionId: aiQ.id }],
      })
      .expect(400);
  });

  // ── DELETE ──
  it('E9 🔴 DELETE 가 자손을 같이 지운다 (2단 트리 · FK CASCADE)', async () => {
    const { accessToken, session } = await setupSession();
    const root = await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '루트' }] })
      .expect(201);
    const rootId = root.body.data[0].id as string;

    const d1 = await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '꼬리1', parentQuestionId: rootId }] })
      .expect(201);
    const d1Id = d1.body.data[0].id as string;

    await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '꼬리2', parentQuestionId: d1Id }] })
      .expect(201);

    expect(
      await ds
        .getRepository(InterviewPrepQuestion)
        .countBy({ sessionId: session.id }),
    ).toBe(3);

    await request(app.getHttpServer())
      .delete(`/interview-prep-questions/${rootId}`)
      .set(bearer(accessToken))
      .expect(204);

    // 루트 하나를 지웠는데 depth 1·2 가 같이 사라져야 한다
    expect(
      await ds
        .getRepository(InterviewPrepQuestion)
        .countBy({ sessionId: session.id }),
    ).toBe(0);
  });

  it('E10 🔴 DELETE 는 AI 질문도 허용한다', async () => {
    const { accessToken, session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);
    await request(app.getHttpServer())
      .delete(`/interview-prep-questions/${aiQ.id}`)
      .set(bearer(accessToken))
      .expect(204);
  });

  it('E11 DELETE 타 유저 → 404', async () => {
    const { session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);
    const { accessToken: attacker } = await signInAsUser(app, {
      kakaoIdSuffix: 'attacker2',
    });
    await request(app.getHttpServer())
      .delete(`/interview-prep-questions/${aiQ.id}`)
      .set(bearer(attacker))
      .expect(404);
    expect(
      await ds.getRepository(InterviewPrepQuestion).countBy({ id: aiQ.id }),
    ).toBe(1);
  });

  // ── practice ──
  it('E12 practice 정상 → 저장 · last_practiced_at 이 서버 시각으로 찍힌다', async () => {
    const { accessToken, session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);

    const before = Date.now();
    const res = await request(app.getHttpServer())
      .post(`/interview-prep-questions/${aiQ.id}/practice`)
      .set(bearer(accessToken))
      .send({ result: 'again' })
      .expect(201);
    const after = Date.now();

    expect(res.body.data.lastPracticeResult).toBe('again');
    const at = new Date(res.body.data.lastPracticedAt as string).getTime();
    // 클라이언트가 보낸 값이 아니라 이 요청을 처리한 순간의 서버 시각이다
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(after + 1000);
  });

  it('E13 practice 잘못된 result → 400', async () => {
    const { accessToken, session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);
    await request(app.getHttpServer())
      .post(`/interview-prep-questions/${aiQ.id}/practice`)
      .set(bearer(accessToken))
      .send({ result: 'perfect' })
      .expect(400);
  });

  it('E14 🔴 practice 에 시각을 끼워 넣으면 400', async () => {
    const { accessToken, session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);
    await request(app.getHttpServer())
      .post(`/interview-prep-questions/${aiQ.id}/practice`)
      .set(bearer(accessToken))
      .send({ result: 'good', lastPracticedAt: '2000-01-01T00:00:00.000Z' })
      .expect(400);
  });

  it('E15 practice 타 유저 → 404', async () => {
    const { session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);
    const { accessToken: attacker } = await signInAsUser(app, {
      kakaoIdSuffix: 'attacker3',
    });
    await request(app.getHttpServer())
      .post(`/interview-prep-questions/${aiQ.id}/practice`)
      .set(bearer(attacker))
      .send({ result: 'good' })
      .expect(404);
  });

  // ── PATCH ──
  it('E16 PATCH 내 질문 본문·카테고리 수정 → 200', async () => {
    const { accessToken, session } = await setupSession();
    const mine = await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '원래 질문' }] })
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/interview-prep-questions/${mine.body.data[0].id}`)
      .set(bearer(accessToken))
      .send({ questionText: '고친 질문', category: 'failure' })
      .expect(200);
    expect(res.body.data.questionText).toBe('고친 질문');
    expect(res.body.data.category).toBe('failure');
  });

  it('E17 🔴 PATCH AI 질문 본문 수정 → 400', async () => {
    const { accessToken, session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);
    await request(app.getHttpServer())
      .patch(`/interview-prep-questions/${aiQ.id}`)
      .set(bearer(accessToken))
      .send({ questionText: '몰래 고치기' })
      .expect(400);
  });

  it('E18 🔴 PATCH AI 질문 myMemo → 200 (기존 동작 불변)', async () => {
    const { accessToken, session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);
    const res = await request(app.getHttpServer())
      .patch(`/interview-prep-questions/${aiQ.id}`)
      .set(bearer(accessToken))
      .send({ myMemo: '내가 쓴 답변' })
      .expect(200);
    expect(res.body.data.myMemo).toBe('내가 쓴 답변');
  });

  /**
   * 🔴 **E17 과 짝으로 읽어야 하는 케이스** (2026-08-12 반전). 같은 AI 질문에
   * 본문은 400, 유형은 200 이다 — 축이 다르기 때문이다. 본문은 "AI 가 만든 것" 의
   * 정체성이라 ↻ 의 기준이고, 유형은 **내 분류**라 흐름 정렬·시험 범위 필터의 근거다.
   * AI 가 유형을 애매하게 붙였을 때 못 고치면 그 필터들이 통째로 못 믿을 것이 된다.
   * (`mustPrepare` 가 먼저 같은 논지로 열렸다 — E26)
   */
  it('E35 🔴 PATCH AI 질문 category → 200 · 본문 동봉 시엔 400 이고 유형도 안 바뀐다', async () => {
    const { accessToken, session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id, {
      category: 'company_industry',
    });

    const res = await request(app.getHttpServer())
      .patch(`/interview-prep-questions/${aiQ.id}`)
      .set(bearer(accessToken))
      .send({ category: 'motivation' })
      .expect(200);
    expect(res.body.data.category).toBe('motivation');

    // 막힌 필드를 섞으면 전부 무효 — 부분 반영이 없다
    await request(app.getHttpServer())
      .patch(`/interview-prep-questions/${aiQ.id}`)
      .set(bearer(accessToken))
      .send({ category: 'failure', questionText: '몰래 고치기' })
      .expect(400);

    const row = await ds
      .getRepository(InterviewPrepQuestion)
      .findOneByOrFail({ id: aiQ.id });
    expect(row.category).toBe('motivation');
    expect(row.questionText).toBe('AI 가 만든 질문');
  });

  it('E19 source 를 안 넘긴 행은 DB DEFAULT 로 ai 가 된다 (옛 질문 백필과 같은 경로)', async () => {
    const { accessToken, session } = await setupSession();
    await insertAiQuestion(session.id);
    const tree = await request(app.getHttpServer())
      .get(`/interview-prep-sessions/${session.id}/questions`)
      .set(bearer(accessToken))
      .expect(200);
    expect(tree.body.data[0].source).toBe('ai');
    expect(tree.body.data[0].lastPracticedAt).toBeNull();
    expect(tree.body.data[0].lastPracticeResult).toBeNull();
  });

  // ── D1b: generate (additive) ──
  const generateUrl = (sessionId: string) =>
    `/interview-prep-sessions/${sessionId}/generate`;

  /**
   * 🔴 **배포 창 방어** (계획 §6.5). 옛 프론트는 `{ regenerate }` 를 **항상** 보낸다.
   * 전역 파이프가 `forbidNonWhitelisted: true` 라 DTO 에서 그 필드를 지우면 옛 프론트의
   * 생성이 통째로 400 이 된다 — unit spec 으로는 못 보는 층이라 여기서 본다.
   *
   * 이 세션엔 자소서가 없으므로 결과는 `NEED_COVERLETTER` 차단(200 blocked)이다.
   * **400 이 아니라는 것**이 여기서 보려는 값이다.
   */
  it('E20 🔴 옛 프론트 body { regenerate: true } 가 여전히 통과한다', async () => {
    const { accessToken, session } = await setupSession();
    const res = await request(app.getHttpServer())
      .post(generateUrl(session.id))
      .set(bearer(accessToken))
      .send({ regenerate: true })
      .expect(201);
    expect(res.body.data.status).toBe('blocked');
    expect(res.body.data.code).toBe('NEED_COVERLETTER');
  });

  it('E21 generate count·category 경계 → 400', async () => {
    const { accessToken, session } = await setupSession();
    for (const body of [
      { count: 0 },
      { count: 21 },
      { count: 3.5 },
      { category: 'etc' },
      { nope: 1 },
    ]) {
      await request(app.getHttpServer())
        .post(generateUrl(session.id))
        .set(bearer(accessToken))
        .send(body)
        .expect(400);
    }
  });

  it('E22 🔴 자소서 0건 → NEED_COVERLETTER · 질문 무손상 · audit row 1건(코인 0)', async () => {
    const { accessToken, user, session } = await setupSession();
    // 사용자가 직접 적은 질문 + 답변이 이미 있는 세션 (전환 전이라면 전량 삭제 대상이었다)
    const mine = await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '내가 모은 기출' }] })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/interview-prep-questions/${mine.body.data[0].id}`)
      .set(bearer(accessToken))
      .send({ myMemo: '내가 쓴 답변' })
      .expect(200);
    await insertAiQuestion(session.id, { orderIndex: 9 });

    const res = await request(app.getHttpServer())
      .post(generateUrl(session.id))
      .set(bearer(accessToken))
      .send({ count: 5 })
      .expect(201);
    expect(res.body.data.status).toBe('blocked');
    expect(res.body.data.code).toBe('NEED_COVERLETTER');

    // 🔴 아무것도 안 지워졌다
    const rows = await ds
      .getRepository(InterviewPrepQuestion)
      .find({ where: { sessionId: session.id } });
    expect(rows).toHaveLength(2);
    expect(rows.find((q) => q.source === 'user')?.myMemo).toBe('내가 쓴 답변');

    // audit row 는 남고, provider 는 안 불렸으므로 토큰·비용 0
    const logs = await ds.getRepository(LlmCallLog).find({
      where: { userId: user.id, feature: 'interview_prep_session' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('blocked_quota'); // preBlocked 3종 재사용 — 실제 사유는 아래
    expect(logs[0].errorMessage).toContain('NEED_COVERLETTER');
    expect(Number(logs[0].costUsd)).toBe(0);
    expect(logs[0].promptTokens).toBe(0);
  });

  // ── D1b: ↻ 낱개 교체 ──
  const regenUrl = (id: string) => `/interview-prep-questions/${id}/regenerate`;

  it('E23 ↻ 내 질문 → 400', async () => {
    const { accessToken, session } = await setupSession();
    const mine = await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '내가 모은 기출' }] })
      .expect(201);
    await request(app.getHttpServer())
      .post(regenUrl(mine.body.data[0].id as string))
      .set(bearer(accessToken))
      .expect(400);
  });

  it('E24 ↻ 꼬리질문(depth 1) → 400', async () => {
    const { accessToken, session } = await setupSession();
    const root = await insertAiQuestion(session.id);
    const tail = await insertAiQuestion(session.id, {
      parentQuestionId: root.id,
      depth: 1,
      orderIndex: 1,
      questionText: 'AI 꼬리질문',
    });
    await request(app.getHttpServer())
      .post(regenUrl(tail.id))
      .set(bearer(accessToken))
      .expect(400);
  });

  it('E25 ↻ 타 유저 → 404', async () => {
    const { session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);
    const { accessToken: attacker } = await signInAsUser(app, {
      kakaoIdSuffix: 'attacker4',
    });
    await request(app.getHttpServer())
      .post(regenUrl(aiQ.id))
      .set(bearer(attacker))
      .expect(404);
  });

  /**
   * ⭐ 는 **모든 질문**에서 켤 수 있다 (D1a 판정 #4). user 전용으로 묶으면
   * 「⭐만」 필터가 직접 추가한 질문에서 영원히 빈다.
   */
  it('E26 PATCH mustPrepare — AI·내 질문 양쪽 200', async () => {
    const { accessToken, session } = await setupSession();
    const aiQ = await insertAiQuestion(session.id);
    const ai = await request(app.getHttpServer())
      .patch(`/interview-prep-questions/${aiQ.id}`)
      .set(bearer(accessToken))
      .send({ mustPrepare: true })
      .expect(200);
    expect(ai.body.data.mustPrepare).toBe(true);

    const mine = await request(app.getHttpServer())
      .post(bulkUrl(session.id))
      .set(bearer(accessToken))
      .send({ items: [{ questionText: '내가 모은 기출' }] })
      .expect(201);
    const res = await request(app.getHttpServer())
      .patch(`/interview-prep-questions/${mine.body.data[0].id}`)
      .set(bearer(accessToken))
      .send({ mustPrepare: true })
      .expect(200);
    expect(res.body.data.mustPrepare).toBe(true);

    // 내 질문은 ⭐ + 본문 수정을 함께 보내도 된다 (AI 질문과 다른 축)
    const combo = await request(app.getHttpServer())
      .patch(`/interview-prep-questions/${mine.body.data[0].id}`)
      .set(bearer(accessToken))
      .send({ mustPrepare: false, questionText: '고친 질문' })
      .expect(200);
    expect(combo.body.data.mustPrepare).toBe(false);
    expect(combo.body.data.questionText).toBe('고친 질문');
  });

  /**
   * 🔴 자동 연결 (계획 §3D) — unit spec 은 repo 를 mock 하므로 **쿼리가 실제로 도는지**를
   * 못 본다. 여기서 보려는 건 세 가지다:
   *  ① 카드의 자소서를 `applicationId` + `order_index` 로 읽는 쿼리가 실 DB 에서 성립하는가
   *  ② 자동 연결 UPDATE 와 선점 claim 이 한 트랜잭션으로 커밋되는가
   *  ③ 끝난 뒤 `generation_status` 가 풀리는가 (안 풀리면 2분간 잠긴다)
   *
   * 이 e2e 유저는 AI 사용 동의가 없어 `blocked_consent` 로 끝난다 — **provider 는 호출되지
   * 않는다.** (테스트가 실제 API 를 때리지 않게 하는 근거가 여기다)
   */
  it('E27 🔴 자소서 자동 연결 — 카드에만 있으면 세션에 연결하고 진행한다', async () => {
    const { accessToken, user, session } = await setupSession();
    const clRepo = ds.getRepository(ApplicationCoverletter);
    const first = await clRepo.save(
      clRepo.create({
        applicationId: session.applicationId,
        question: '지원 동기를 적어주세요',
        answer: '결제 도메인 정산 배치를 개선한 경험이 있습니다.',
        orderIndex: 0,
      }),
    );
    const second = await clRepo.save(
      clRepo.create({
        applicationId: session.applicationId,
        question: '가장 어려웠던 문제는?',
        answer: '대용량 트래픽에서의 정합성 문제였습니다.',
        orderIndex: 1,
      }),
    );
    expect(session.coverletterIds).toEqual([]);

    const res = await request(app.getHttpServer())
      .post(generateUrl(session.id))
      .set(bearer(accessToken))
      .send({ count: 3 })
      .expect(201);

    // 게이트를 통과했다 = NEED_COVERLETTER 가 아니다 (동의 미완료로 그다음 관문에서 막힌다)
    expect(res.body.data.status).toBe('blocked');
    expect(res.body.data.code).toBeUndefined();
    expect(res.body.data.reason).toContain('동의');

    // ① · ② 카드의 자소서 전체가 순서대로 세션에 연결됐다
    const after = await ds
      .getRepository(InterviewPrepSession)
      .findOneByOrFail({ id: session.id });
    expect(after.coverletterIds).toEqual([first.id, second.id]);
    // ③ 잠금이 풀렸다
    expect(after.generationStatus).toBe('idle');

    // provider 미호출 — audit 은 consent 차단으로 남는다
    const logs = await ds.getRepository(LlmCallLog).find({
      where: { userId: user.id, feature: 'interview_prep_session' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('blocked_consent');
    expect(Number(logs[0].costUsd)).toBe(0);
  });

  /**
   * ── D1c (2026-08-11) — 예상 코인 공개 조회 ──
   *
   * unit spec 은 `CoinService` 를 mock 하므로 **DB 값이 응답까지 흐르는지**를 못 본다.
   * 이 API 의 존재 이유가 "프론트 하드코딩 제거" 라, 정확히 그 축(=admin 이 표를 고치면
   * 응답이 따라 움직인다)을 실 DB 로 확인한다. 인증·화이트리스트·경계는 라우트 배선 확인.
   *
   *  E28 🔴 `feature_coin_meta.avg_coin_cost` 를 고치면 `estimatedCoins` 가 따라 바뀐다
   *  E29 비로그인 → 401
   *  E30 화이트리스트 밖 feature → 400 (실존 feature 도 안 열려 있으면 400)
   *  E31 count 경계 1·20 → 200 / 0·21 → 400 · 모르는 쿼리 → 400
   */
  describe('D1c GET /me/ai-costs', () => {
    const FEATURE = 'interview_prep_session';
    const url = (qs: string) => `/me/ai-costs?${qs}`;

    it('E28 🔴 avg_coin_cost 를 고치면 estimatedCoins 가 따라 바뀐다 (하드코딩 아님)', async () => {
      const { accessToken } = await signInAsUser(app);
      const repo = ds.getRepository(FeatureCoinMeta);
      const before = await repo.findOneByOrFail({ feature: FEATURE });

      try {
        await repo.update(
          { feature: FEATURE },
          { avgCoinCost: '3.0', fixedCoinCost: null },
        );
        const res = await request(app.getHttpServer())
          .get(url(`feature=${FEATURE}&count=7`))
          .set(bearer(accessToken))
          .expect(200);
        // 3 × 1.2 = 3.6 — canCharge 가 쓰는 예약치와 같은 숫자
        expect(res.body.data).toEqual({
          feature: FEATURE,
          chargesCoins: true,
          estimatedCoins: 3.6,
          countSensitive: false,
        });

        await repo.update({ feature: FEATURE }, { avgCoinCost: '5.0' });
        const raised = await request(app.getHttpServer())
          .get(url(`feature=${FEATURE}&count=7`))
          .set(bearer(accessToken))
          .expect(200);
        expect(raised.body.data.estimatedCoins).toBe(6);
      } finally {
        // 운영 표를 테스트가 바꾼 채로 두지 않는다 (e2e 는 dev DB 를 함께 쓴다)
        await repo.update(
          { feature: FEATURE },
          {
            avgCoinCost: before.avgCoinCost,
            fixedCoinCost: before.fixedCoinCost,
          },
        );
      }
    });

    it('E29 비로그인 → 401', async () => {
      await request(app.getHttpServer())
        .get(url(`feature=${FEATURE}`))
        .expect(401);
    });

    it('E30 화이트리스트 밖 feature → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(app.getHttpServer())
        .get(url('feature=coverletter_draft_v2'))
        .set(bearer(accessToken))
        .expect(400);
      await request(app.getHttpServer())
        .get(url('feature=%27%20OR%201%3D1--'))
        .set(bearer(accessToken))
        .expect(400);
    });

    it('E31 count 경계 1·20 → 200 / 0·21 → 400 · 모르는 쿼리 → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      const get = (qs: string) =>
        request(app.getHttpServer()).get(url(qs)).set(bearer(accessToken));

      await get(`feature=${FEATURE}&count=1`).expect(200);
      await get(`feature=${FEATURE}&count=20`).expect(200);
      await get(`feature=${FEATURE}&count=0`).expect(400);
      await get(`feature=${FEATURE}&count=21`).expect(400);
      await get(`feature=${FEATURE}&userId=someone-else`).expect(400);
    });
  });

  /**
   * ── D2 (2026-08-12) — 세션 생성의 자소서 게이트 제거 ──
   *
   * v2 는 create 에서 "자소서 0건 → 400" 으로 막았고, 그 게이트가 남은 채 프론트만
   * 열리자 **실기에서 세션 생성이 통째로 막혔다**. unit spec 은 service 만 보므로
   * 이 미스를 잡았어야 할 층은 **실제 API 경계**다 — DTO·컨트롤러·서비스를 다 통과해
   * 정말 201 이 나오는지 여기서 본다. (직무 게이트는 그대로 유지 — jobTitle 은 필요하다)
   */
  describe('POST /interview-prep-sessions — 자소서 없이 생성 (질문 은행 D2)', () => {
    it('E32 🔴 coverletterIds 미전송 → 201 · 빈 배열로 저장된다', async () => {
      const { accessToken, user } = await signInAsUser(app);
      const application = await ds.getRepository(Application).save(
        ds.getRepository(Application).create({
          userId: user.id,
          companyName: '치뽀',
          jobTitle: '백엔드 개발자',
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/interview-prep-sessions')
        .set(bearer(accessToken))
        .send({ applicationId: application.id, round: '1차' })
        .expect(201);

      expect(res.body.data.coverletterIds).toEqual([]);
    });
  });

  /**
   * ── D2 (2026-08-12) — 면접 AI 4경로가 같은 자소서 게이트를 쓴다 ──
   *
   * 🔴 D1 은 게이트를 생성·↻ 에만 달았다. 그래서 자소서 없는 세션에서도 `AI 도움`(답변)과
   * ✨(꼬리질문)은 게이트 없이 돌며 **코인을 썼다** — 실기에서 발견됐다. unit spec 은
   * 서비스만 보므로 이 미스를 잡았어야 할 층은 **실제 API 경계**다: 컨트롤러가 `code` 를
   * 흘려보내야 프론트가 "자소서를 추가하세요" 안내로 분기할 수 있다.
   *
   * 이 e2e 유저는 AI 사용 동의도 없다 — 게이트가 없었다면 `blocked_consent` 로 끝났을
   * 자리다. **코드가 NEED_COVERLETTER 인 것**이 여기서 보려는 값이다.
   */
  describe('면접 AI 자소서 게이트 — 답변·꼬리질문 (질문 은행 D2)', () => {
    it('E33 🔴 자소서 0건 → 답변 생성이 NEED_COVERLETTER 로 막힌다 (코인 미차감)', async () => {
      const { accessToken, user, session } = await setupSession();
      const aiQ = await insertAiQuestion(session.id);

      const res = await request(app.getHttpServer())
        .post(`/interview-prep-questions/${aiQ.id}/answer`)
        .set(bearer(accessToken))
        .expect(201);

      expect(res.body.data.status).toBe('blocked');
      expect(res.body.data.code).toBe('NEED_COVERLETTER');
      expect(res.body.data.reason).toContain('자소서');

      // 답변은 저장되지 않았다
      const after = await ds
        .getRepository(InterviewPrepQuestion)
        .findOneByOrFail({ id: aiQ.id });
      expect(after.suggestedAnswer).toBeNull();

      // audit 은 **그 경로의 feature** 로 남고, provider 미호출이라 토큰·비용 0
      const logs = await ds.getRepository(LlmCallLog).find({
        where: { userId: user.id, feature: 'interview_prep_answer' },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe('blocked_quota'); // preBlocked 3종 재사용
      expect(logs[0].errorMessage).toContain('NEED_COVERLETTER');
      expect(Number(logs[0].costUsd)).toBe(0);
      expect(logs[0].promptTokens).toBe(0);
    });

    it('E34 🔴 자소서 0건 → 꼬리질문이 NEED_COVERLETTER 로 막힌다 (코인 미차감)', async () => {
      const { accessToken, user, session } = await setupSession();
      const aiQ = await insertAiQuestion(session.id);

      const res = await request(app.getHttpServer())
        .post(`/interview-prep-questions/${aiQ.id}/followups`)
        .set(bearer(accessToken))
        .send({})
        .expect(201);

      expect(res.body.data.status).toBe('blocked');
      expect(res.body.data.code).toBe('NEED_COVERLETTER');
      expect(res.body.data.reason).toContain('자소서');

      // 꼬리질문 row 가 생기지 않았다 (원본 질문 1개 그대로)
      expect(
        await ds
          .getRepository(InterviewPrepQuestion)
          .countBy({ sessionId: session.id }),
      ).toBe(1);

      const logs = await ds.getRepository(LlmCallLog).find({
        where: { userId: user.id, feature: 'interview_prep_followup' },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe('blocked_quota');
      expect(logs[0].errorMessage).toContain('NEED_COVERLETTER');
      expect(Number(logs[0].costUsd)).toBe(0);
    });
  });
});
