import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Application } from '../applications/application.entity';

/**
 * 회고 = 성장 페이지 — Phase A ("나 vs 나" 시계열).
 *
 * 지표 2블록:
 *  1. Monthly Comparison — 이번 달 vs 지난 달 활동량 (지원 신규 · 활동일지 · 활동 회고)
 *  2. Personal Funnel — 지원 → 면접 도달 → 합격 (개인 전체 기간)
 *
 * KST 처리 — streak.service.ts 와 동일한 AT TIME ZONE 방식.
 * 캐시 5분 in-memory (userId 별). 서버가 "이번 달" 결정 (query 파라미터 없음 — 남용 표면 최소).
 *
 * Phase B (사용자 100+명 이후) 벤치마크는 별도 service 로 확장 예정 — 이 service 는 개인 데이터 only.
 */

export interface MetricDelta {
  current: number;
  previous: number;
  delta: number;
}

export interface GrowthMetricsResponse {
  monthlyComparison: {
    /** KST 기준 YYYY-MM */
    currentYearMonth: string;
    previousYearMonth: string;
    applications: MetricDelta;
    activityLogs: MetricDelta;
    reflections: MetricDelta;
  };
  funnel: {
    /** 지원 카드 전체 (deleted_at IS NULL) */
    total: number;
    /** '면접' LIKE 스텝이 있는 application count (DISTINCT) */
    reachedInterview: number;
    /** status='PASSED' count */
    passed: number;
  };
  /**
   * 개인 인사이트 — 분석가 톤 (raw count 넘어 패턴 지시).
   * 데이터 부족 시 값 null (표본 threshold 미달 = 표시 안 함).
   */
  insights: {
    /** 가장 활발한 요일 — activity(logs+refl+apps) count 최대 요일. 총 활동 <5 이면 null */
    mostActiveWeekday: {
      weekday: '일' | '월' | '화' | '수' | '목' | '금' | '토';
      count: number;
      /** 전체 활동 중 % (0-100) */
      sharePercent: number;
    } | null;
    /** 가장 지원 많이 한 직군 (job_category). 지원 <3 이거나 job_category null 만이면 null */
    topJobCategory: {
      category: string;
      count: number;
    } | null;
  };
  /**
   * 마일스톤 카운트 — 프론트에서 이 값으로 달성 배지 결정.
   * 백엔드는 원시 count 만 (임계값은 프론트에서 판단).
   */
  milestoneCounts: {
    applications: number;
    reachedInterview: number;
    passed: number;
    activityLogs: number;
    reflections: number;
  };
}

interface CacheEntry {
  data: GrowthMetricsResponse;
  expiresAt: number;
}

@Injectable()
export class GrowthService {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
  ) {}

  async getGrowthMetrics(userId: string): Promise<GrowthMetricsResponse> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const { currentYm, previousYm } = this.getKstYearMonths();

    const [monthly, funnel, insights, milestoneCounts] = await Promise.all([
      this.getMonthlyComparison(userId, currentYm, previousYm),
      this.getFunnel(userId),
      this.getInsights(userId),
      this.getMilestoneCounts(userId),
    ]);

    const data: GrowthMetricsResponse = {
      monthlyComparison: {
        currentYearMonth: currentYm,
        previousYearMonth: previousYm,
        ...monthly,
      },
      funnel,
      insights,
      milestoneCounts,
    };

    this.cache.set(userId, {
      data,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });
    return data;
  }

  /** KST 기준 이번 달·지난 달 YYYY-MM 산출. Date.now() 만 사용 (테스트 시 mock 가능). */
  private getKstYearMonths(): { currentYm: string; previousYm: string } {
    const KST = 9 * 60 * 60 * 1000;
    const now = new Date(Date.now() + KST);
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0-11
    const currentYm = `${y}-${String(m + 1).padStart(2, '0')}`;
    const prevY = m === 0 ? y - 1 : y;
    const prevM = m === 0 ? 11 : m - 1;
    const previousYm = `${prevY}-${String(prevM + 1).padStart(2, '0')}`;
    return { currentYm, previousYm };
  }

  private async getMonthlyComparison(
    userId: string,
    currentYm: string,
    previousYm: string,
  ): Promise<{
    applications: MetricDelta;
    activityLogs: MetricDelta;
    reflections: MetricDelta;
  }> {
    // 3 source × 2 month = 6 count. 하나의 raw SQL 로 UNION 대신 각각 조회
    // (인덱스 활용 · 이해도 우선, 6 쿼리는 병렬로 저비용)
    const [appsCur, appsPrev, logsCur, logsPrev, reflCur, reflPrev] =
      await Promise.all([
        this.countByMonth('applications', 'created_at', userId, currentYm, {
          includeDeleted: false,
        }),
        this.countByMonth('applications', 'created_at', userId, previousYm, {
          includeDeleted: false,
        }),
        this.countByMonth('activity_logs', 'created_at', userId, currentYm),
        this.countByMonth('activity_logs', 'created_at', userId, previousYm),
        this.countByMonth(
          'activity_reflections',
          'created_at',
          userId,
          currentYm,
        ),
        this.countByMonth(
          'activity_reflections',
          'created_at',
          userId,
          previousYm,
        ),
      ]);

    return {
      applications: this.toDelta(appsCur, appsPrev),
      activityLogs: this.toDelta(logsCur, logsPrev),
      reflections: this.toDelta(reflCur, reflPrev),
    };
  }

  /**
   * table + timestampCol + userId + YYYY-MM → count.
   *
   * KST 기준 월 매칭. deleted_at 지원 (applications 만).
   * table·column 은 whitelist 로 안전 (SQL injection 방지).
   */
  private async countByMonth(
    table: 'applications' | 'activity_logs' | 'activity_reflections',
    timestampCol: 'created_at',
    userId: string,
    yearMonth: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<number> {
    const includeDeleted = opts.includeDeleted ?? true;
    const deletedClause =
      table === 'applications' && !includeDeleted
        ? 'AND deleted_at IS NULL'
        : '';

    const result: { cnt: number }[] = await this.appRepo.query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM ${table}
      WHERE user_id = $1
        ${deletedClause}
        AND TO_CHAR((${timestampCol} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM') = $2
      `,
      [userId, yearMonth],
    );
    return Number(result[0]?.cnt ?? 0);
  }

  private toDelta(current: number, previous: number): MetricDelta {
    return { current, previous, delta: current - previous };
  }

  private async getFunnel(userId: string): Promise<{
    total: number;
    reachedInterview: number;
    passed: number;
  }> {
    const interviewQuery: Promise<{ cnt: number }[]> = this.appRepo.query(
      `
      SELECT COUNT(DISTINCT a.id)::int AS cnt
      FROM applications a
      INNER JOIN application_steps s ON s.application_id = a.id
      WHERE a.user_id = $1
        AND a.deleted_at IS NULL
        AND s.name LIKE '%면접%'
      `,
      [userId],
    );
    const [total, reachedInterview, passed] = await Promise.all([
      this.appRepo.count({
        where: { userId, deletedAt: IsNull() },
      }),
      interviewQuery,
      this.appRepo.count({
        where: { userId, status: 'PASSED', deletedAt: IsNull() },
      }),
    ]);

    return {
      total,
      reachedInterview: Number(reachedInterview[0]?.cnt ?? 0),
      passed,
    };
  }

  /**
   * 인사이트 — mostActiveWeekday · topJobCategory.
   *
   * mostActiveWeekday: 3 source (applications·activity_logs·activity_reflections) 의
   * created_at KST 요일별 count 합산. 총 활동 <5 이면 노이즈 방지 위해 null.
   *
   * topJobCategory: applications.job_category NOT NULL GROUP BY 최대 값. 지원 <3 이면 null.
   */
  private async getInsights(
    userId: string,
  ): Promise<GrowthMetricsResponse['insights']> {
    const weekdayQuery: Promise<{ dow: number; cnt: number }[]> =
      this.appRepo.query(
        `
        SELECT EXTRACT(DOW FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul'))::int AS dow, COUNT(*)::int AS cnt
        FROM (
          SELECT created_at FROM applications WHERE user_id = $1 AND deleted_at IS NULL
          UNION ALL
          SELECT created_at FROM activity_logs WHERE user_id = $1
          UNION ALL
          SELECT created_at FROM activity_reflections WHERE user_id = $1
        ) u
        GROUP BY dow
        `,
        [userId],
      );
    const categoryQuery: Promise<{ category: string; cnt: number }[]> =
      this.appRepo.query(
        `
        SELECT job_category AS category, COUNT(*)::int AS cnt
        FROM applications
        WHERE user_id = $1 AND deleted_at IS NULL AND job_category IS NOT NULL AND job_category <> ''
        GROUP BY job_category
        ORDER BY cnt DESC
        LIMIT 1
        `,
        [userId],
      );
    const [weekdayResult, categoryResult] = await Promise.all([
      weekdayQuery,
      categoryQuery,
    ]);

    const totalActivity = weekdayResult.reduce((s, r) => s + r.cnt, 0);
    let mostActiveWeekday: GrowthMetricsResponse['insights']['mostActiveWeekday'] =
      null;
    if (totalActivity >= 5) {
      const top = weekdayResult.reduce((a, b) => (a.cnt >= b.cnt ? a : b));
      // Postgres DOW: 0=Sunday ... 6=Saturday
      const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
      mostActiveWeekday = {
        weekday: WEEKDAYS[top.dow],
        count: top.cnt,
        sharePercent: Math.round((top.cnt / totalActivity) * 100),
      };
    }

    // 지원 전체 count 는 milestoneCounts 에서 재사용되지만 여기서도 lightweight 재계산
    const totalApps = await this.appRepo.count({
      where: { userId, deletedAt: IsNull() },
    });
    const topJobCategory =
      totalApps >= 3 && categoryResult[0]
        ? { category: categoryResult[0].category, count: categoryResult[0].cnt }
        : null;

    return { mostActiveWeekday, topJobCategory };
  }

  /** 마일스톤 원시 count — 프론트에서 임계값 판단. */
  private async getMilestoneCounts(
    userId: string,
  ): Promise<GrowthMetricsResponse['milestoneCounts']> {
    const reachedInterviewQuery: Promise<{ cnt: number }[]> =
      this.appRepo.query(
        `
      SELECT COUNT(DISTINCT a.id)::int AS cnt
      FROM applications a
      INNER JOIN application_steps s ON s.application_id = a.id
      WHERE a.user_id = $1 AND a.deleted_at IS NULL AND s.name LIKE '%면접%'
      `,
        [userId],
      );
    const activityLogsQuery: Promise<{ cnt: number }[]> = this.appRepo.query(
      `SELECT COUNT(*)::int AS cnt FROM activity_logs WHERE user_id = $1`,
      [userId],
    );
    const reflectionsQuery: Promise<{ cnt: number }[]> = this.appRepo.query(
      `SELECT COUNT(*)::int AS cnt FROM activity_reflections WHERE user_id = $1`,
      [userId],
    );
    const [
      applications,
      reachedInterviewResult,
      passed,
      activityLogsResult,
      reflectionsResult,
    ] = await Promise.all([
      this.appRepo.count({ where: { userId, deletedAt: IsNull() } }),
      reachedInterviewQuery,
      this.appRepo.count({
        where: { userId, status: 'PASSED', deletedAt: IsNull() },
      }),
      activityLogsQuery,
      reflectionsQuery,
    ]);

    return {
      applications,
      reachedInterview: Number(reachedInterviewResult[0]?.cnt ?? 0),
      passed,
      activityLogs: Number(activityLogsResult[0]?.cnt ?? 0),
      reflections: Number(reflectionsResult[0]?.cnt ?? 0),
    };
  }

  /** 테스트 격리용 */
  clearCache(): void {
    this.cache.clear();
  }
}
