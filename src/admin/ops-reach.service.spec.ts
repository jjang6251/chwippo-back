import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  OpsReachService,
  REACH_ROW_LIMIT,
  resolveStage,
  type ReachStage,
} from './ops-reach.service';

/**
 * 🔴 이 화면의 숫자는 **제품 판단의 근거**가 된다. 틀려도 화면은 멀쩡해 보이므로
 * 눈으로는 절대 못 잡는다 — 오염 경로를 하나씩 고정한다.
 *
 * 특히 세 가지가 과거에 실제로 문제를 냈거나 낼 뻔했다:
 *  ① 샘플 카드 — 온보딩이 자동 생성하므로 안 거르면 **전원이 "카드" 단계 통과**
 *  ② AI feature 무필터 — **노트요약 사용자가 자소서 AI 도달자**로 분류
 *  ③ 비단조 사용자 — 활동일지는 별도 메뉴라 **카드 0 인데 활동 3** 이 실존
 */

/** DB 가 돌려주는 행 모양 — 숫자는 드라이버가 문자열로 줄 수 있어 그대로 흉내낸다 */
function rawRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u1',
    nickname: '테스트',
    signup_date: '2026-08-01',
    last_active_at: null,
    first_app_login_at: null,
    first_web_login_at: null,
    first_desktop_web_seen_at: null,
    tour_seen_at: null,
    tour_completed_at: null,
    tour_last_step: null,
    cards: '0',
    sample_cards: '0',
    activity_logs: '0',
    cl_questions: '0',
    cl_answers: '0',
    ai_attempts: '0',
    ai_successes: '0',
    ...over,
  };
}

describe('OpsReachService', () => {
  let service: OpsReachService;
  let query: jest.Mock;

  const setup = async (rows: unknown[], admins = 0) => {
    query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes("role = 'admin'"))
        return Promise.resolve([{ count: admins }]);
      return Promise.resolve(rows);
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpsReachService,
        {
          provide: getDataSourceToken(),
          useValue: { query } as Partial<DataSource>,
        },
      ],
    }).compile();
    service = module.get(OpsReachService);
    service.resetCache();
  };

  describe('도달 단계 판정', () => {
    it.each<[string, Parameters<typeof resolveStage>[0], ReachStage]>([
      [
        '아무것도 없음',
        {
          cards: 0,
          activityLogs: 0,
          coverletterQuestions: 0,
          coverletterAnswers: 0,
          aiSuccesses: 0,
        },
        'signup',
      ],
      [
        '카드만',
        {
          cards: 2,
          activityLogs: 0,
          coverletterQuestions: 0,
          coverletterAnswers: 0,
          aiSuccesses: 0,
        },
        'card',
      ],
      [
        '활동까지',
        {
          cards: 2,
          activityLogs: 3,
          coverletterQuestions: 0,
          coverletterAnswers: 0,
          aiSuccesses: 0,
        },
        'activity',
      ],
      [
        '문항만 있고 답 없음',
        {
          cards: 1,
          activityLogs: 0,
          coverletterQuestions: 4,
          coverletterAnswers: 0,
          aiSuccesses: 0,
        },
        'coverletter_question',
      ],
      [
        '답변 작성',
        {
          cards: 1,
          activityLogs: 0,
          coverletterQuestions: 4,
          coverletterAnswers: 1,
          aiSuccesses: 0,
        },
        'coverletter_answer',
      ],
      [
        'AI 성공',
        {
          cards: 1,
          activityLogs: 0,
          coverletterQuestions: 4,
          coverletterAnswers: 1,
          aiSuccesses: 2,
        },
        'coverletter_ai',
      ],
      // 활동일지는 /activity 별도 메뉴 — 카드 없이도 쓸 수 있다
      [
        '카드 0 · 활동 3 (비단조)',
        {
          cards: 0,
          activityLogs: 3,
          coverletterQuestions: 0,
          coverletterAnswers: 0,
          aiSuccesses: 0,
        },
        'activity',
      ],
      // 앱 소개 투어 — 가입과 첫 카드 사이
      [
        '투어만 끝냄',
        {
          tourCompleted: true,
          cards: 0,
          activityLogs: 0,
          coverletterQuestions: 0,
          coverletterAnswers: 0,
          aiSuccesses: 0,
        },
        'tour_completed',
      ],
      [
        '투어 + 카드 → 카드가 이긴다',
        {
          tourCompleted: true,
          cards: 1,
          activityLogs: 0,
          coverletterQuestions: 0,
          coverletterAnswers: 0,
          aiSuccesses: 0,
        },
        'card',
      ],
    ])('%s → %s', (_label, input, expected) => {
      expect(resolveStage(input)).toBe(expected);
    });
  });

  /**
   * 🔴 투어 단계는 **소급 불가**다. 투어가 없던 시절 가입자는 `tour_completed_at` 이 NULL 이라
   * 이 단계에서 빠지는 게 맞다 — 카드가 있다고 「투어 완료」로 세면 그 단계가 통째로 거짓이 된다.
   */
  describe('앱 소개 투어', () => {
    it('완료자만 tour_completed 단계로 센다 (카드가 있어도 대신 세지 않는다)', async () => {
      await setup([
        rawRow({ id: 'a', tour_completed_at: new Date('2026-08-28') }),
        rawRow({ id: 'b', cards: '3' }), // 투어 없이 카드만 (기존 사용자)
      ]);
      const res = await service.getReach();

      expect(res.stageCounts.tour_completed).toBe(1);
      expect(res.stageCounts.card).toBe(1);
      expect(res.rows[0].tourCompleted).toBe(true);
      expect(res.rows[1].tourCompleted).toBe(false);
    });

    it('이탈 장면 분포 — 만났지만 안 끝낸 사람만, 장면 오름차순', async () => {
      await setup([
        // 3장에서 이탈 2명
        rawRow({ id: 'a', tour_seen_at: new Date(), tour_last_step: 3 }),
        rawRow({ id: 'b', tour_seen_at: new Date(), tour_last_step: '3' }),
        // 1장에서 이탈 1명
        rawRow({ id: 'c', tour_seen_at: new Date(), tour_last_step: 1 }),
        // 🔴 완료자는 lastStep 6 이 있어도 이탈이 아니다
        rawRow({
          id: 'd',
          tour_seen_at: new Date(),
          tour_completed_at: new Date(),
          tour_last_step: 6,
        }),
        // 투어를 만난 적 없는 사람
        rawRow({ id: 'e' }),
      ]);
      const res = await service.getReach();

      expect(res.tourDropOff).toEqual([
        { step: 1, count: 1 },
        { step: 3, count: 2 },
      ]);
      // 이탈이 없는 장면은 행 자체를 만들지 않는다 (0 을 6칸 채우지 않는다)
      expect(res.tourDropOff.map((d) => d.step)).not.toContain(6);
    });

    it('아무도 투어를 안 만났으면 빈 배열 (에러 아님)', async () => {
      await setup([rawRow()]);
      const res = await service.getReach();

      expect(res.tourDropOff).toEqual([]);
      expect(res.stageCounts.tour_completed).toBe(0);
    });

    it('SQL 이 투어 3컬럼을 실제로 가져온다', async () => {
      await setup([rawRow()]);
      await service.getReach();

      const sql = query.mock.calls.map((c) => String(c[0])).join('\n');
      expect(sql).toContain('u.tour_seen_at');
      expect(sql).toContain('u.tour_completed_at');
      expect(sql).toContain('u.tour_last_step');
    });

    it('표가 잘려도 이탈 분포는 전체 기준이다', async () => {
      await setup(
        Array.from({ length: REACH_ROW_LIMIT + 5 }, (_, i) =>
          rawRow({ id: `u${i}`, tour_seen_at: new Date(), tour_last_step: 2 }),
        ),
      );
      const res = await service.getReach();

      expect(res.rows).toHaveLength(REACH_ROW_LIMIT);
      expect(res.tourDropOff).toEqual([
        { step: 2, count: REACH_ROW_LIMIT + 5 },
      ]);
    });
  });

  it('사용자 0명 → 빈 배열 + 전 단계 0 (에러 아님)', async () => {
    await setup([]);
    const res = await service.getReach();

    expect(res.rows).toEqual([]);
    expect(res.totalUsers).toBe(0);
    expect(Object.values(res.stageCounts).every((n) => n === 0)).toBe(true);
    expect(res.desktopAxis.confirmed).toBe(0);
  });

  it('정상 — 행과 단계별 인원을 함께 준다', async () => {
    await setup([
      rawRow({ id: 'a', cards: '2', activity_logs: '1' }),
      rawRow({ id: 'b', cards: '1' }),
      rawRow({ id: 'c' }),
    ]);
    const res = await service.getReach();

    expect(res.rows).toHaveLength(3);
    expect(res.totalUsers).toBe(3);
    expect(res.stageCounts.signup).toBe(3);
    expect(res.stageCounts.card).toBe(2);
    expect(res.stageCounts.activity).toBe(1);
  });

  // 🔴 ①
  it('샘플 카드만 있는 사용자 → 가입만 (카드 단계로 세지 않는다)', async () => {
    await setup([rawRow({ cards: '0', sample_cards: '3' })]);
    const res = await service.getReach();

    expect(res.rows[0].stage).toBe('signup');
    expect(res.rows[0].sampleCards).toBe(3);
    expect(res.stageCounts.card).toBe(0);
  });

  it('SQL 이 실제 카드와 샘플 카드를 분리해 센다', async () => {
    await setup([rawRow()]);
    await service.getReach();

    const sql = query.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toContain('is_sample = false');
    expect(sql).toContain('deleted_at IS NULL');
  });

  // 🔴 ②
  it('AI 집계에 자소서 feature 필터와 retry_parsing 제외가 걸린다', async () => {
    await setup([rawRow()]);
    await service.getReach();

    const call = query.mock.calls.find((c) =>
      String(c[0]).includes('llm_call_logs'),
    )!;
    expect(String(call[0])).toContain("status <> 'retry_parsing'");
    // 🔴 파라미터 배열만 보면 **SQL 이 그걸 안 써도 통과한다** (실제로 뮤테이션이 이 구멍으로 빠져나갔다).
    //    WHERE 절이 파라미터를 소비하는지까지 확인해야 필터가 살아 있음을 보장한다.
    expect(String(call[0])).toMatch(/WHERE\s+feature = ANY\(\$2/);
    const features = (call[1] as unknown[])[1] as string[];
    expect(features).toContain('coverletter_draft_v2');
    expect(features).toContain('coverletter_chat');
    // 퇴역 값도 포함해야 과거 이력이 안 잘린다
    expect(features).toContain('coverletter');
    // 자소서와 무관한 feature 는 들어가면 안 된다
    expect(features).not.toContain('note_summary');
    expect(features).not.toContain('jobposting_parse');
  });

  it('AI 시도 > 0 · 성공 0 → 자소서 AI 단계로 세지 않는다 (눌렀지만 막힘)', async () => {
    await setup([
      rawRow({ cl_questions: '1', ai_attempts: '3', ai_successes: '0' }),
    ]);
    const res = await service.getReach();

    expect(res.rows[0].aiAttempts).toBe(3);
    expect(res.rows[0].stage).toBe('coverletter_question');
    expect(res.stageCounts.coverletter_ai).toBe(0);
  });

  // 🔴 ③ — stage 만 보고 "그 아래는 다 충족" 으로 세면 여기서 틀린다
  it('비단조 사용자 — 카드 0 · 활동 3 을 "카드 도달" 로 세지 않는다', async () => {
    await setup([rawRow({ cards: '0', activity_logs: '3' })]);
    const res = await service.getReach();

    expect(res.rows[0].stage).toBe('activity');
    expect(res.stageCounts.activity).toBe(1);
    expect(res.stageCounts.card).toBe(0);
  });

  it('관리자는 제외하되 제외 인원을 함께 준다', async () => {
    await setup([rawRow()], 2);
    const res = await service.getReach();

    expect(res.excludedAdmins).toBe(2);
    const sql = query.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toContain("u.role <> 'admin'");
  });

  it('admin 카운트 쿼리가 빈 결과여도 0 으로 답한다 (DB 이상 방어)', async () => {
    query = jest
      .fn()
      .mockImplementation((sql: string) =>
        Promise.resolve(sql.includes("role = 'admin'") ? [] : [rawRow()]),
      );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpsReachService,
        {
          provide: getDataSourceToken(),
          useValue: { query } as Partial<DataSource>,
        },
      ],
    }).compile();
    const svc = module.get<OpsReachService>(OpsReachService);
    svc.resetCache();

    await expect(svc.getReach()).resolves.toMatchObject({ excludedAdmins: 0 });
  });

  it('최근 접속이 있으면 ISO 문자열로 준다 (없으면 null)', async () => {
    await setup([
      rawRow({ id: 'a', last_active_at: new Date('2026-08-05T01:23:45Z') }),
      rawRow({ id: 'b', last_active_at: null }),
    ]);
    const res = await service.getReach();

    expect(res.rows[0].lastActiveAt).toBe('2026-08-05T01:23:45.000Z');
    expect(res.rows[1].lastActiveAt).toBeNull();
  });

  describe('데스크탑 축', () => {
    it('스탬프 없는 사용자는 분모에서 빠진다', async () => {
      await setup([
        rawRow({
          id: 'a',
          first_desktop_web_seen_at: new Date('2026-08-01'),
          cl_answers: '1',
        }),
        rawRow({ id: 'b', cl_answers: '1' }), // 스탬프 없음
      ]);
      const res = await service.getReach();

      expect(res.desktopAxis.confirmed).toBe(1);
      expect(res.desktopAxis.coverletterAnswer).toBe(1);
      // 전체 기준으로는 2명이 답변을 썼다 — 두 숫자가 다른 것이 이 축의 존재 이유다
      expect(res.stageCounts.coverletter_answer).toBe(2);
    });

    it('스탬프가 null 이면 "미확인" 으로 남긴다 (모바일로 단정하지 않는다)', async () => {
      await setup([rawRow()]);
      const res = await service.getReach();
      expect(res.rows[0].desktopSeenAt).toBeNull();
    });
  });

  describe('상한 (Q3)', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => rawRow({ id: `u${i}`, cards: '1' }));

    it('상한 초과 → 표만 자르고 롤업은 전체 기준을 유지한다', async () => {
      await setup(many(REACH_ROW_LIMIT + 1));
      const res = await service.getReach();

      expect(res.rows).toHaveLength(REACH_ROW_LIMIT);
      expect(res.truncated).toBe(true);
      expect(res.totalUsers).toBe(REACH_ROW_LIMIT + 1);
      expect(res.stageCounts.card).toBe(REACH_ROW_LIMIT + 1);
    });

    it('상한 이하 → truncated=false', async () => {
      await setup(many(3));
      const res = await service.getReach();
      expect(res.truncated).toBe(false);
    });

    it.each([0, -1, 9999, Number.NaN])(
      'limit=%s → clamp (400 아님)',
      async (limit) => {
        await setup(many(5));
        const res = await service.getReach(limit);
        expect(res.rows.length).toBeGreaterThan(0);
        expect(res.rows.length).toBeLessThanOrEqual(REACH_ROW_LIMIT);
      },
    );
  });

  describe('쿼리 수', () => {
    // 🔴 사용자 수에 따라 쿼리가 늘면 N+1 이다. UserPlatformService 주석이 경고하는 그 함정
    it('사용자 1명과 50명에서 쿼리 수가 같다', async () => {
      await setup([rawRow()]);
      await service.getReach();
      const one = query.mock.calls.length;

      await setup(
        Array.from({ length: 50 }, (_, i) => rawRow({ id: `u${i}` })),
      );
      await service.getReach();
      expect(query.mock.calls.length).toBe(one);
    });
  });

  describe('응답 안전성', () => {
    it('이메일·kakaoId 를 담지 않는다', async () => {
      await setup([rawRow()]);
      const res = await service.getReach();

      const json = JSON.stringify(res);
      expect(json).not.toContain('email');
      expect(json).not.toContain('kakao');
      // SELECT 자체에서도 안 가져온다
      const sql = query.mock.calls.map((c) => String(c[0])).join('\n');
      expect(sql).not.toContain('u.email');
      expect(sql).not.toContain('kakao_id');
    });
  });

  describe('캐시', () => {
    it('5분 내 재호출은 DB 를 다시 치지 않는다', async () => {
      await setup([rawRow()]);
      await service.getReach();
      const first = query.mock.calls.length;

      await service.getReach();
      expect(query.mock.calls.length).toBe(first);
    });

    it('캐시된 응답에도 limit 이 적용된다', async () => {
      await setup(
        Array.from({ length: 10 }, (_, i) => rawRow({ id: `u${i}` })),
      );
      await service.getReach();

      const res = await service.getReach(3);
      expect(res.rows).toHaveLength(3);
      expect(res.truncated).toBe(true);
      expect(res.totalUsers).toBe(10);
    });
  });

  it('KST 기준으로 가입일을 만든다', async () => {
    await setup([rawRow()]);
    await service.getReach();

    const call = query.mock.calls.find((c) =>
      String(c[0]).includes('signup_date'),
    )!;
    expect((call[1] as unknown[])[0]).toBe('Asia/Seoul');
  });
});
