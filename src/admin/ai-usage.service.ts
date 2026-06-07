import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';

/**
 * PR_B2 Phase 2 — admin AI 사용량·비용 추적 (Q14 일/주/월/분기/년 모두).
 *
 * 모든 LLM 호출은 llm_call_logs 에 audit (PR_B1). 본 서비스가 admin dashboard 용으로 집계.
 *
 * **메트릭**:
 * - 총 cost / 총 calls / cache hit rate / error rate
 * - feature 별 cost / model 별 cost / user 별 cost (top N)
 * - 전기 동기 비교 (current / previous / deltaPct)
 *
 * **KST 기준** (memory `feedback_kst_local_date`):
 * - period 의 from/to 는 KST 시각. 단순화 위해 UTC offset 없이 직접 변환.
 */

export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';

const VALID_PERIODS: Period[] = ['day', 'week', 'month', 'quarter', 'year'];

interface UsageMetrics {
  period: Period;
  from: string;
  to: string;
  totalCostUsd: number;
  totalCalls: number;
  cacheHitRate: number; // 0..1
  errorRate: number; // 0..1
  delta: {
    previousCostUsd: number;
    previousCalls: number;
    costDeltaPct: number; // (cur - prev) / prev * 100. prev=0 시 Infinity → -1 (신규)
    callsDeltaPct: number;
  };
}

@Injectable()
export class AiUsageService {
  constructor(
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
  ) {}

  /**
   * period 별 범위 계산. from/to 미지정 시 period 기반 default (최근 1 period).
   * KST 기준 — `dayjs` 미사용, 단순 Date 연산.
   */
  computeRange(
    period: Period,
    from?: Date,
    to?: Date,
  ): { from: Date; to: Date; previousFrom: Date; previousTo: Date } {
    const now = new Date();
    const computedTo = to ?? now;
    let computedFrom = from;

    if (!computedFrom) {
      const f = new Date(computedTo);
      switch (period) {
        case 'day':
          f.setDate(f.getDate() - 1);
          break;
        case 'week':
          f.setDate(f.getDate() - 7);
          break;
        case 'month':
          f.setMonth(f.getMonth() - 1);
          break;
        case 'quarter':
          f.setMonth(f.getMonth() - 3);
          break;
        case 'year':
          f.setFullYear(f.getFullYear() - 1);
          break;
      }
      computedFrom = f;
    }

    if (computedFrom.getTime() > computedTo.getTime()) {
      throw new BadRequestException('from 은 to 보다 과거여야 합니다.');
    }

    // 전기 동기 범위 (current 길이 만큼 past)
    const lengthMs = computedTo.getTime() - computedFrom.getTime();
    const previousTo = new Date(computedFrom.getTime());
    const previousFrom = new Date(computedFrom.getTime() - lengthMs);

    return { from: computedFrom, to: computedTo, previousFrom, previousTo };
  }

  async getUsageMetrics(
    period: Period,
    fromIso?: string,
    toIso?: string,
  ): Promise<UsageMetrics> {
    if (!VALID_PERIODS.includes(period)) {
      throw new BadRequestException(
        `period 는 ${VALID_PERIODS.join('|')} 중 하나`,
      );
    }
    const range = this.computeRange(
      period,
      fromIso ? new Date(fromIso) : undefined,
      toIso ? new Date(toIso) : undefined,
    );

    const [current, previous] = await Promise.all([
      this.aggregate(range.from, range.to),
      this.aggregate(range.previousFrom, range.previousTo),
    ]);

    const costDeltaPct =
      previous.totalCostUsd === 0
        ? current.totalCostUsd === 0
          ? 0
          : 100
        : ((current.totalCostUsd - previous.totalCostUsd) /
            previous.totalCostUsd) *
          100;
    const callsDeltaPct =
      previous.totalCalls === 0
        ? current.totalCalls === 0
          ? 0
          : 100
        : ((current.totalCalls - previous.totalCalls) / previous.totalCalls) *
          100;

    return {
      period,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      totalCostUsd: current.totalCostUsd,
      totalCalls: current.totalCalls,
      cacheHitRate: current.cacheHitRate,
      errorRate: current.errorRate,
      delta: {
        previousCostUsd: previous.totalCostUsd,
        previousCalls: previous.totalCalls,
        costDeltaPct,
        callsDeltaPct,
      },
    };
  }

  private async aggregate(
    from: Date,
    to: Date,
  ): Promise<{
    totalCostUsd: number;
    totalCalls: number;
    cacheHitRate: number;
    errorRate: number;
  }> {
    const rows = await this.logRepo
      .createQueryBuilder('log')
      .select([
        'SUM(log.cost_usd) AS cost_sum',
        'COUNT(*) AS total_calls',
        'SUM(CASE WHEN log.cache_read_tokens > 0 THEN 1 ELSE 0 END) AS cache_hits',
        "SUM(CASE WHEN log.status = 'error' THEN 1 ELSE 0 END) AS errors",
      ])
      .where('log.created_at >= :from AND log.created_at < :to', { from, to })
      .getRawOne<{
        cost_sum: string | null;
        total_calls: string;
        cache_hits: string;
        errors: string;
      }>();

    const totalCalls = parseInt(rows?.total_calls ?? '0', 10);
    const cacheHits = parseInt(rows?.cache_hits ?? '0', 10);
    const errors = parseInt(rows?.errors ?? '0', 10);

    return {
      totalCostUsd: parseFloat(rows?.cost_sum ?? '0'),
      totalCalls,
      cacheHitRate: totalCalls > 0 ? cacheHits / totalCalls : 0,
      errorRate: totalCalls > 0 ? errors / totalCalls : 0,
    };
  }

  async getTopUsers(
    period: Period,
    limit = 20,
  ): Promise<
    Array<{
      userId: string;
      nickname: string | null;
      totalCostUsd: number;
      totalCalls: number;
    }>
  > {
    const range = this.computeRange(period);
    return await this.logRepo
      .createQueryBuilder('log')
      .leftJoin('users', 'u', 'u.id = log.user_id')
      .select([
        'log.user_id AS "userId"',
        'u.nickname AS nickname',
        'SUM(log.cost_usd) AS "totalCostUsd"',
        'COUNT(*) AS "totalCalls"',
      ])
      .where('log.created_at >= :from AND log.created_at < :to', {
        from: range.from,
        to: range.to,
      })
      .groupBy('log.user_id')
      .addGroupBy('u.nickname')
      .orderBy('"totalCostUsd"', 'DESC')
      .limit(Math.min(limit, 100))
      .getRawMany<{
        userId: string;
        nickname: string | null;
        totalCostUsd: string;
        totalCalls: string;
      }>()
      .then((rows) =>
        rows.map((r) => ({
          userId: r.userId,
          nickname: r.nickname,
          totalCostUsd: parseFloat(r.totalCostUsd),
          totalCalls: parseInt(r.totalCalls, 10),
        })),
      );
  }

  async getByFeature(
    period: Period,
  ): Promise<
    Array<{ feature: string; totalCostUsd: number; totalCalls: number }>
  > {
    const range = this.computeRange(period);
    return await this.logRepo
      .createQueryBuilder('log')
      .select([
        'log.feature AS feature',
        'SUM(log.cost_usd) AS "totalCostUsd"',
        'COUNT(*) AS "totalCalls"',
      ])
      .where('log.created_at >= :from AND log.created_at < :to', {
        from: range.from,
        to: range.to,
      })
      .groupBy('log.feature')
      .orderBy('"totalCostUsd"', 'DESC')
      .getRawMany<{
        feature: string;
        totalCostUsd: string;
        totalCalls: string;
      }>()
      .then((rows) =>
        rows.map((r) => ({
          feature: r.feature,
          totalCostUsd: parseFloat(r.totalCostUsd),
          totalCalls: parseInt(r.totalCalls, 10),
        })),
      );
  }

  async getByModel(
    period: Period,
  ): Promise<
    Array<{ model: string; totalCostUsd: number; totalCalls: number }>
  > {
    const range = this.computeRange(period);
    return await this.logRepo
      .createQueryBuilder('log')
      .select([
        'log.model AS model',
        'SUM(log.cost_usd) AS "totalCostUsd"',
        'COUNT(*) AS "totalCalls"',
      ])
      .where('log.created_at >= :from AND log.created_at < :to', {
        from: range.from,
        to: range.to,
      })
      .groupBy('log.model')
      .orderBy('"totalCostUsd"', 'DESC')
      .getRawMany<{ model: string; totalCostUsd: string; totalCalls: string }>()
      .then((rows) =>
        rows.map((r) => ({
          model: r.model,
          totalCostUsd: parseFloat(r.totalCostUsd),
          totalCalls: parseInt(r.totalCalls, 10),
        })),
      );
  }
}
