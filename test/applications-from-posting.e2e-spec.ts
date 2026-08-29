/**
 * **공고 붙여넣기 → 카드** e2e — 실 DB (대장 21).
 *
 * mock 단위 spec 이 원리적으로 볼 수 없는 것만 여기서 본다
 * (앱 부팅·라우팅 우선순위·가드·ValidationPipe·실 TX·실 SQL·마이그레이션 시드 행).
 *
 *  E0  🔴 **앱이 뜬다** — ApplicationsModule 에 DailyNote·PostingDraftStore 를 붙였다.
 *      CalendarModule 을 import 했다면 전이 순환으로 부팅이 죽는다 (2026-08-08 전례)
 *  E1  🔴 **라우트 우선순위** — `GET /applications/from-posting/pending` 이
 *      `@Get(':id')` + ParseUUIDPipe 에 먼저 잡히면 400 이다. 컨트롤러 등록 순서가 계약
 *  E2  401 — 토큰 없이 4 엔드포인트
 *  E3  DTO — 29/30자 · 10,001자 · hash 형식 · jobContext 101자 (전부 400, 문구에 숫자)
 *  E4  🔴 정상 → 카드 + 스텝(dateHint 포함) + job_posting + posting_meta + **daily_notes**
 *  E5  🔴 같은 원문 2회 → 카드 1장 (LLM 도 두 번 안 부른다)
 *  E6  needs:'job' → `pending` 으로 복원 → `commit` by hash → 생성
 *  E7  needs:'company' → `commit` → 생성
 *  E8  🔴 타 사용자의 hash 로 commit → 404
 *  E9  notPosting → 카드 미생성
 *  E10 posting-meta PATCH — reviewedAt 멱등 · editedFields 누적 · 공고 카드 아니면 400
 *  E11 🔴 되돌리기(DELETE) → soft delete + **캘린더 메모까지 삭제**
 *  E12 `GET /me/alarm-status` 구조
 *  E13 마이그레이션 시드 — feature_quota_configs·feature_model_config 행
 *  E14 기존 `POST /applications` 회귀 (같은 컨트롤러 묶음이 안 깨졌나)
 *
 * ## LLM 을 어떻게 태우나
 *
 * `NODE_ENV=test` 에서는 mock 응답이 **의도적으로 안 나간다**(가짜 답변 노출 차단).
 * 그래서 부팅된 앱의 `LlmService` 인스턴스를 spy 로 갈아끼운다 — 컨트롤러·가드·
 * ValidationPipe·TX·SQL 은 전부 진짜로 돌고, 외부 호출만 대체된다.
 */
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { LlmService, type LlmCallResult } from '../src/ai/llm.service';
import { RedisThrottlerStorage } from '../src/common/redis-throttler.storage';
import { bearer, signInAsUser } from './helpers/auth';
import { createTestApp } from './helpers/bootstrap';
import { cleanAllTestUsers } from './helpers/db';

/** 실측 v3 형태의 응답 — 마감·힌트·발표(캘린더행)·최종 합격을 한 번에 덮는다 */
const CARD_JSON = {
  notPosting: false,
  companyName: '(주)무신사',
  jobTitles: ['백엔드 개발자'],
  postingYear: 2026,
  jobUrl: 'https://apply.example.com/1',
  deadline: { year: 2026, month: 12, day: 15, time: '18:00', weekday: null },
  deadlineKind: 'fixed',
  steps: [
    {
      name: '원서 접수',
      date: { year: 2026, month: 12, day: 15, time: '18:00', weekday: null },
      dateHint: null,
    },
    { name: '1차 면접', date: null, dateHint: '1월 초' },
    {
      name: '서류 합격 발표',
      date: { year: 2026, month: 12, day: 20, time: '17:00', weekday: null },
      dateHint: null,
    },
    { name: '최종 합격 발표', date: null, dateHint: null },
  ],
  responsibilities: 'API 설계',
  requirements: ['Node.js 3년'],
  preferred: [],
  techStack: ['Node.js'],
  qualifications: [],
  keywords: ['백엔드'],
};

const okCall = (json: unknown): LlmCallResult => ({
  status: 'ok',
  text: '',
  json,
  promptTokens: 3000,
  completionTokens: 300,
  costUsd: 0.0005,
  latencyMs: 1500,
  callLogId: '00000000-0000-0000-0000-000000000000',
  outputRedacted: false,
  coinCost: 0,
});

/** 30자 이상이어야 DTO 를 통과한다 — 케이스마다 다른 원문을 써야 중복 방지에 안 걸린다 */
const posting = (tag: string) =>
  `[무신사] 백엔드 개발자 채용 공고 (${tag})\n접수 마감 2026-12-15 18:00\n전형: 원서 접수 → 1차 면접 → 최종 합격\n자격요건: Node.js 3년 이상`;

describe('공고 붙여넣기 → 카드 (e2e)', () => {
  let app: INestApplication<App>;
  let llmSpy: jest.SpyInstance;

  beforeAll(async () => {
    // E0 — 여기서 터지면 모듈 순환이다 (다른 모든 케이스보다 먼저 드러난다)
    app = await createTestApp();
    llmSpy = jest.spyOn(app.get(LlmService), 'call');
  });

  afterAll(async () => {
    llmSpy.mockRestore();
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    llmSpy.mockReset();
    await cleanAllTestUsers(app);
  });

  /**
   * 🔴 엔드포인트에 **분당 10회 @Throttle** 이 걸려 있다 (남용 상한). e2e 는 같은 IP 로
   * 그보다 많이 부르므로 케이스마다 카운터를 비운다 — 스로틀 **설정 자체**는
   * `job-posting-card.controller` 의 메타데이터를 보는 단위 spec 이 결정적으로 잠근다.
   * (reviewer-login e2e 와 같은 패턴)
   */
  beforeEach(async () => {
    const storage = app.get<ThrottlerStorage>(ThrottlerStorage);
    if (storage instanceof RedisThrottlerStorage) {
      await storage.clear();
    } else {
      (storage as ThrottlerStorageService).storage.clear();
    }
  });

  const server = () => app.getHttpServer();
  const db = () => app.get(DataSource);

  const mockOk = (json: unknown = CARD_JSON) =>
    llmSpy.mockResolvedValue(okCall(json));

  interface CardResponse {
    id: string;
    companyName: string;
    jobTitle: string | null;
    jobCategory: string | null;
    jobUrl: string | null;
    createdVia: string;
    jobTitleSource: string | null;
    templateId: string | null;
    jobPosting: { requirements: string[]; parsedAt: string } | null;
    postingMeta: {
      filled: string[];
      deadlineKind: string;
      jobPicked: string | null;
      companySource: string;
      editedFields: string[];
      reviewedAt: string | null;
      callCount: number;
      noteIds: string[];
      extraDates: { label: string; date: string; noteId: string }[];
      orderConflict: boolean;
    };
    steps: {
      id: string;
      name: string;
      orderIndex: number;
      scheduledDate: string | null;
      dateHint: string | null;
    }[];
  }

  /** 응답 봉투는 `ResponseTransformInterceptor` 를 거친다 — data 안을 본다 */
  const bodyOf = <T>(res: request.Response): T =>
    (res.body as { data: T }).data;

  // ── E1 401 ────────────────────────────────────────────────────────────

  describe('E1 인증', () => {
    it.each([
      ['post', '/applications/from-posting'],
      ['post', '/applications/from-posting/commit'],
      ['get', '/applications/from-posting/pending'],
    ])('%s %s — 토큰 없으면 401', async (method, path) => {
      const req = request(server());
      const r = method === 'get' ? req.get(path) : req.post(path).send({});
      await r.expect(401);
    });

    it('PATCH /applications/:id/posting-meta — 토큰 없으면 401', async () => {
      await request(server())
        .patch(
          '/applications/00000000-0000-0000-0000-000000000001/posting-meta',
        )
        .send({ reviewed: true })
        .expect(401);
    });
  });

  // ── E2 라우트 우선순위 ────────────────────────────────────────────────

  it('🔴 E2 `from-posting/pending` 이 `:id` 보다 먼저 잡힌다 (ParseUUIDPipe 400 아님)', async () => {
    const { accessToken } = await signInAsUser(app);
    const res = await request(server())
      .get('/applications/from-posting/pending')
      .set(bearer(accessToken))
      .expect(200);
    expect(bodyOf<{ drafts: unknown[] }>(res)).toEqual({ drafts: [] });
  });

  // ── E3 DTO ────────────────────────────────────────────────────────────

  describe('E3 입력 검증', () => {
    it('29자 → 400 (문구에 숫자가 있다)', async () => {
      const { accessToken } = await signInAsUser(app);
      const res = await request(server())
        .post('/applications/from-posting')
        .set(bearer(accessToken))
        .send({ rawText: '가'.repeat(29) })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('30자');
    });

    it('10,001자 → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      const res = await request(server())
        .post('/applications/from-posting')
        .set(bearer(accessToken))
        .send({ rawText: '가'.repeat(10001) })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('10,000');
    });

    it('🔴 zero-width 로 채운 30자는 통과하지 못한다 (위생이 길이 검증보다 먼저)', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(server())
        .post('/applications/from-posting')
        .set(bearer(accessToken))
        .send({ rawText: '​'.repeat(60) })
        .expect(400);
    });

    it('commit hash 형식이 아니면 400 (조회 전에 거른다)', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(server())
        .post('/applications/from-posting/commit')
        .set(bearer(accessToken))
        .send({ hash: 'not-a-hash', companyName: '무신사' })
        .expect(400);
    });

    it('jobContext 101자 → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(server())
        .post('/applications/from-posting')
        .set(bearer(accessToken))
        .send({ rawText: posting('ctx'), jobContext: '가'.repeat(101) })
        .expect(400);
    });
  });

  // ── E4 정상 ───────────────────────────────────────────────────────────

  describe('E4 정상 생성', () => {
    it('🔴 카드·스텝·요건·메타·캘린더 메모가 한 번에 만들어진다', async () => {
      const { accessToken, user } = await signInAsUser(app);
      mockOk();

      const res = await request(server())
        .post('/applications/from-posting')
        .set(bearer(accessToken))
        .send({ rawText: posting('E4') })
        .expect(200);

      const { card } = bodyOf<{ card: CardResponse }>(res);

      // 카드 — (주) 제거 · 관측 컬럼 · 템플릿 미사용 · 계열은 서버가 안 채운다
      expect(card).toMatchObject({
        companyName: '무신사',
        jobTitle: '백엔드 개발자',
        jobCategory: null,
        jobUrl: 'https://apply.example.com/1',
        createdVia: 'paste_posting',
        jobTitleSource: 'posting',
        templateId: null,
      });

      // 스텝 — 원서 접수 → 서류 접수 통일 · 힌트 · 발표는 스텝에 없다
      expect(card.steps.map((s) => s.name)).toEqual([
        '서류 접수',
        '1차 면접',
        '최종 합격',
      ]);
      expect(card.steps[1].dateHint).toBe('1월 초');
      // 마감 18:00 KST = 09:00Z (서버 TZ 무관)
      expect(card.steps[0].scheduledDate).toBe('2026-12-15T09:00:00.000Z');

      // 요건
      expect(card.jobPosting?.requirements).toEqual(['Node.js 3년']);

      // 메타
      expect(card.postingMeta).toMatchObject({
        deadlineKind: 'fixed',
        jobPicked: 'single',
        companySource: 'parsed',
        editedFields: [],
        reviewedAt: null,
        callCount: 1,
        orderConflict: false,
      });
      expect(card.postingMeta.extraDates).toEqual([
        {
          label: '서류 합격 발표',
          date: '2026-12-20',
          noteId: expect.any(String),
        },
      ]);

      // 🔴 캘린더 메모가 실제로 들어갔다 (같은 TX)
      const notes = await db().query<
        { content: string; date: string; hour_slot: number }[]
      >(
        `SELECT content, date::text, hour_slot FROM daily_notes WHERE user_id = $1`,
        [user.id],
      );
      expect(notes).toEqual([
        {
          content: '무신사 · 서류 합격 발표',
          date: '2026-12-20',
          hour_slot: 22, // 17:00 → (17-6)*2
        },
      ]);
    });

    it('🔴 원문이 응답·DB 어디에도 없다', async () => {
      const { accessToken, user } = await signInAsUser(app);
      mockOk();
      const raw = `${posting('E4b')}\n비밀문구ZZQ9`;
      const res = await request(server())
        .post('/applications/from-posting')
        .set(bearer(accessToken))
        .send({ rawText: raw })
        .expect(200);

      expect(JSON.stringify(res.body)).not.toContain('비밀문구ZZQ9');
      const rows = await db().query<{ dump: string }[]>(
        `SELECT (to_jsonb(a.*))::text AS dump FROM applications a WHERE a.user_id = $1`,
        [user.id],
      );
      expect(rows[0].dump).not.toContain('비밀문구ZZQ9');
    });
  });

  // ── E5 중복 ───────────────────────────────────────────────────────────

  it('🔴 E5 같은 원문 두 번 → 카드 1장 · 두 번째는 LLM 도 안 부른다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    mockOk();
    const raw = posting('E5');

    const first = await request(server())
      .post('/applications/from-posting')
      .set(bearer(accessToken))
      .send({ rawText: raw })
      .expect(200);
    const callsAfterFirst = llmSpy.mock.calls.length;

    const second = await request(server())
      .post('/applications/from-posting')
      .set(bearer(accessToken))
      .send({ rawText: raw })
      .expect(200);

    expect(bodyOf<{ card: CardResponse }>(second).card.id).toBe(
      bodyOf<{ card: CardResponse }>(first).card.id,
    );
    expect(llmSpy.mock.calls.length).toBe(callsAfterFirst);

    const [{ n }] = await db().query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM applications WHERE user_id = $1`,
      [user.id],
    );
    expect(Number(n)).toBe(1);
  });

  // ── E6·E7 보완 질문 ───────────────────────────────────────────────────

  describe('E6·E7 보완 질문', () => {
    it('직무가 여럿 → needs:job → pending 복원 → commit 으로 생성', async () => {
      const { accessToken } = await signInAsUser(app);
      mockOk({ ...CARD_JSON, jobTitles: ['사무영업(일반)', '사무영업(IT)'] });

      const res = await request(server())
        .post('/applications/from-posting')
        .set(bearer(accessToken))
        .send({ rawText: posting('E6') })
        .expect(200);

      const envelope = bodyOf<{
        needs: string;
        hash: string;
        candidates: string[];
      }>(res);
      expect(envelope).toMatchObject({
        needs: 'job',
        candidates: ['사무영업(일반)', '사무영업(IT)'],
      });
      expect(envelope).not.toHaveProperty('draft'); // 🔴 초안 본문은 안 준다

      // 새로고침 복원
      const { drafts } = bodyOf<{
        drafts: {
          hash: string;
          needs: string;
          candidates: string[];
          companyName: string | null;
          jobTitle: string | null;
          createdAt: string | null;
        }[];
      }>(
        await request(server())
          .get('/applications/from-posting/pending')
          .set(bearer(accessToken))
          .expect(200),
      );
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toEqual({
        hash: envelope.hash,
        needs: 'job',
        candidates: ['사무영업(일반)', '사무영업(IT)'],
        companyName: '무신사',
        jobTitle: null,
        createdAt: expect.any(String),
      });

      // hash 로 commit → LLM 미호출
      const before = llmSpy.mock.calls.length;
      const made = await request(server())
        .post('/applications/from-posting/commit')
        .set(bearer(accessToken))
        .send({ hash: envelope.hash, jobContext: '사무영업(IT)' })
        .expect(200);
      expect(llmSpy.mock.calls.length).toBe(before);
      expect(bodyOf<{ card: CardResponse }>(made).card).toMatchObject({
        jobTitle: '사무영업(IT)',
        jobTitleSource: 'posting',
      });

      // 만들고 나면 대기 목록은 비워진다
      const after = bodyOf<{ drafts: unknown[] }>(
        await request(server())
          .get('/applications/from-posting/pending')
          .set(bearer(accessToken))
          .expect(200),
      );
      expect(after).toEqual({ drafts: [] });
    });

    it('회사명 없음 → needs:company → commit 으로 생성 (2차 파싱 없음)', async () => {
      const { accessToken } = await signInAsUser(app);
      mockOk({ ...CARD_JSON, companyName: null });

      const envelope = bodyOf<{ needs: string; hash: string }>(
        await request(server())
          .post('/applications/from-posting')
          .set(bearer(accessToken))
          .send({ rawText: posting('E7') })
          .expect(200),
      );
      expect(envelope.needs).toBe('company');

      const before = llmSpy.mock.calls.length;
      const made = await request(server())
        .post('/applications/from-posting/commit')
        .set(bearer(accessToken))
        .send({ hash: envelope.hash, companyName: '비공개(외국계 제조사)' })
        .expect(200);
      expect(llmSpy.mock.calls.length).toBe(before);
      expect(bodyOf<{ card: CardResponse }>(made).card).toMatchObject({
        companyName: '비공개(외국계 제조사)',
        postingMeta: expect.objectContaining({ companySource: 'typed' }),
      });
    });

    it('🔴 E8 타 사용자의 hash 로 commit → 404', async () => {
      const a = await signInAsUser(app, { kakaoIdSuffix: 'owner' });
      const b = await signInAsUser(app, { kakaoIdSuffix: 'stranger' });
      mockOk({ ...CARD_JSON, companyName: null });

      const { hash } = bodyOf<{ hash: string }>(
        await request(server())
          .post('/applications/from-posting')
          .set(bearer(a.accessToken))
          .send({ rawText: posting('E8') })
          .expect(200),
      );

      await request(server())
        .post('/applications/from-posting/commit')
        .set(bearer(b.accessToken))
        .send({ hash, companyName: '가로채기' })
        .expect(404);
    });

    it('만료·없는 hash → 404', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(server())
        .post('/applications/from-posting/commit')
        .set(bearer(accessToken))
        .send({ hash: 'f'.repeat(64), companyName: '무신사' })
        .expect(404);
    });
  });

  // ── E9 notPosting ─────────────────────────────────────────────────────

  it('E9 공고가 아니면 카드를 만들지 않는다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    mockOk({ ...CARD_JSON, notPosting: true });

    const res = await request(server())
      .post('/applications/from-posting')
      .set(bearer(accessToken))
      .send({ rawText: posting('E9') })
      .expect(200);

    expect(bodyOf<{ notPosting: boolean }>(res)).toEqual({ notPosting: true });
    const [{ n }] = await db().query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM applications WHERE user_id = $1`,
      [user.id],
    );
    expect(Number(n)).toBe(0);
  });

  // ── E10 posting-meta ──────────────────────────────────────────────────

  describe('E10 posting-meta', () => {
    const makeCard = async (token: string, tag: string) => {
      mockOk();
      const res = await request(server())
        .post('/applications/from-posting')
        .set(bearer(token))
        .send({ rawText: posting(tag) })
        .expect(200);
      return bodyOf<{ card: CardResponse }>(res).card;
    };

    it('reviewed → 시각 기록 · 두 번 눌러도 첫 시각 유지 (멱등)', async () => {
      const { accessToken } = await signInAsUser(app);
      const card = await makeCard(accessToken, 'E10a');

      const first = bodyOf<CardResponse>(
        await request(server())
          .patch(`/applications/${card.id}/posting-meta`)
          .set(bearer(accessToken))
          .send({ reviewed: true })
          .expect(200),
      );
      expect(first.postingMeta.reviewedAt).toEqual(expect.any(String));

      const second = bodyOf<CardResponse>(
        await request(server())
          .patch(`/applications/${card.id}/posting-meta`)
          .set(bearer(accessToken))
          .send({ reviewed: true })
          .expect(200),
      );
      expect(second.postingMeta.reviewedAt).toBe(first.postingMeta.reviewedAt);
    });

    it('🔴 editedFields 는 누적된다 (덮으면 수정률이 실제보다 낮게 나온다)', async () => {
      const { accessToken } = await signInAsUser(app);
      const card = await makeCard(accessToken, 'E10b');

      await request(server())
        .patch(`/applications/${card.id}/posting-meta`)
        .set(bearer(accessToken))
        .send({ editedFields: ['deadline'] })
        .expect(200);
      const res = bodyOf<CardResponse>(
        await request(server())
          .patch(`/applications/${card.id}/posting-meta`)
          .set(bearer(accessToken))
          .send({ editedFields: ['jobTitle'] })
          .expect(200),
      );
      expect(res.postingMeta.editedFields.sort()).toEqual([
        'deadline',
        'jobTitle',
      ]);
    });

    it('공고로 만든 카드가 아니면 400', async () => {
      const { accessToken } = await signInAsUser(app);
      const plain = bodyOf<{ id: string }>(
        await request(server())
          .post('/applications')
          .set(bearer(accessToken))
          .send({ companyName: '손으로 만든 카드' })
          .expect(201),
      );
      await request(server())
        .patch(`/applications/${plain.id}/posting-meta`)
        .set(bearer(accessToken))
        .send({ reviewed: true })
        .expect(400);
    });

    it('🔴 타인 카드에는 못 쓴다 (404)', async () => {
      const a = await signInAsUser(app, { kakaoIdSuffix: 'meta-owner' });
      const b = await signInAsUser(app, { kakaoIdSuffix: 'meta-stranger' });
      const card = await makeCard(a.accessToken, 'E10c');
      await request(server())
        .patch(`/applications/${card.id}/posting-meta`)
        .set(bearer(b.accessToken))
        .send({ reviewed: true })
        .expect(404);
    });
  });

  // ── E11 되돌리기 ──────────────────────────────────────────────────────

  it('🔴 E11 되돌리기 — soft delete 되고 캘린더 메모도 함께 사라진다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    mockOk();
    const card = bodyOf<{ card: CardResponse }>(
      await request(server())
        .post('/applications/from-posting')
        .set(bearer(accessToken))
        .send({ rawText: posting('E11') })
        .expect(200),
    ).card;

    const [{ n: before }] = await db().query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM daily_notes WHERE user_id = $1`,
      [user.id],
    );
    expect(Number(before)).toBe(1);

    await request(server())
      .delete(`/applications/${card.id}`)
      .set(bearer(accessToken))
      .expect(204);

    const [{ n: after }] = await db().query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM daily_notes WHERE user_id = $1`,
      [user.id],
    );
    expect(Number(after)).toBe(0);

    const [row] = await db().query<{ deleted_at: string | null }[]>(
      `SELECT deleted_at FROM applications WHERE id = $1`,
      [card.id],
    );
    expect(row.deleted_at).not.toBeNull(); // soft delete (행은 남는다)
  });

  it('🔴 되돌리기는 **남의 메모**를 지우지 않는다', async () => {
    const a = await signInAsUser(app, { kakaoIdSuffix: 'note-owner' });
    const b = await signInAsUser(app, { kakaoIdSuffix: 'note-other' });

    // b 의 손수 메모
    await request(server())
      .post('/calendar/daily-notes')
      .set(bearer(b.accessToken))
      .send({ date: '2026-12-20', content: 'b 의 메모' })
      .expect(201);

    mockOk();
    const card = bodyOf<{ card: CardResponse }>(
      await request(server())
        .post('/applications/from-posting')
        .set(bearer(a.accessToken))
        .send({ rawText: posting('E11b') })
        .expect(200),
    ).card;

    await request(server())
      .delete(`/applications/${card.id}`)
      .set(bearer(a.accessToken))
      .expect(204);

    const [{ n }] = await db().query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM daily_notes WHERE user_id = $1`,
      [b.user.id],
    );
    expect(Number(n)).toBe(1);
  });

  // ── E12 alarm-status ──────────────────────────────────────────────────

  it('E12 GET /me/alarm-status — 기기·권한·임박 토글 파생', async () => {
    const { accessToken } = await signInAsUser(app);
    const res = await request(server())
      .get('/me/alarm-status')
      .set(bearer(accessToken))
      .expect(200);
    expect(bodyOf<Record<string, unknown>>(res)).toEqual({
      hasDevice: false, // e2e 유저는 기기 등록이 없다
      enabled: false, // 권한 응답 전
      imminentOn: true, // 기본값 ON
    });
  });

  // ── E13 마이그레이션 시드 ─────────────────────────────────────────────

  describe('E13 feature 시드 행 (없으면 조용히 FALLBACK 한도가 걸린다)', () => {
    it('feature_quota_configs — free · 일 200 · 월 3000 · 쿨다운 0 · enabled', async () => {
      const rows = await db().query<
        {
          day_limit: number;
          month_limit: number;
          cooldown_seconds: number;
          enabled: boolean;
        }[]
      >(
        `SELECT day_limit, month_limit, cooldown_seconds, enabled
           FROM feature_quota_configs WHERE feature = 'jobposting_card' AND tier = 'free'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        day_limit: 200,
        month_limit: 3000,
        cooldown_seconds: 0,
        enabled: true,
      });
    });

    it('기존 공고 요건 정리도 같은 정책으로 풀렸다 (일 5 → 200)', async () => {
      const rows = await db().query<{ day_limit: number }[]>(
        `SELECT day_limit FROM feature_quota_configs
          WHERE feature = 'jobposting_parse' AND tier = 'free'`,
      );
      expect(rows[0].day_limit).toBe(200);
    });

    it('feature_model_config — openai gpt-4o-mini', async () => {
      const rows = await db().query<{ provider: string; model: string }[]>(
        `SELECT provider, model FROM feature_model_config WHERE feature = 'jobposting_card'`,
      );
      expect(rows[0]).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    });

    it('컬럼 2종이 실제로 있다', async () => {
      const cols = await db().query<
        { table_name: string; column_name: string }[]
      >(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE (table_name = 'application_steps' AND column_name = 'date_hint')
             OR (table_name = 'applications' AND column_name = 'posting_meta')`,
      );
      expect(cols).toHaveLength(2);
    });
  });

  // ── E14 기존 경로 회귀 ────────────────────────────────────────────────

  it('E14 기존 카드 추가(POST /applications)가 그대로 동작한다', async () => {
    const { accessToken } = await signInAsUser(app);
    const res = await request(server())
      .post('/applications')
      .set(bearer(accessToken))
      .send({
        companyName: '카카오',
        jobTitle: '프론트엔드',
        createdVia: 'add_modal',
        jobTitleSource: 'typed',
      })
      .expect(201);
    const card = bodyOf<CardResponse>(res);
    expect(card.createdVia).toBe('add_modal');
    expect(card.steps.length).toBeGreaterThan(0); // 템플릿 스텝
    expect(card.postingMeta).toBeNull();
  });
});
