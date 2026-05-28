import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, Repository } from 'typeorm';
import { LlmCallLog } from './entities/llm-call-log.entity';

export interface AiUsageQuery {
  startDate?: string; // ISO date
  endDate?: string;
  feature?: string;
}

export interface AiUsageRow {
  userId: string;
  totalCalls: number;
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface AiUsageSummary {
  totalCalls: number;
  totalCostUsd: number;
  byFeature: Array<{
    feature: string;
    calls: number;
    costUsd: number;
  }>;
  byStatus: Array<{ status: string; count: number }>;
}

/** F6 PR 2 Phase 5.3 — v2 메트릭 응답 타입 */
export interface ByModelRow {
  provider: string;
  model: string;
  calls: number;
  costUsd: number;
}
export interface ByHourRow {
  hour: string; // ISO timestamptz (KST hour bucket)
  calls: number;
  costUsd: number;
}
export interface HallucinationRow {
  feature: string;
  total: number;
  redacted: number;
  ratio: number; // redacted / total (0~1)
}
export interface CacheHitRateResponse {
  noteSummary: { totalLogs: number; withSummary: number; ratio: number };
  companyResearch: {
    cacheRows: number;
    totalHits: number;
    avgHitsPerRow: number;
  };
}
export interface MonthEstimateResponse {
  monthStart: string;
  daysElapsed: number;
  daysInMonth: number;
  cumulativeCostUsd: number;
  estimatedMonthEndUsd: number;
}

@Injectable()
export class AdminAiUsageService {
  constructor(
    @InjectRepository(LlmCallLog)
    private readonly repo: Repository<LlmCallLog>,
    private readonly dataSource: DataSource,
  ) {}

  private parseRange(q: AiUsageQuery): { start: Date; end: Date } {
    const end = q.endDate ? new Date(q.endDate) : new Date();
    const start = q.startDate
      ? new Date(q.startDate)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { start, end };
  }

  async overview(q: AiUsageQuery): Promise<AiUsageSummary> {
    const { start, end } = this.parseRange(q);
    const qb = this.repo
      .createQueryBuilder('l')
      .where('l.created_at BETWEEN :start AND :end', { start, end });
    if (q.feature) qb.andWhere('l.feature = :feature', { feature: q.feature });

    const total = await qb
      .select(['COUNT(*) AS calls', 'COALESCE(SUM(l.cost_usd), 0) AS cost'])
      .getRawOne<{ calls: string; cost: string }>();

    const byFeature = await this.repo
      .createQueryBuilder('l')
      .select('l.feature', 'feature')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(l.cost_usd), 0)', 'cost')
      .where('l.created_at BETWEEN :start AND :end', { start, end })
      .groupBy('l.feature')
      .orderBy('cost', 'DESC')
      .getRawMany<{ feature: string; calls: string; cost: string }>();

    const byStatus = await this.repo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('l.created_at BETWEEN :start AND :end', { start, end })
      .groupBy('l.status')
      .getRawMany<{ status: string; count: string }>();

    return {
      totalCalls: Number(total?.calls ?? 0),
      totalCostUsd: Number(total?.cost ?? 0),
      byFeature: byFeature.map((r) => ({
        feature: r.feature,
        calls: Number(r.calls),
        costUsd: Number(r.cost),
      })),
      byStatus: byStatus.map((r) => ({
        status: r.status,
        count: Number(r.count),
      })),
    };
  }

  async byUser(q: AiUsageQuery): Promise<AiUsageRow[]> {
    const { start, end } = this.parseRange(q);
    const qb = this.repo
      .createQueryBuilder('l')
      .select('l.user_id', 'userId')
      .addSelect('COUNT(*)', 'totalCalls')
      .addSelect('COALESCE(SUM(l.cost_usd), 0)', 'totalCostUsd')
      .addSelect('COALESCE(SUM(l.prompt_tokens), 0)', 'totalPromptTokens')
      .addSelect(
        'COALESCE(SUM(l.completion_tokens), 0)',
        'totalCompletionTokens',
      )
      .where('l.created_at BETWEEN :start AND :end', { start, end })
      .groupBy('l.user_id')
      .orderBy('"totalCostUsd"', 'DESC');

    if (q.feature) qb.andWhere('l.feature = :feature', { feature: q.feature });

    const rows = await qb.getRawMany<{
      userId: string;
      totalCalls: string;
      totalCostUsd: string;
      totalPromptTokens: string;
      totalCompletionTokens: string;
    }>();

    return rows.map((r) => ({
      userId: r.userId,
      totalCalls: Number(r.totalCalls),
      totalCostUsd: Number(r.totalCostUsd),
      totalPromptTokens: Number(r.totalPromptTokens),
      totalCompletionTokens: Number(r.totalCompletionTokens),
    }));
  }

  async userDetail(userId: string, q: AiUsageQuery): Promise<LlmCallLog[]> {
    const { start, end } = this.parseRange(q);
    return this.repo.find({
      where: {
        userId,
        createdAt: Between(start, end),
      },
      order: { createdAt: 'DESC' },
      take: 500,
    });
  }

  // ── F6 PR 2 Phase 5.3 — v2 메트릭 ──

  /** provider × model 별 호출/비용. gpt-4o vs claude-haiku-4-5 비용 비교 */
  async byModel(q: AiUsageQuery): Promise<ByModelRow[]> {
    const { start, end } = this.parseRange(q);
    const qb = this.repo
      .createQueryBuilder('l')
      .select('l.provider', 'provider')
      .addSelect('l.model', 'model')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(l.cost_usd), 0)', 'cost')
      .where('l.created_at BETWEEN :start AND :end', { start, end })
      .andWhere("l.status IN ('ok', 'retry_parsing')")
      .groupBy('l.provider')
      .addGroupBy('l.model')
      .orderBy('cost', 'DESC');
    if (q.feature) qb.andWhere('l.feature = :feature', { feature: q.feature });

    const rows = await qb.getRawMany<{
      provider: string;
      model: string;
      calls: string;
      cost: string;
    }>();
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      calls: Number(r.calls),
      costUsd: Number(r.cost),
    }));
  }

  /** KST 시간 bucket 별 호출/비용. memory `feedback_kst_local_date` */
  async byHour(q: AiUsageQuery): Promise<ByHourRow[]> {
    const { start, end } = this.parseRange(q);
    const qb = this.repo
      .createQueryBuilder('l')
      .select(
        "date_trunc('hour', l.created_at AT TIME ZONE 'Asia/Seoul')",
        'hour',
      )
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(l.cost_usd), 0)', 'cost')
      .where('l.created_at BETWEEN :start AND :end', { start, end })
      .groupBy('hour')
      .orderBy('hour', 'ASC');
    if (q.feature) qb.andWhere('l.feature = :feature', { feature: q.feature });

    const rows = await qb.getRawMany<{
      hour: Date;
      calls: string;
      cost: string;
    }>();
    return rows.map((r) => ({
      hour:
        r.hour instanceof Date ? r.hour.toISOString() : String(r.hour),
      calls: Number(r.calls),
      costUsd: Number(r.cost),
    }));
  }

  /** feature 별 output_redacted=true 비율 — PII hallucination 감시 */
  async hallucinationStats(q: AiUsageQuery): Promise<HallucinationRow[]> {
    const { start, end } = this.parseRange(q);
    const rows = await this.repo
      .createQueryBuilder('l')
      .select('l.feature', 'feature')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        'COUNT(*) FILTER (WHERE l.output_redacted = TRUE)',
        'redacted',
      )
      .where('l.created_at BETWEEN :start AND :end', { start, end })
      .andWhere("l.status IN ('ok', 'retry_parsing')")
      .groupBy('l.feature')
      .orderBy('redacted', 'DESC')
      .getRawMany<{ feature: string; total: string; redacted: string }>();
    return rows.map((r) => {
      const total = Number(r.total);
      const redacted = Number(r.redacted);
      return {
        feature: r.feature,
        total,
        redacted,
        ratio: total === 0 ? 0 : redacted / total,
      };
    });
  }

  /**
   * 캐시 hit rate 2종 — note_summary 와 company_research.
   * - note_summary: activity_logs.note_summary 채워진 비율 (정확도 한계 — hash 매치 시 LLM 미호출이라 audit row 없음)
   * - company_research: cache row 평균 hit_count
   */
  async cacheHitRate(): Promise<CacheHitRateResponse> {
    const [ns, cr] = await Promise.all([
      this.dataSource.query<
        Array<{ total: string; with_summary: string }>
      >(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE note_summary IS NOT NULL) AS with_summary
           FROM activity_logs`,
      ),
      this.dataSource.query<
        Array<{ rows: string; total_hits: string }>
      >(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(hit_count), 0) AS total_hits
           FROM company_research_cache
          WHERE opt_out = FALSE`,
      ),
    ]);
    const nsTotal = Number(ns[0]?.total ?? 0);
    const nsWith = Number(ns[0]?.with_summary ?? 0);
    const crRows = Number(cr[0]?.rows ?? 0);
    const crHits = Number(cr[0]?.total_hits ?? 0);
    return {
      noteSummary: {
        totalLogs: nsTotal,
        withSummary: nsWith,
        ratio: nsTotal === 0 ? 0 : nsWith / nsTotal,
      },
      companyResearch: {
        cacheRows: crRows,
        totalHits: crHits,
        avgHitsPerRow: crRows === 0 ? 0 : crHits / crRows,
      },
    };
  }

  /** 이번 달 누적 비용 + 월말 추정 (오늘까지 누적 / 경과일수 × 31일) */
  async monthEstimate(): Promise<MonthEstimateResponse> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const daysInMonth = Math.round(
      (nextMonthStart.getTime() - monthStart.getTime()) / (24 * 60 * 60 * 1000),
    );
    const daysElapsed = Math.max(
      1,
      Math.ceil((now.getTime() - monthStart.getTime()) / (24 * 60 * 60 * 1000)),
    );
    const row = await this.repo
      .createQueryBuilder('l')
      .select('COALESCE(SUM(l.cost_usd), 0)', 'cost')
      .where('l.created_at >= :start AND l.created_at < :end', {
        start: monthStart,
        end: nextMonthStart,
      })
      .getRawOne<{ cost: string }>();
    const cumulativeCostUsd = Number(row?.cost ?? 0);
    const estimatedMonthEndUsd =
      (cumulativeCostUsd / daysElapsed) * daysInMonth;
    return {
      monthStart: monthStart.toISOString(),
      daysElapsed,
      daysInMonth,
      cumulativeCostUsd,
      estimatedMonthEndUsd,
    };
  }
}
