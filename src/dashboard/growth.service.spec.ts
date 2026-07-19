import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { GrowthService } from './growth.service';
import { Application } from '../applications/application.entity';

/**
 * 회고=성장 GrowthService spec.
 *
 * mockImplementation 은 SQL 패턴 매칭으로 동작 — 쿼리 추가돼도 sequential mock 순서 깨지지 않음.
 *
 * 시나리오 축:
 *   1) 정상 응답 구조 (monthly · funnel · insights · milestoneCounts 모두 존재)
 *   2) delta 계산 — 양수 / 0 / 음수
 *   3) funnel — total · reachedInterview · passed 매핑
 *   4) insights — mostActiveWeekday 표본 threshold · topJobCategory 표본 threshold
 *   5) 캐시 — 두 번째 호출 DB 안 침 / clearCache / userId 별 독립
 *   6) IDOR — userId 파라미터 모든 쿼리에 전달
 *   7) KST 년말 롤오버
 */

interface MockDataset {
  /** countByMonth applications current/previous 반환. yearMonth 기준으로 분기 */
  monthlyApps?: (yearMonth: string) => number;
  monthlyLogs?: (yearMonth: string) => number;
  monthlyRefl?: (yearMonth: string) => number;
  funnelReachedInterview?: number;
  insightsWeekday?: { dow: number; cnt: number }[];
  insightsTopCategory?: { category: string; cnt: number } | null;
  milestoneApps?: number; // count()
  milestonePassed?: number; // count()
  milestoneActivityLogs?: number;
  milestoneReflections?: number;
}

function installMock(
  appRepo: jest.Mocked<Repository<Application>>,
  ds: MockDataset,
): void {
  // count() 는 호출 순서 기반: funnel total → funnel passed → insights totalApps 순
  // 편의상 total=milestoneApps, passed=milestonePassed 로 통일하고 totalApps 도 milestoneApps 재사용
  appRepo.count.mockImplementation(async (opts?: unknown) => {
    const where = (opts as { where?: { status?: string } } | undefined)?.where;
    if (where?.status === 'PASSED') return ds.milestonePassed ?? 0;
    return ds.milestoneApps ?? 0;
  });

  appRepo.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('EXTRACT(DOW')) {
      return ds.insightsWeekday ?? [];
    }
    if (sql.includes('job_category')) {
      return ds.insightsTopCategory ? [ds.insightsTopCategory] : [];
    }
    if (sql.includes('SELECT COUNT(DISTINCT a.id)')) {
      return [{ cnt: ds.funnelReachedInterview ?? 0 }];
    }
    if (sql.includes('FROM activity_logs') && sql.includes('COUNT(*)')) {
      // countByMonth 활동일지 vs milestone 활동일지 구별 — countByMonth 는 params[1]=yearMonth
      if (params && params.length === 2) {
        const ym = params[1] as string;
        return [{ cnt: ds.monthlyLogs?.(ym) ?? 0 }];
      }
      return [{ cnt: ds.milestoneActivityLogs ?? 0 }];
    }
    if (sql.includes('FROM activity_reflections') && sql.includes('COUNT(*)')) {
      if (params && params.length === 2) {
        const ym = params[1] as string;
        return [{ cnt: ds.monthlyRefl?.(ym) ?? 0 }];
      }
      return [{ cnt: ds.milestoneReflections ?? 0 }];
    }
    if (sql.includes('FROM applications') && sql.includes('COUNT(*)')) {
      const ym = params?.[1] as string;
      return [{ cnt: ds.monthlyApps?.(ym) ?? 0 }];
    }
    return [];
  });
}

describe('GrowthService', () => {
  let service: GrowthService;
  let appRepo: jest.Mocked<Repository<Application>>;

  const USER_ID = 'user-uuid-1';

  beforeEach(async () => {
    const mockAppRepo = mock<Repository<Application>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GrowthService,
        { provide: getRepositoryToken(Application), useValue: mockAppRepo },
      ],
    }).compile();

    service = module.get<GrowthService>(GrowthService);
    appRepo = module.get(getRepositoryToken(Application));
  });

  afterEach(() => jest.clearAllMocks());

  describe('정상 응답 구조', () => {
    it('monthlyComparison + funnel + insights + milestoneCounts 모두 포함, 필드 계산 정확', async () => {
      installMock(appRepo, {
        monthlyApps: (ym) =>
          ym.endsWith('01') ? 0 : ym.split('-')[1] === '12' ? 2 : 5,
        monthlyLogs: (ym) => (ym.split('-')[1] === '12' ? 4 : 11),
        monthlyRefl: (ym) => (ym.split('-')[1] === '12' ? 1 : 3),
        funnelReachedInterview: 3,
        insightsWeekday: [
          { dow: 2, cnt: 8 }, // 화 8
          { dow: 4, cnt: 5 }, // 목 5
          { dow: 1, cnt: 3 }, // 월 3
        ],
        insightsTopCategory: { category: '개발', cnt: 7 },
        milestoneApps: 12,
        milestonePassed: 1,
        milestoneActivityLogs: 11,
        milestoneReflections: 3,
      });

      const result = await service.getGrowthMetrics(USER_ID);

      // funnel
      expect(result.funnel).toEqual({
        total: 12,
        reachedInterview: 3,
        passed: 1,
      });

      // insights
      expect(result.insights.mostActiveWeekday).toEqual({
        weekday: '화',
        count: 8,
        sharePercent: 50, // 8 / (8+5+3) = 50%
      });
      expect(result.insights.topJobCategory).toEqual({
        category: '개발',
        count: 7,
      });

      // milestones
      expect(result.milestoneCounts).toEqual({
        applications: 12,
        reachedInterview: 3,
        passed: 1,
        activityLogs: 11,
        reflections: 3,
      });

      // YYYY-MM 형식 확인
      expect(result.monthlyComparison.currentYearMonth).toMatch(
        /^\d{4}-\d{2}$/,
      );
      expect(result.monthlyComparison.previousYearMonth).toMatch(
        /^\d{4}-\d{2}$/,
      );
    });
  });

  describe('delta 계산', () => {
    it('current > previous → delta 양수', async () => {
      installMock(appRepo, {
        monthlyApps: (ym) => (ym === '2026-06' ? 5 : 2),
        milestoneApps: 7,
      });
      // 강제 KST 시점 = 2026-07 로 통일
      jest
        .spyOn(Date, 'now')
        .mockReturnValue(new Date('2026-07-15T00:00:00+09:00').getTime());
      installMock(appRepo, {
        monthlyApps: (ym) => (ym === '2026-07' ? 5 : ym === '2026-06' ? 2 : 0),
        milestoneApps: 7,
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.monthlyComparison.applications).toEqual({
        current: 5,
        previous: 2,
        delta: 3,
      });
      jest.restoreAllMocks();
    });

    it('current < previous → delta 음수', async () => {
      jest
        .spyOn(Date, 'now')
        .mockReturnValue(new Date('2026-07-15T00:00:00+09:00').getTime());
      installMock(appRepo, {
        monthlyApps: (ym) => (ym === '2026-07' ? 1 : ym === '2026-06' ? 5 : 0),
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.monthlyComparison.applications.delta).toBe(-4);
      jest.restoreAllMocks();
    });

    it('두 달 모두 0 → delta 0 (신규 사용자)', async () => {
      installMock(appRepo, {});
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.monthlyComparison.applications).toEqual({
        current: 0,
        previous: 0,
        delta: 0,
      });
      expect(result.funnel).toEqual({
        total: 0,
        reachedInterview: 0,
        passed: 0,
      });
    });
  });

  describe('funnel', () => {
    it("reachedInterview 는 '면접' LIKE raw query 사용, params[0]=userId", async () => {
      installMock(appRepo, {
        milestoneApps: 10,
        milestonePassed: 2,
        funnelReachedInterview: 7,
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.funnel).toEqual({
        total: 10,
        reachedInterview: 7,
        passed: 2,
      });
      // '면접' LIKE 쿼리에 userId 전달됐는지
      const rawCall = appRepo.query.mock.calls.find((c) =>
        c[0].includes('SELECT COUNT(DISTINCT a.id)'),
      );
      expect(rawCall?.[1]).toEqual([USER_ID]);
      expect(rawCall?.[0]).toContain("s.name LIKE '%면접%'");
      expect(rawCall?.[0]).toContain('a.deleted_at IS NULL');
    });

    it('reachedInterview raw query 결과 없음 → 0 fallback', async () => {
      appRepo.count.mockResolvedValue(0);
      appRepo.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT COUNT(DISTINCT a.id)')) return [];
        return [{ cnt: 0 }];
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.funnel.reachedInterview).toBe(0);
    });
  });

  describe('insights', () => {
    it('총 활동 <5 → mostActiveWeekday = null (표본 부족)', async () => {
      installMock(appRepo, {
        insightsWeekday: [
          { dow: 2, cnt: 2 },
          { dow: 4, cnt: 1 },
        ], // 총 3
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.insights.mostActiveWeekday).toBeNull();
    });

    it('총 활동 정확히 5 → mostActiveWeekday 산출 (경계값)', async () => {
      installMock(appRepo, {
        insightsWeekday: [
          { dow: 3, cnt: 3 },
          { dow: 5, cnt: 2 },
        ],
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.insights.mostActiveWeekday).toEqual({
        weekday: '수',
        count: 3,
        sharePercent: 60, // 3/5
      });
    });

    it('총 활동 0 → mostActiveWeekday = null (빈 배열 안전)', async () => {
      installMock(appRepo, { insightsWeekday: [] });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.insights.mostActiveWeekday).toBeNull();
    });

    it('DOW 0 (일요일) 도 매핑 정확', async () => {
      installMock(appRepo, {
        insightsWeekday: [
          { dow: 0, cnt: 6 },
          { dow: 6, cnt: 2 },
        ], // 일 6, 토 2
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.insights.mostActiveWeekday?.weekday).toBe('일');
    });

    it('지원 <3 → topJobCategory = null', async () => {
      installMock(appRepo, {
        milestoneApps: 2,
        insightsTopCategory: { category: '개발', cnt: 2 },
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.insights.topJobCategory).toBeNull();
    });

    it('지원 =3 (경계) + job_category 있음 → topJobCategory 반환', async () => {
      installMock(appRepo, {
        milestoneApps: 3,
        insightsTopCategory: { category: '기획', cnt: 2 },
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.insights.topJobCategory).toEqual({
        category: '기획',
        count: 2,
      });
    });

    it('지원 많음 but job_category 모두 null/empty → topJobCategory = null (빈 결과)', async () => {
      installMock(appRepo, {
        milestoneApps: 10,
        insightsTopCategory: null,
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.insights.topJobCategory).toBeNull();
    });
  });

  describe('milestoneCounts', () => {
    it('모든 카운트 필드 반환', async () => {
      installMock(appRepo, {
        milestoneApps: 12,
        milestonePassed: 3,
        funnelReachedInterview: 5,
        milestoneActivityLogs: 30,
        milestoneReflections: 8,
      });
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.milestoneCounts).toEqual({
        applications: 12,
        reachedInterview: 5,
        passed: 3,
        activityLogs: 30,
        reflections: 8,
      });
    });

    it('신규 사용자 → 모든 카운트 0', async () => {
      installMock(appRepo, {});
      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.milestoneCounts).toEqual({
        applications: 0,
        reachedInterview: 0,
        passed: 0,
        activityLogs: 0,
        reflections: 0,
      });
    });
  });

  describe('cache', () => {
    beforeEach(() => {
      installMock(appRepo, { milestoneApps: 5 });
    });

    it('두 번째 호출은 DB 안 침 (5분 캐시)', async () => {
      await service.getGrowthMetrics(USER_ID);
      const firstCount = appRepo.query.mock.calls.length;
      await service.getGrowthMetrics(USER_ID);
      expect(appRepo.query.mock.calls.length).toBe(firstCount);
    });

    it('clearCache 후 재조회 → DB 다시 침', async () => {
      await service.getGrowthMetrics(USER_ID);
      const firstCount = appRepo.query.mock.calls.length;
      service.clearCache();
      await service.getGrowthMetrics(USER_ID);
      expect(appRepo.query.mock.calls.length).toBeGreaterThan(firstCount);
    });

    it('다른 userId 는 독립 캐시', async () => {
      await service.getGrowthMetrics(USER_ID);
      const firstCount = appRepo.query.mock.calls.length;
      await service.getGrowthMetrics('other-user');
      expect(appRepo.query.mock.calls.length).toBeGreaterThan(firstCount);
    });
  });

  describe('IDOR', () => {
    it('모든 raw query 및 count() 에 userId 전달', async () => {
      installMock(appRepo, {});
      await service.getGrowthMetrics(USER_ID);

      for (const call of appRepo.query.mock.calls) {
        const params = call[1] as unknown[];
        expect(params[0]).toBe(USER_ID);
      }
      for (const call of appRepo.count.mock.calls) {
        const opt = call[0] as { where: { userId: string } };
        expect(opt.where.userId).toBe(USER_ID);
      }
    });
  });

  describe('KST 년말 롤오버', () => {
    it('1월 → previous 는 전년 12월', async () => {
      jest
        .spyOn(Date, 'now')
        .mockReturnValue(new Date('2026-01-05T00:00:00+09:00').getTime());
      installMock(appRepo, {});

      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.monthlyComparison.currentYearMonth).toBe('2026-01');
      expect(result.monthlyComparison.previousYearMonth).toBe('2025-12');
      jest.restoreAllMocks();
    });

    it('12월 → previous 는 같은 해 11월', async () => {
      jest
        .spyOn(Date, 'now')
        .mockReturnValue(new Date('2026-12-15T00:00:00+09:00').getTime());
      installMock(appRepo, {});

      const result = await service.getGrowthMetrics(USER_ID);
      expect(result.monthlyComparison.currentYearMonth).toBe('2026-12');
      expect(result.monthlyComparison.previousYearMonth).toBe('2026-11');
      jest.restoreAllMocks();
    });
  });

  describe('KST 변환 조각 — 테이블별 타입 정합 (회귀 방어)', () => {
    // naive(applications.created_at) 전용 이중 체인 관용구
    const DOUBLE_CHAIN = "AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul'";
    // timestamptz(activity_*.created_at) 용 단일 hop
    const SINGLE_HOP = "AT TIME ZONE 'Asia/Seoul'";

    const countDoubleChain = (sql: string): number =>
      sql.split(DOUBLE_CHAIN).length - 1;

    async function capturedQueries(): Promise<string[]> {
      installMock(appRepo, {});
      await service.getGrowthMetrics(USER_ID);
      return appRepo.query.mock.calls.map((c) => c[0]);
    }

    // 월별 카운트 쿼리 = TO_CHAR + 해당 테이블. 요일 쿼리(EXTRACT DOW)·funnel 과 구별.
    const monthlyQuery = (sqls: string[], table: string): string => {
      const found = sqls.find(
        (s) => s.includes('TO_CHAR') && s.includes(`FROM ${table}`),
      );
      expect(found).toBeDefined();
      return found as string;
    };

    it('월별 applications(naive) 쿼리 → 이중 체인 유지', async () => {
      const sql = monthlyQuery(await capturedQueries(), 'applications');
      expect(sql).toContain(DOUBLE_CHAIN);
    });

    it('월별 activity_logs(timestamptz) 쿼리 → 단일 hop, 이중 체인 없음', async () => {
      const sql = monthlyQuery(await capturedQueries(), 'activity_logs');
      expect(sql).toContain(SINGLE_HOP);
      expect(countDoubleChain(sql)).toBe(0);
    });

    it('월별 activity_reflections(timestamptz) 쿼리 → 단일 hop, 이중 체인 없음', async () => {
      const sql = monthlyQuery(await capturedQueries(), 'activity_reflections');
      expect(sql).toContain(SINGLE_HOP);
      expect(countDoubleChain(sql)).toBe(0);
    });

    it('요일 인사이트 UNION → 브랜치별 타입 정합 (applications 이중 체인 1회 · activity_* 단일 hop)', async () => {
      const sqls = await capturedQueries();
      const weekday = sqls.find((s) => s.includes('EXTRACT(DOW'));
      expect(weekday).toBeDefined();
      const sql = weekday as string;

      // 바깥 EXTRACT 는 변환된 alias(kst_ts) 를 사용 — 재변환하지 않음
      expect(sql).toContain('EXTRACT(DOW FROM kst_ts');

      // 이중 체인은 naive(applications) 브랜치에서만 정확히 1회
      expect(countDoubleChain(sql)).toBe(1);

      const branches = sql.split('UNION ALL');
      const appsBranch = branches.find((b) => b.includes('FROM applications'));
      const logsBranch = branches.find((b) => b.includes('FROM activity_logs'));
      const reflBranch = branches.find((b) =>
        b.includes('FROM activity_reflections'),
      );
      expect(appsBranch).toBeDefined();
      expect(logsBranch).toBeDefined();
      expect(reflBranch).toBeDefined();

      // applications(naive) → 이중 체인
      expect(countDoubleChain(appsBranch as string)).toBe(1);
      // activity_*(timestamptz) → 단일 hop, 이중 체인 없음
      expect(logsBranch as string).toContain(SINGLE_HOP);
      expect(countDoubleChain(logsBranch as string)).toBe(0);
      expect(reflBranch as string).toContain(SINGLE_HOP);
      expect(countDoubleChain(reflBranch as string)).toBe(0);
    });
  });
});
