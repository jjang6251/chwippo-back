/**
 * W3 — StreakService spec (15 케이스).
 *
 * cover: streak=0/1/N / 깨짐 / 같은 날 source dedup / KST 자정 경계 / 365 heatmap / status 분포 /
 *        캐시 hit·miss / 비로그인은 controller 레벨 (여기 X) / AI 비활성화 source 누락 보장
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { Application } from '../applications/application.entity';
import { StreakService, type ApplicationStatus } from './streak.service';

const USER_ID = 'u1';

/** 'YYYY-MM-DD' KST today (테스트 일치) */
function todayKst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** today 기준 +N 일 (UTC 산술, KST 가 timezone offset 일치) */
function addDays(yyyymmdd: string, delta: number): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const epoch = Date.UTC(y, m - 1, d) + delta * 86400000;
  const dt = new Date(epoch);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

describe('StreakService', () => {
  let service: StreakService;
  let appRepo: jest.Mocked<Repository<Application>>;

  /** raw UNION ALL 응답 mock — [{ date, count }] */
  function mockActiveDates(rows: { date: string; count: number }[]) {
    appRepo.query.mockResolvedValue(rows);
  }

  /** status 분포 mock */
  function mockStatusDistribution(
    rows: { status: ApplicationStatus; count: number }[],
  ) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    } as never;
    appRepo.createQueryBuilder.mockReturnValue(qb);
  }

  beforeEach(async () => {
    appRepo = mock<Repository<Application>>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StreakService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
      ],
    }).compile();
    service = module.get<StreakService>(StreakService);
    mockStatusDistribution([]); // default
  });

  describe('streak 계산', () => {
    it('1. streak=0 — 오늘·어제 어떤 source 도 없음', async () => {
      mockActiveDates([]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.streak.current).toBe(0);
      expect(result.streak.lastActivityDate).toBeNull();
    });

    it('2. streak=1 — 오늘만 활동, 어제 없음', async () => {
      const today = todayKst();
      mockActiveDates([{ date: today, count: 2 }]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.streak.current).toBe(1);
      expect(result.streak.lastActivityDate).toBe(today);
    });

    it('3. streak=7 연속 — 오늘 ~ -6일 매일 활동', async () => {
      const today = todayKst();
      const rows = Array.from({ length: 7 }, (_, i) => ({
        date: addDays(today, -i),
        count: 1,
      }));
      mockActiveDates(rows);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.streak.current).toBe(7);
    });

    it('4. streak 깨짐 — 어제 활동, 오늘 없음 → current=0, lastActivityDate=yesterday', async () => {
      const today = todayKst();
      const yesterday = addDays(today, -1);
      mockActiveDates([{ date: yesterday, count: 1 }]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.streak.current).toBe(0);
      expect(result.streak.lastActivityDate).toBe(yesterday);
    });

    it('5. streak 중간 단절 — 오늘 + -1 + -3 → current=2 (-3 은 연속 X)', async () => {
      const today = todayKst();
      mockActiveDates([
        { date: today, count: 1 },
        { date: addDays(today, -1), count: 1 },
        { date: addDays(today, -3), count: 1 },
      ]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.streak.current).toBe(2);
    });

    it('6. 마지막 활동 -30일 이전, 오늘·최근 30일 없음 → current=0, lastActivityDate=30일 전', async () => {
      const today = todayKst();
      const old = addDays(today, -30);
      mockActiveDates([{ date: old, count: 1 }]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.streak.current).toBe(0);
      expect(result.streak.lastActivityDate).toBe(old);
    });
  });

  describe('heatmap 365 entries', () => {
    it('7. activeDates 비어있어도 정확히 365 entries (count=0 채움)', async () => {
      mockActiveDates([]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.heatmap).toHaveLength(365);
      expect(result.heatmap.every((h) => h.count === 0)).toBe(true);
    });

    it('8. 마지막 entry 가 오늘 KST', async () => {
      mockActiveDates([]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.heatmap[result.heatmap.length - 1].date).toBe(todayKst());
    });

    it('9. activeDates 의 count 가 heatmap 에 정확히 매핑', async () => {
      const today = todayKst();
      mockActiveDates([
        { date: today, count: 4 },
        { date: addDays(today, -10), count: 2 },
      ]);
      const result = await service.getDashboardStreak(USER_ID);
      const last = result.heatmap[result.heatmap.length - 1];
      const tenDaysAgo = result.heatmap[result.heatmap.length - 11];
      expect(last).toEqual({ date: today, count: 4 });
      expect(tenDaysAgo).toEqual({ date: addDays(today, -10), count: 2 });
    });

    it('10. 첫 entry 가 -364일 (정확히 365일 범위)', async () => {
      mockActiveDates([]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.heatmap[0].date).toBe(addDays(todayKst(), -364));
    });
  });

  describe('status 분포', () => {
    it('11. applications 5건 status 분포 (IN_PROGRESS 2 / PASSED 1 / FAILED 1 / APPLIED 1)', async () => {
      mockActiveDates([]);
      mockStatusDistribution([
        { status: 'IN_PROGRESS', count: 2 },
        { status: 'APPLIED', count: 1 },
        { status: 'PASSED', count: 1 },
        { status: 'FAILED', count: 1 },
      ]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.statusDistribution).toHaveLength(4);
      expect(
        result.statusDistribution.find((s) => s.status === 'IN_PROGRESS')
          ?.count,
      ).toBe(2);
    });

    it('12. applications 0건 → 빈 배열', async () => {
      mockActiveDates([]);
      mockStatusDistribution([]);
      const result = await service.getDashboardStreak(USER_ID);
      expect(result.statusDistribution).toEqual([]);
    });
  });

  describe('5분 in-memory 캐시', () => {
    it('13. 캐시 hit — 같은 user 두 번째 호출 시 DB 미호출', async () => {
      mockActiveDates([]);
      await service.getDashboardStreak(USER_ID);
      const callsAfter1 = appRepo.query.mock.calls.length;
      await service.getDashboardStreak(USER_ID);
      const callsAfter2 = appRepo.query.mock.calls.length;
      expect(callsAfter2).toBe(callsAfter1);
    });

    it('14. 캐시 invalidate — 강제 무효 후 재호출', async () => {
      mockActiveDates([]);
      await service.getDashboardStreak(USER_ID);
      service.invalidateCache(USER_ID);
      await service.getDashboardStreak(USER_ID);
      expect(appRepo.query.mock.calls.length).toBe(2);
    });
  });

  describe('AI 비활성화 source 누락 보장', () => {
    it('15. UNION ALL SQL 에 coverletters / interview_prep_sessions table 미포함 (AI 재활성화 시 +2)', async () => {
      mockActiveDates([]);
      await service.getDashboardStreak(USER_ID);
      const sqlCall = appRepo.query.mock.calls[0][0];
      // 활성 source 5개 포함
      expect(sqlCall).toMatch(/activity_logs/);
      expect(sqlCall).toMatch(/activity_reflections/);
      expect(sqlCall).toMatch(/applications/);
      expect(sqlCall).toMatch(/daily_notes/);
      // AI source 2개 미포함 (주석으로만)
      expect(sqlCall).not.toMatch(/^[^-]*FROM coverletters/m);
      expect(sqlCall).not.toMatch(/^[^-]*FROM interview_prep_sessions/m);
    });
  });
});
