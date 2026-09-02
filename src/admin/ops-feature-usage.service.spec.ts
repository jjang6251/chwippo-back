import { kstWallClockToDate } from '../common/datetime';
import { tiptapTextLength } from '../common/tiptap-text-length';
import {
  buildFeatureUsage,
  bucketOf,
  FEATURE_DEFS,
  jobPostingDepth,
  median,
  toVaultItems,
  type FeatureKey,
  type UsageSnapshot,
} from './ops-feature-usage.service';

/**
 * 기능 사용 실태 — **집계 규칙**의 회귀 방어.
 *
 * ## 🔴 이 spec 이 검증하지 **못하는** 것 — 먼저 적는다
 *
 * `buildFeatureUsage` 는 DB 를 모른다. 그래서 **SQL 은 여기서 검증되지 않는다** —
 * 샘플 카드 제외(`is_sample = false`) · soft delete · 조인 경로 · `LENGTH(TRIM(...))` 가
 * 실제로 맞는지는 **진짜 Postgres 에서만** 확인된다 (`test/admin-feature-usage.e2e-spec.ts`).
 * 내가 만든 픽스처로 내 SQL 전제를 검증할 수는 없다.
 *
 * 아래가 지키는 것은 **DB 가 준 행을 받은 뒤의 TS 판정**이다: 관리자 제외 · KST 날짜 접기 ·
 * 버킷 경계 · 중앙값 · 깊이 프록시 · 잔존 창 · 응답 필드 화이트리스트. 전부 「사람이 보기엔
 * 맞아 보이는데 조용히 틀리는」 종류라 spec 이 유일한 방어다.
 *
 * ## 🔴 픽스처는 전부 KST 벽시각에서 파생시킨다
 *
 * `new Date('2026-08-10T01:00:00Z')` 처럼 UTC 로 적으면 **어느 TZ 에서 도는지에 따라**
 * 기대값이 달라진다. `kstWallClockToDate('2026-08-10T01:00')` 은 항상 KST 그 시각이다.
 * (`TZ=UTC` · `TZ=Asia/Seoul` · `TZ=America/New_York` 세 축에서 같이 통과해야 한다)
 */

/** KST 벽시각 문자열 → Date. 실행 환경 TZ 와 무관 */
const kst = (wall: string) => kstWallClockToDate(wall);

/** 집계 기준 시각 — 2026-09-02(수) 12:00 KST */
const NOW = kst('2026-09-02T12:00');

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    users: [],
    visits: [],
    cards: [],
    schedules: [],
    dailyNotes: [],
    studyNotes: [],
    studyNoteFolders: [],
    noteAttachments: [],
    sheets: [],
    checklistItems: [],
    cardCoverletters: [],
    vaultCoverletters: [],
    coverletterChats: [],
    activities: [],
    activityLogs: [],
    activityReflections: [],
    interviewSessions: [],
    interviewQuestions: [],
    myinfoItems: [],
    ...over,
  };
}

function user(
  id: string,
  over: Partial<UsageSnapshot['users'][number]> = {},
): UsageSnapshot['users'][number] {
  return {
    id,
    nickname: `유저-${id}`,
    role: 'user',
    createdAt: kst('2026-08-03T10:00'),
    ...over,
  };
}

function card(
  over: Partial<UsageSnapshot['cards'][number]> = {},
): UsageSnapshot['cards'][number] {
  return {
    userId: 'u1',
    createdAt: kst('2026-08-10T10:00'),
    currentStepIndex: 0,
    memoLength: null,
    jobPosting: null,
    ...over,
  };
}

/** 기능 통계 한 줄 꺼내기 */
const feat = (res: ReturnType<typeof buildFeatureUsage>, key: FeatureKey) => {
  const f = res.features.find((x) => x.key === key);
  if (!f) throw new Error(`기능 정의 누락: ${key}`);
  return f;
};

const tiptap = (text: string) =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

describe('buildFeatureUsage', () => {
  // ──────────────────────────────────────────────────────────────
  describe('관리자 제외 — 모든 집계·매트릭스 공통', () => {
    it('admin 이 만든 행은 기능 통계에 안 들어간다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('admin1', { role: 'admin' }), user('u1')],
          cards: [card({ userId: 'admin1' }), card({ userId: 'admin1' })],
        }),
        NOW,
      );

      expect(feat(res, 'application_card').usersEver).toBe(0);
      expect(feat(res, 'application_card').buckets).toEqual({
        one: 0,
        twoToFour: 0,
        fivePlus: 0,
      });
    });

    it('admin 은 매트릭스에 없고, 제외 인원으로 보고된다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [
            user('admin1', { role: 'admin' }),
            user('admin2', { role: 'admin' }),
            user('u1'),
          ],
        }),
        NOW,
      );

      expect(res.users.map((u) => u.userId)).toEqual(['u1']);
      expect(res.excludedAdmins).toBe(2);
      expect(res.totalUsers).toBe(1);
    });

    it('admin 은 잔존 코호트에도 안 들어간다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('admin1', { role: 'admin' })],
          visits: [{ userId: 'admin1', visitDate: '2026-08-12' }],
        }),
        NOW,
      );

      expect(res.retention).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('usersMultiDay — KST 날짜 경계', () => {
    /**
     * 🔴 이 케이스가 핵심이다. 두 시각은 **UTC 로는 8/9 와 8/10** 이지만
     * KST 로는 둘 다 8/10 이다. UTC 로 접으면 「이틀 썼다」로 잘못 센다.
     */
    it('같은 KST 날의 2건은 1일이다 (UTC 로는 서로 다른 날)', () => {
      const early = kst('2026-08-10T01:00'); // UTC 2026-08-09T16:00
      const late = kst('2026-08-10T23:00'); // UTC 2026-08-10T14:00
      expect(early.toISOString().slice(0, 10)).not.toBe(
        late.toISOString().slice(0, 10),
      );

      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          cards: [card({ createdAt: early }), card({ createdAt: late })],
        }),
        NOW,
      );

      expect(feat(res, 'application_card').usersEver).toBe(1);
      expect(feat(res, 'application_card').usersMultiDay).toBe(0);
    });

    it('서로 다른 KST 날 2건이면 multiDay 로 센다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          cards: [
            card({ createdAt: kst('2026-08-10T23:00') }),
            card({ createdAt: kst('2026-08-11T00:30') }), // KST 로 하루 넘김
          ],
        }),
        NOW,
      );

      expect(feat(res, 'application_card').usersMultiDay).toBe(1);
    });

    it('날짜 축이 없는 기능은 0 이 아니라 null 이다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          myinfoItems: [
            { userId: 'u1', kind: 'education' },
            { userId: 'u1', kind: 'cert' },
          ],
        }),
        NOW,
      );

      expect(feat(res, 'myinfo').usersEver).toBe(1);
      expect(feat(res, 'myinfo').usersMultiDay).toBeNull();
      expect(feat(res, 'myinfo').usersLast7d).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('버킷 경계 — 1 · 2 · 4 · 5', () => {
    it.each([
      [1, 'one'],
      [2, 'twoToFour'],
      [4, 'twoToFour'],
      [5, 'fivePlus'],
      [9, 'fivePlus'],
    ])('%i회 → %s', (count, bucket) => {
      expect(bucketOf(count)).toBe(bucket);
    });

    it('0회는 어느 버킷에도 없다 (안 쓴 사람은 totalUsers - usersEver)', () => {
      expect(bucketOf(0)).toBeNull();

      const res = buildFeatureUsage(
        snapshot({ users: [user('u1'), user('u2')], cards: [card()] }),
        NOW,
      );
      const f = feat(res, 'application_card');
      expect(f.usersEver).toBe(1);
      expect(f.buckets).toEqual({ one: 1, twoToFour: 0, fivePlus: 0 });
      expect(res.totalUsers - f.usersEver).toBe(1);
    });

    it('사용자마다 자기 횟수로 버킷에 들어간다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1'), user('u2'), user('u3')],
          cards: [
            card({ userId: 'u1' }),
            ...Array.from({ length: 4 }, () => card({ userId: 'u2' })),
            ...Array.from({ length: 5 }, () => card({ userId: 'u3' })),
          ],
        }),
        NOW,
      );

      expect(feat(res, 'application_card').buckets).toEqual({
        one: 1,
        twoToFour: 1,
        fivePlus: 1,
      });
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('중앙값 — 홀·짝', () => {
    it('홀수 개는 가운데 값', () => {
      expect(median([5, 1, 3])).toBe(3);
    });

    it('짝수 개는 가운데 두 값의 평균', () => {
      expect(median([1, 2, 3, 4])).toBe(2.5);
      expect(median([10, 20])).toBe(15);
    });

    it('빈 배열은 null (0 이 아니다)', () => {
      expect(median([])).toBeNull();
    });

    it('깊이 모드 max — 사용자 안에서는 최댓값, 사용자끼리는 중앙값', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1'), user('u2'), user('u3')],
          cards: [
            card({ userId: 'u1', currentStepIndex: 0 }),
            card({ userId: 'u1', currentStepIndex: 3 }), // u1 = 3
            card({ userId: 'u2', currentStepIndex: 1 }), // u2 = 1
            card({ userId: 'u3', currentStepIndex: 5 }), // u3 = 5
          ],
        }),
        NOW,
      );

      expect(feat(res, 'application_card').depthMedian).toBe(3);
      expect(feat(res, 'application_card').depthUnit).toBe('단계');
    });

    it('깊이 모드 percent — 완료 체크율', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          dailyNotes: [
            { userId: 'u1', createdAt: kst('2026-09-01T09:00'), isDone: true },
            { userId: 'u1', createdAt: kst('2026-09-01T10:00'), isDone: true },
            { userId: 'u1', createdAt: kst('2026-09-01T11:00'), isDone: false },
            { userId: 'u1', createdAt: kst('2026-09-01T12:00'), isDone: false },
          ],
        }),
        NOW,
      );

      expect(feat(res, 'daily_note').depthMedian).toBe(50);
      expect(feat(res, 'daily_note').depthUnit).toBe('% (완료 체크)');
    });

    it('깊이 모드 tagCount — 내정보는 「몇 종을 채웠나」', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          myinfoItems: [
            { userId: 'u1', kind: 'education' },
            { userId: 'u1', kind: 'education' }, // 같은 종은 1종
            { userId: 'u1', kind: 'cert' },
            { userId: 'u1', kind: 'profile' },
          ],
        }),
        NOW,
      );

      const f = feat(res, 'myinfo');
      expect(f.depthMedian).toBe(3);
      expect(f.depthUnit).toBe('종 (8종 중)');
      // 개수(count)는 종 수가 아니라 **항목 수**다
      expect(res.users[0].perFeature.myinfo?.count).toBe(4);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('빈 DB — 0 나눗셈·null 안전', () => {
    it('아무 것도 없어도 크래시 없이 응답 모양을 지킨다', () => {
      const res = buildFeatureUsage(snapshot(), NOW);

      expect(res.features).toHaveLength(FEATURE_DEFS.length);
      expect(res.users).toEqual([]);
      expect(res.retention).toEqual([]);
      expect(res.totalUsers).toBe(0);
      expect(res.excludedAdmins).toBe(0);
      for (const f of res.features) {
        expect(f.usersEver).toBe(0);
        expect(f.depthMedian).toBeNull();
        expect(f.buckets).toEqual({ one: 0, twoToFour: 0, fivePlus: 0 });
      }
    });

    it('가입자만 있고 사용 이력이 0 이어도 매트릭스 행은 남는다 (빈 perFeature)', () => {
      const res = buildFeatureUsage(snapshot({ users: [user('u1')] }), NOW);

      expect(res.users).toHaveLength(1);
      expect(res.users[0].perFeature).toEqual({});
    });

    it('공고 요건이 비어 있어도 0 을 돌려준다 (throw 없음)', () => {
      expect(jobPostingDepth(null)).toBe(0);
      expect(
        jobPostingDepth({
          responsibilities: null,
          requirements: ['a', 'b'],
          preferred: ['c'],
          techStack: [],
          qualifications: [],
          keywords: ['d'],
          parsedAt: '2026-08-20T00:00:00.000Z',
        }),
      ).toBe(4);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('깊이 = tiptapTextLength (JSON 길이 아님)', () => {
    it('공부 노트 깊이는 본문 글자수다', () => {
      const body = '가'.repeat(120);
      const content = tiptap(body);
      // 구조 JSON 은 본문보다 훨씬 길다 — 그걸 「글자수」로 부르면 단위가 어긋난다
      expect(content.length).toBeGreaterThan(body.length);

      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          studyNotes: [
            {
              userId: 'u1',
              id: 'n1',
              folderId: null,
              createdAt: kst('2026-08-20T10:00'),
              content,
            },
          ],
        }),
        NOW,
      );

      expect(feat(res, 'study_note').depthMedian).toBe(
        tiptapTextLength(content),
      );
      expect(feat(res, 'study_note').depthMedian).toBe(120);
    });

    it('준비 노트 시트도 같은 단위를 쓴다', () => {
      const content = tiptap('면접 준비 메모');
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          sheets: [
            { userId: 'u1', createdAt: kst('2026-08-20T10:00'), content },
          ],
        }),
        NOW,
      );

      expect(feat(res, 'step_note_sheet').depthMedian).toBe(
        tiptapTextLength(content),
      );
    });

    it('tiptap 이 아닌 본문(구 평문 노트·깨진 JSON)은 원문 길이로 센다 — throw 하지 않는다', () => {
      const legacy = '{깨진 JSON';
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          studyNotes: [
            {
              userId: 'u1',
              id: 'n1',
              folderId: null,
              createdAt: kst('2026-08-20T10:00'),
              content: legacy,
            },
          ],
        }),
        NOW,
      );

      expect(feat(res, 'study_note').depthMedian).toBe(legacy.length);
    });

    it('본문이 null 이어도 0 으로 센다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          studyNotes: [
            {
              userId: 'u1',
              id: 'n1',
              folderId: null,
              createdAt: kst('2026-08-20T10:00'),
              content: null,
            },
          ],
        }),
        NOW,
      );

      expect(feat(res, 'study_note').depthMedian).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('응답 필드 화이트리스트 — 개인 콘텐츠 부재', () => {
    const SECRETS = {
      note: '노트본문비밀문장',
      sheet: '시트본문비밀문장',
      memo: '회사메모비밀문장',
      posting: '공고요건비밀문장',
    };

    const withContent = snapshot({
      users: [user('u1')],
      cards: [
        card({
          memoLength: SECRETS.memo.length,
          jobPosting: {
            responsibilities: SECRETS.posting,
            requirements: [SECRETS.posting],
            preferred: [],
            techStack: [],
            qualifications: [],
            keywords: [],
            parsedAt: kst('2026-08-20T10:00').toISOString(),
          },
        }),
      ],
      studyNotes: [
        {
          userId: 'u1',
          id: 'n1',
          folderId: null,
          createdAt: kst('2026-08-20T10:00'),
          content: tiptap(SECRETS.note),
        },
      ],
      sheets: [
        {
          userId: 'u1',
          createdAt: kst('2026-08-20T10:00'),
          content: tiptap(SECRETS.sheet),
        },
      ],
    });

    it('노트 본문·시트 본문·공고 원문이 응답 어디에도 없다', () => {
      const json = JSON.stringify(buildFeatureUsage(withContent, NOW));

      for (const secret of Object.values(SECRETS)) {
        expect(json).not.toContain(secret);
      }
    });

    it('매트릭스 행의 키는 정확히 4개다', () => {
      const res = buildFeatureUsage(withContent, NOW);

      expect(Object.keys(res.users[0]).sort()).toEqual([
        'joinedAt',
        'nickname',
        'perFeature',
        'userId',
      ]);
      expect(
        Object.keys(res.users[0].perFeature.study_note ?? {}).sort(),
      ).toEqual(['count', 'lastUsedAt']);
    });

    it('최상위·기능 통계의 키가 고정돼 있다 (새 필드가 몰래 새지 않는다)', () => {
      const res = buildFeatureUsage(withContent, NOW);

      expect(Object.keys(res).sort()).toEqual([
        'excludedAdmins',
        'features',
        'generatedAt',
        'retention',
        'totalUsers',
        'users',
      ]);
      expect(Object.keys(res.features[0]).sort()).toEqual([
        'buckets',
        'dateBasis',
        'depthMedian',
        'depthUnit',
        'key',
        'label',
        'usersEver',
        'usersLast7d',
        'usersMultiDay',
      ]);
    });

    it('쓰지 않은 기능은 perFeature 에 칸을 만들지 않는다', () => {
      const res = buildFeatureUsage(withContent, NOW);

      expect(res.users[0].perFeature.interview_prep).toBeUndefined();
      expect(res.users[0].perFeature.study_note?.count).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('최근 7일 (KST, 오늘 포함)', () => {
    it('7일 창 안팎을 KST 자정으로 가른다', () => {
      // NOW = 2026-09-02 12:00 KST → 창은 2026-08-27 00:00 KST 부터
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1'), user('u2'), user('u3')],
          cards: [
            card({ userId: 'u1', createdAt: kst('2026-08-27T00:00') }), // 경계 안
            card({ userId: 'u2', createdAt: kst('2026-08-26T23:59') }), // 경계 밖
            card({ userId: 'u3', createdAt: kst('2026-09-02T11:00') }), // 오늘
          ],
        }),
        NOW,
      );

      expect(feat(res, 'application_card').usersLast7d).toBe(2);
    });

    it('날짜 축이 없는 기능은 null 이다 (캘린더 일정은 「일정 날짜」라 못 잰다)', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          schedules: [
            {
              userId: 'u1',
              scheduledDate: kst('2026-09-01T14:00'),
              detailed: true,
            },
          ],
        }),
        NOW,
      );

      expect(feat(res, 'calendar_schedule').usersEver).toBe(1);
      expect(feat(res, 'calendar_schedule').usersLast7d).toBeNull();
      expect(feat(res, 'calendar_schedule').depthMedian).toBe(100);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('잔존 (user_daily_visits · 가입 주차 KST)', () => {
    /** 2026-08-03 은 월요일 — 가입 주차의 월요일이 그대로 코호트 키가 된다 */
    it('코호트는 가입 주의 KST 월요일이다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [
            user('u1', { createdAt: kst('2026-08-05T09:00') }), // 수요일
            user('u2', { createdAt: kst('2026-08-09T23:30') }), // 일요일
          ],
        }),
        NOW,
      );

      expect(res.retention).toHaveLength(1);
      expect(res.retention[0].cohortWeek).toBe('2026-08-03');
      expect(res.retention[0].size).toBe(2);
    });

    it('week1 은 가입 주 다음 주(월~일) 방문이다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1', { createdAt: kst('2026-08-05T09:00') })],
          visits: [
            { userId: 'u1', visitDate: '2026-08-05' }, // 가입 주 (week0)
            { userId: 'u1', visitDate: '2026-08-12' }, // week1
            { userId: 'u1', visitDate: '2026-08-30' }, // week3 마지막 날(일)
          ],
        }),
        NOW,
      );

      const row = res.retention[0];
      expect(row.week1).toBe(1);
      expect(row.week2).toBe(0);
      expect(row.week3).toBe(1);
      expect(row.week4).toBe(0);
    });

    it('🔴 아직 오지 않은 주는 0 이 아니라 null 이다', () => {
      // 이번 주(2026-08-31 월) 가입자 — week1 은 9/7 부터라 아직 시작도 안 했다
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1', { createdAt: kst('2026-09-01T09:00') })],
        }),
        NOW,
      );

      const row = res.retention[0];
      expect(row.cohortWeek).toBe('2026-08-31');
      expect(row.week1).toBeNull();
      expect(row.week2).toBeNull();
      expect(row.week3).toBeNull();
      expect(row.week4).toBeNull();
    });

    it('주가 시작됐는데 방문이 없으면 0 이다 (null 과 구분)', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1', { createdAt: kst('2026-08-03T09:00') })],
        }),
        NOW,
      );

      expect(res.retention[0].week1).toBe(0);
    });

    it('최근 주차가 먼저 온다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [
            user('a', { createdAt: kst('2026-08-03T09:00') }),
            user('b', { createdAt: kst('2026-08-17T09:00') }),
          ],
        }),
        NOW,
      );

      expect(res.retention.map((r) => r.cohortWeek)).toEqual([
        '2026-08-17',
        '2026-08-03',
      ]);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('기능군 매핑 — 부모당 자식 수 프록시', () => {
    it('폴더 깊이 = 폴더당 노트 수', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          studyNoteFolders: [
            { userId: 'u1', id: 'f1', createdAt: kst('2026-08-20T10:00') },
            { userId: 'u1', id: 'f2', createdAt: kst('2026-08-20T10:00') },
          ],
          studyNotes: [
            {
              userId: 'u1',
              id: 'n1',
              folderId: 'f1',
              createdAt: kst('2026-08-20T11:00'),
              content: null,
            },
            {
              userId: 'u1',
              id: 'n2',
              folderId: 'f1',
              createdAt: kst('2026-08-20T11:00'),
              content: null,
            },
            {
              userId: 'u1',
              id: 'n3',
              folderId: null, // 폴더 없는 노트는 어느 폴더에도 안 센다
              createdAt: kst('2026-08-20T11:00'),
              content: null,
            },
          ],
        }),
        NOW,
      );

      // 폴더별 노트 수 [2, 0] → 중앙값 1
      expect(feat(res, 'study_note_folder').depthMedian).toBe(1);
      expect(feat(res, 'study_note').usersEver).toBe(1);
    });

    it('활동 깊이 = 활동당 기록 수 · 면접 깊이 = 세션당 질문 수', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          activities: [
            { userId: 'u1', id: 'a1', createdAt: kst('2026-08-20T10:00') },
          ],
          activityLogs: [
            {
              userId: 'u1',
              activityId: 'a1',
              createdAt: kst('2026-08-21T10:00'),
              contentLength: 30,
            },
            {
              userId: 'u1',
              activityId: 'a1',
              createdAt: kst('2026-08-22T10:00'),
              contentLength: 50,
            },
          ],
          interviewSessions: [
            { userId: 'u1', id: 's1', createdAt: kst('2026-08-23T10:00') },
          ],
          interviewQuestions: [
            { sessionId: 's1' },
            { sessionId: 's1' },
            { sessionId: 's1' },
          ],
        }),
        NOW,
      );

      expect(feat(res, 'activity').depthMedian).toBe(2);
      expect(feat(res, 'activity_log').depthMedian).toBe(40); // (30+50)/2
      expect(feat(res, 'interview_prep').depthMedian).toBe(3);
    });

    it('첨부 깊이 = 노트당 첨부 수', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          noteAttachments: [
            {
              userId: 'u1',
              noteId: 'n1',
              createdAt: kst('2026-08-20T10:00'),
            },
            {
              userId: 'u1',
              noteId: 'n1',
              createdAt: kst('2026-08-20T10:05'),
            },
            {
              userId: 'u1',
              noteId: 'n2',
              createdAt: kst('2026-08-20T10:10'),
            },
          ],
        }),
        NOW,
      );

      // 행별 값 [2, 2, 1] → 중앙값 2
      expect(feat(res, 'note_attachment').usersEver).toBe(1);
      expect(feat(res, 'note_attachment').depthMedian).toBe(2);
    });

    it('회사 메모는 채운 카드만 센다 (빈 메모는 0 이 아니라 없음)', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          cards: [
            card({ memoLength: null }),
            card({ memoLength: 0 }),
            card({ memoLength: 42 }),
          ],
        }),
        NOW,
      );

      expect(feat(res, 'application_card').usersEver).toBe(1);
      expect(res.users[0].perFeature.application_card?.count).toBe(3);
      expect(res.users[0].perFeature.company_memo?.count).toBe(1);
      expect(feat(res, 'company_memo').depthMedian).toBe(42);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('자소서 창고 — 6문항을 항목 단위로 펼친다', () => {
    it('채운 칸만 1건씩 센다', () => {
      const items = toVaultItems(
        [
          {
            userId: 'u1',
            updatedAt: kst('2026-08-28T10:00'),
            personality: 100,
            background: 0,
            jobCompetency: null,
            ownStrength: 250,
            collaboration: null,
            challenge: 80,
          },
        ],
        [
          { userId: 'u1', length: 500 },
          { userId: 'u1', length: 0 },
        ],
      );

      expect(items).toHaveLength(4);
      expect(items.filter((i) => i.at === null)).toHaveLength(1); // 커스텀은 시각 없음
      expect(items.map((i) => i.length).sort((a, b) => a - b)).toEqual([
        80, 100, 250, 500,
      ]);
    });

    it('창고는 1행짜리라 multiDay 를 못 재지만 최근 7일은 잰다', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1')],
          vaultCoverletters: [
            { userId: 'u1', at: kst('2026-08-31T10:00'), length: 100 },
            { userId: 'u1', at: kst('2026-08-31T10:00'), length: 300 },
          ],
        }),
        NOW,
      );

      const f = feat(res, 'coverletter_vault');
      expect(f.usersEver).toBe(1);
      expect(f.usersMultiDay).toBeNull();
      expect(f.usersLast7d).toBe(1);
      expect(f.depthMedian).toBe(200);
    });
  });

  // ──────────────────────────────────────────────────────────────
  describe('공고 요건 — 파싱 시각을 날짜 축으로 쓴다', () => {
    it('parsedAt 이 있으면 그 시각, 없거나 깨졌으면 카드 생성 시각', () => {
      const res = buildFeatureUsage(
        snapshot({
          users: [user('u1'), user('u2')],
          cards: [
            card({
              userId: 'u1',
              createdAt: kst('2026-06-01T10:00'),
              jobPosting: {
                responsibilities: null,
                requirements: ['a'],
                preferred: [],
                techStack: [],
                qualifications: [],
                keywords: [],
                parsedAt: kst('2026-09-01T10:00').toISOString(),
              },
            }),
            card({
              userId: 'u2',
              createdAt: kst('2026-06-01T10:00'),
              jobPosting: {
                responsibilities: null,
                requirements: ['a'],
                preferred: [],
                techStack: [],
                qualifications: [],
                keywords: [],
                parsedAt: 'not-a-date',
              },
            }),
          ],
        }),
        NOW,
      );

      // u1 은 최근 7일 안(9/1), u2 는 카드 생성일(6/1)로 떨어져 밖
      expect(feat(res, 'job_posting').usersEver).toBe(2);
      expect(feat(res, 'job_posting').usersLast7d).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────
  it('기능 키는 중복되지 않고, 정의 순서대로 응답에 실린다', () => {
    const keys = FEATURE_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);

    const res = buildFeatureUsage(snapshot(), NOW);
    expect(res.features.map((f) => f.key)).toEqual(keys);
  });
});
