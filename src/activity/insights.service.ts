import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * F6 PR 1 Phase 3c — `GET /activity/insights` 서버 집계 응답.
 *
 * **단일 응답 + 5분 in-memory cache** (focus.md PR 1 명시):
 * - frontend 가 sub-tab 전환 시 N개 API 호출 대신 1개로 통합 → latency ↓
 * - 5분 cache TTL — 활동 로그 추가/수정 빈도가 시간 단위 이상이라 5분이면 충분
 * - cache 키 = userId (옵션 없는 V1). 옵션 추가 시 키 확장
 *
 * **집계 항목** (mock `#page-insights` 3596-3668 1:1):
 * - `strengths.byCl[]` — 자소서 매핑 6 카테고리별 빈도 (personality/background/job_competency/own_strength/collaboration/challenge)
 * - `strengths.byComps[]` — 역량 10종별 빈도 (technical/leadership/communication/planning/analytical/problem_solving/collaboration/creativity/responsibility/adaptability)
 * - `sources[]` — 사용자의 logs 중 자소서에 가장 많이 인용된 top N
 * - `heatmap[]` — 일별 활동 강도 (최근 365일)
 * - `trend[]` — 월별 활동 추이 (최근 12개월)
 *
 * **archived 제외** — archived_at IS NOT NULL 인 로그/회고는 집계에서 제외 (사용자가 의도적으로 숨김)
 */

export interface InsightsResponse {
  strengths: {
    byCl: Array<{ key: string; count: number }>;
    byComps: Array<{ key: string; count: number }>;
  };
  sources: Array<{
    logId: string;
    content: string;
    occurredAt: string;
    referencedByCount: number;
  }>;
  heatmap: Array<{ date: string; count: number }>;
  trend: Array<{ month: string; count: number }>;
  /** 캐시 hit 여부 (debug + 사용자 UI 가 "방금 갱신" 표시) */
  cached: boolean;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5분
const SOURCES_TOP_N = 10;
const HEATMAP_DAYS = 365;
const TREND_MONTHS = 12;

interface CacheEntry {
  data: Omit<InsightsResponse, 'cached'>;
  expiresAt: number;
}

@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async getInsights(userId: string): Promise<InsightsResponse> {
    const cacheKey = `insights:${userId}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { ...cached.data, cached: true };
    }

    const [strengths, sources, heatmap, trend] = await Promise.all([
      this.aggregateStrengths(userId),
      this.aggregateSources(userId),
      this.aggregateHeatmap(userId),
      this.aggregateTrend(userId),
    ]);

    const data: Omit<InsightsResponse, 'cached'> = {
      strengths,
      sources,
      heatmap,
      trend,
      generatedAt: new Date().toISOString(),
    };
    this.cache.set(cacheKey, { data, expiresAt: now + CACHE_TTL_MS });

    return { ...data, cached: false };
  }

  /** 캐시 무효화 — log/reflection 수정 시 caller 가 호출 (옵션, V1 은 미사용) */
  invalidate(userId: string): void {
    this.cache.delete(`insights:${userId}`);
  }

  // ── 집계 쿼리 ──

  private async aggregateStrengths(userId: string): Promise<{
    byCl: Array<{ key: string; count: number }>;
    byComps: Array<{ key: string; count: number }>;
  }> {
    // jsonb 배열 unnest → 그룹 카운트. archived 제외.
    const byClRows: Array<{ key: string; count: string }> =
      await this.dataSource.query(
        `SELECT jsonb_array_elements_text(cl) AS key, COUNT(*) AS count
         FROM activity_logs
         WHERE user_id = $1 AND archived_at IS NULL
         GROUP BY key
         ORDER BY count DESC`,
        [userId],
      );
    const byCompsRows: Array<{ key: string; count: string }> =
      await this.dataSource.query(
        `SELECT jsonb_array_elements_text(comps) AS key, COUNT(*) AS count
         FROM activity_logs
         WHERE user_id = $1 AND archived_at IS NULL
         GROUP BY key
         ORDER BY count DESC`,
        [userId],
      );
    return {
      byCl: byClRows.map((r) => ({ key: r.key, count: Number(r.count) })),
      byComps: byCompsRows.map((r) => ({ key: r.key, count: Number(r.count) })),
    };
  }

  private async aggregateSources(userId: string): Promise<
    Array<{
      logId: string;
      content: string;
      occurredAt: string;
      referencedByCount: number;
    }>
  > {
    // coverletter_source_refs 가 가장 많이 가리킨 본인 logs top N.
    // 본인 logs 만 (user_id 필터) + LEFT JOIN (참조 0건 log 도 포함 — V1 단순화: 참조 ≥1 만)
    const rows: Array<{
      log_id: string;
      content: string;
      occurred_at: Date;
      ref_count: string;
    }> = await this.dataSource.query(
      `SELECT al.id AS log_id, al.content, al.occurred_at, COUNT(csr.id) AS ref_count
       FROM activity_logs al
       INNER JOIN coverletter_source_refs csr ON csr.source_log_id = al.id
       WHERE al.user_id = $1 AND al.archived_at IS NULL
       GROUP BY al.id, al.content, al.occurred_at
       ORDER BY ref_count DESC, al.occurred_at DESC
       LIMIT $2`,
      [userId, SOURCES_TOP_N],
    );
    return rows.map((r) => ({
      logId: r.log_id,
      content: r.content,
      occurredAt:
        r.occurred_at instanceof Date
          ? r.occurred_at.toISOString().slice(0, 10)
          : String(r.occurred_at),
      referencedByCount: Number(r.ref_count),
    }));
  }

  private async aggregateHeatmap(
    userId: string,
  ): Promise<Array<{ date: string; count: number }>> {
    // 최근 N일 일별 활동 개수. archived 제외.
    const rows: Array<{ date: string; count: string }> =
      await this.dataSource.query(
        `SELECT occurred_at::text AS date, COUNT(*) AS count
         FROM activity_logs
         WHERE user_id = $1
           AND archived_at IS NULL
           AND occurred_at >= CURRENT_DATE - $2::int
         GROUP BY occurred_at
         ORDER BY occurred_at ASC`,
        [userId, HEATMAP_DAYS],
      );
    return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
  }

  private async aggregateTrend(
    userId: string,
  ): Promise<Array<{ month: string; count: number }>> {
    // 최근 N개월 월별 활동 개수.
    const rows: Array<{ month: string; count: string }> =
      await this.dataSource.query(
        `SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS month, COUNT(*) AS count
         FROM activity_logs
         WHERE user_id = $1
           AND archived_at IS NULL
           AND occurred_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' * ($2::int - 1)
         GROUP BY month
         ORDER BY month ASC`,
        [userId, TREND_MONTHS],
      );
    return rows.map((r) => ({ month: r.month, count: Number(r.count) }));
  }
}
