import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Application } from '../applications/application.entity';

export type ApplicationStatus =
  | 'IN_PROGRESS'
  | 'APPLIED'
  | 'INTERVIEW'
  | 'PASSED'
  | 'FAILED';

export interface StreakResponse {
  streak: {
    /** 연속 일수 — 오늘 활동 있으면 N (>=1), 없으면 0 (Q4=A 침묵 패턴) */
    current: number;
    /** 가장 최근 활동일 (KST). 활동 0회면 null */
    lastActivityDate: string | null;
  };
  /** 365일 heatmap — count=0 인 날도 포함 (정확히 365 entries) */
  heatmap: { date: string; count: number }[];
  /** 지원 카드 status 분포 (deleted_at IS NULL 만) */
  statusDistribution: { status: ApplicationStatus; count: number }[];
}

interface CacheEntry {
  data: StreakResponse;
  expiresAt: number;
}

/**
 * W3 — Dashboard 통합 streak + 365일 heatmap + status 분포.
 *
 * 통합 streak (CEO Q1=B):
 *   - 사용자가 의식적으로 한 액션 1개라도 있는 KST 일자 = streak +1
 *   - 5 source UNION ALL → KST DATE_TRUNC → 일자 distinct
 *
 * source list (AI 재활성화 시 +2 — `company/07_ops/ai-features-disabled.md` 명시):
 *   - activity_logs.created_at (활동일지 로그)
 *   - activity_reflections.created_at (회고)
 *   - applications.created_at (지원 카드 추가)
 *   - applications.updated_at (지원 카드 편집)
 *   - daily_notes.created_at (캘린더 할 일·시간 슬롯)
 *   // 🔓 AI 재활성화 시 주석 해제:
 *   // - coverletters.updated_at
 *   // - interview_prep_sessions.created_at
 *
 * 캐시: 5분 in-memory (사용자별, dashboard polling 차단)
 * KST 처리: 모든 timestamp 를 `AT TIME ZONE 'Asia/Seoul'` 후 DATE 추출
 */
@Injectable()
export class StreakService {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly HEATMAP_DAYS = 365;

  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
  ) {}

  async getDashboardStreak(userId: string): Promise<StreakResponse> {
    const now = Date.now();
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > now) return cached.data;

    const [activeDates, statusDistribution] = await Promise.all([
      this.fetchActiveDates(userId),
      this.fetchStatusDistribution(userId),
    ]);

    const heatmap = this.buildHeatmap(activeDates);
    const streak = this.calculateStreak(activeDates);

    const data: StreakResponse = { streak, heatmap, statusDistribution };
    this.cache.set(userId, { data, expiresAt: now + this.CACHE_TTL_MS });
    return data;
  }

  /**
   * 5 source UNION ALL → KST 일자별 count.
   * Map<'YYYY-MM-DD', count> 반환 (해당 일자에 active 한 event 수, dedup 없는 raw count).
   */
  private async fetchActiveDates(userId: string): Promise<Map<string, number>> {
    // raw query — TypeORM QueryBuilder 의 UNION ALL 지원 한계로 raw 사용 (parameterized)
    const sql = `
      SELECT date::text, COUNT(*)::int AS count FROM (
        SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS date
        FROM activity_logs WHERE user_id = $1
        UNION ALL
        SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS date
        FROM activity_reflections WHERE user_id = $1
        UNION ALL
        SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS date
        FROM applications WHERE user_id = $1 AND deleted_at IS NULL
        UNION ALL
        SELECT (updated_at AT TIME ZONE 'Asia/Seoul')::date AS date
        FROM applications WHERE user_id = $1 AND deleted_at IS NULL
        UNION ALL
        SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS date
        FROM daily_notes WHERE user_id = $1
        -- 🔓 AI 재활성화 시 추가:
        -- UNION ALL SELECT (updated_at AT TIME ZONE 'Asia/Seoul')::date FROM coverletters WHERE user_id = $1
        -- UNION ALL SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date FROM interview_prep_sessions WHERE user_id = $1
      ) AS events
      WHERE date >= (NOW() AT TIME ZONE 'Asia/Seoul')::date - INTERVAL '${this.HEATMAP_DAYS - 1} days'
        AND date <= (NOW() AT TIME ZONE 'Asia/Seoul')::date
      GROUP BY date
    `;
    const rows: { date: string; count: number }[] = await this.appRepo.query(
      sql,
      [userId],
    );
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.date, row.count);
    }
    return map;
  }

  /** 지원 카드 status 분포 (deleted_at IS NULL, is_sample 무관 — 사용자 실제 카드만 보고 싶으면 후속 필터) */
  private async fetchStatusDistribution(
    userId: string,
  ): Promise<{ status: ApplicationStatus; count: number }[]> {
    const rows = await this.appRepo
      .createQueryBuilder('a')
      .select('a.status', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .where('a.user_id = :userId', { userId })
      .andWhere('a.deleted_at IS NULL')
      .groupBy('a.status')
      .getRawMany<{ status: ApplicationStatus; count: number }>();
    return rows;
  }

  /**
   * 365 entries heatmap — 365일 전 ~ 오늘. activeDates Map 에 없는 날은 count=0.
   * KST 기준 — Node.js Date 의 UTC 처리 회피 위해 raw SQL 결과의 date 문자열 그대로 사용.
   */
  private buildHeatmap(
    activeDates: Map<string, number>,
  ): { date: string; count: number }[] {
    const result: { date: string; count: number }[] = [];
    const todayKst = this.todayKstString();
    for (let i = this.HEATMAP_DAYS - 1; i >= 0; i--) {
      const date = this.addDays(todayKst, -i);
      result.push({ date, count: activeDates.get(date) ?? 0 });
    }
    return result;
  }

  /**
   * 현재 streak 계산:
   *   - 오늘 KST 에 활동 있으면 → 어제·그제 ... 연속 카운트
   *   - 오늘 없으면 → current=0 (Q4=A 침묵 패턴), lastActivityDate 는 가장 최근 활동일
   */
  private calculateStreak(activeDates: Map<string, number>): {
    current: number;
    lastActivityDate: string | null;
  } {
    const todayKst = this.todayKstString();

    // 오늘 활동 없으면 current=0
    if (!activeDates.has(todayKst)) {
      // lastActivityDate = 가장 최근 활동일 (있으면)
      let last: string | null = null;
      for (let i = 1; i <= this.HEATMAP_DAYS; i++) {
        const date = this.addDays(todayKst, -i);
        if (activeDates.has(date)) {
          last = date;
          break;
        }
      }
      return { current: 0, lastActivityDate: last };
    }

    // 오늘부터 역방향 연속 카운트
    let count = 0;
    for (let i = 0; i < this.HEATMAP_DAYS; i++) {
      const date = this.addDays(todayKst, -i);
      if (activeDates.has(date)) {
        count++;
      } else {
        break;
      }
    }
    return { current: count, lastActivityDate: todayKst };
  }

  /** KST 오늘 'YYYY-MM-DD'. Date 의 UTC 변환 회피 — Intl.DateTimeFormat 으로 명시 */
  private todayKstString(): string {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date()); // 'YYYY-MM-DD'
  }

  /** 'YYYY-MM-DD' + N (negative OK). 순수 문자열 산술 (UTC 변환 0회) */
  private addDays(yyyymmdd: string, delta: number): string {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    // Date.UTC 사용해서 timezone 영향 X
    const epoch = Date.UTC(y, m - 1, d) + delta * 86400000;
    const dt = new Date(epoch);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  /** 테스트·dev 용 — 캐시 강제 무효 */
  invalidateCache(userId?: string): void {
    if (userId) this.cache.delete(userId);
    else this.cache.clear();
  }
}
