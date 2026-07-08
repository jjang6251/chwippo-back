import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import {
  startOfTodayKst,
  startOfKstWeek,
  startOfMonthKst,
  startOfNextMonthKst,
  startOfQuarterKst,
  startOfNextQuarterKst,
  startOfYearKst,
  startOfNextYearKst,
} from '../common/datetime';

const DAY_MS = 24 * 60 * 60 * 1000;

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

export interface UsageMetrics {
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
   * period 별 KST 캘린더 범위 계산. from/to 미지정 시 현재 KST period 의 [시작, 다음 시작).
   *
   * **TZ 버그 수정**: 이전 구현은 `new Date()` + `setDate/setMonth/getFullYear`
   * (서버 로컬) 연산이라 운영(Railway=UTC)에서 경계가 KST 자정/월초와 최대 9시간
   * 어긋났다. 이제 모든 경계를 `common/datetime` (Intl 기반 KST) 로 고정 →
   * 서버 OS TZ 무관 정합성 보장. day/week 는 KST DST 없어 ms 산술 안전.
   *
   * 반환 shape 및 half-open(`>= from AND < to`) 비교 규약 유지.
   */
  computeRange(
    period: Period,
    from?: Date,
    to?: Date,
  ): { from: Date; to: Date; previousFrom: Date; previousTo: Date } {
    const { start, next } = this.currentKstPeriod(period);
    const computedFrom = from ?? start;
    const computedTo = to ?? next;

    if (computedFrom.getTime() > computedTo.getTime()) {
      throw new BadRequestException('from 은 to 보다 과거여야 합니다.');
    }

    // 전기 동기 범위 (current 길이 만큼 past). computedFrom 이 KST 경계라
    // previous 도 자동으로 KST 정합.
    const lengthMs = computedTo.getTime() - computedFrom.getTime();
    const previousTo = new Date(computedFrom.getTime());
    const previousFrom = new Date(computedFrom.getTime() - lengthMs);

    return { from: computedFrom, to: computedTo, previousFrom, previousTo };
  }

  /** 현재 KST 캘린더 period 의 [시작, 다음 시작). half-open 상한용. */
  private currentKstPeriod(period: Period): { start: Date; next: Date } {
    switch (period) {
      case 'day': {
        const start = startOfTodayKst();
        return { start, next: new Date(start.getTime() + DAY_MS) };
      }
      case 'week': {
        const start = startOfKstWeek();
        return { start, next: new Date(start.getTime() + 7 * DAY_MS) };
      }
      case 'month':
        return { start: startOfMonthKst(), next: startOfNextMonthKst() };
      case 'quarter':
        return { start: startOfQuarterKst(), next: startOfNextQuarterKst() };
      case 'year':
        return { start: startOfYearKst(), next: startOfNextYearKst() };
    }
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
