import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmCallLog, type LlmFeature } from './entities/llm-call-log.entity';
import { AlertThresholds } from '../admin/entities/alert-thresholds.entity';

/**
 * AI cost guard — per-user / per-feature daily USD cost cap.
 *
 * **목적**: 코인 차단 외 USD cost 직접 cap (코인 외 추가 가드).
 * 모델 비용이 예상보다 비싸지면 (token 폭증·model 가격 변동) 코인 차감만으로 부족 — USD cap 으로 hard stop.
 *
 * **흐름**:
 * 1. LlmService.call() 진입 시 `check(userId, feature)` 호출
 * 2. 오늘 00:00 KST 부터 지금까지 user 의 (모든 feature 합산 cost) + (해당 feature cost) 조회
 * 3. alert_thresholds 의 `perUserDailyCostUsd` / `perFeatureDailyCostUsd` 와 비교
 * 4. 초과 시 BlockedCostQuotaError throw → caller 가 `preBlockedStatus: 'blocked_cost_quota'` 전달
 *
 * **캐시 전략**:
 * - alert_thresholds 는 admin 변경 시점에만 update — 메모리 캐시 5분 (TTL)
 * - 일일 cost 합계는 매 호출마다 LLM_call_logs 쿼리 (정확성 우선)
 * - 호출량이 많아지면 후속 PR 에서 Redis 도입
 *
 * **edge**:
 * - alert_thresholds 0건 (첫 운영) → cap 무제한 (호출 통과)
 * - thresholds.enabled = false → guard skip (운영 중 kill switch)
 */
@Injectable()
export class CostGuardService {
  private readonly logger = new Logger(CostGuardService.name);
  private cachedThresholds: AlertThresholds | null = null;
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5분

  constructor(
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
    @InjectRepository(AlertThresholds)
    private readonly thresholdRepo: Repository<AlertThresholds>,
  ) {}

  private async getThresholds(): Promise<AlertThresholds | null> {
    if (this.cachedThresholds && Date.now() < this.cacheExpiresAt) {
      return this.cachedThresholds;
    }
    const t = await this.thresholdRepo.findOne({ where: { id: 1 } });
    this.cachedThresholds = t;
    this.cacheExpiresAt = Date.now() + this.CACHE_TTL_MS;
    return t;
  }

  /** admin 변경 시 호출 — cache 즉시 무효화 */
  invalidate(): void {
    this.cachedThresholds = null;
    this.cacheExpiresAt = 0;
  }

  /**
   * 오늘 00:00 KST 의 UTC 시각 계산.
   * KST = UTC+9. 오늘 00:00 KST = 어제 15:00 UTC (KST 기준 오전 0시 = UTC 전날 15시).
   */
  private startOfTodayKstUtc(): Date {
    const now = new Date();
    const kstOffsetMs = 9 * 3600 * 1000;
    const kstNow = new Date(now.getTime() + kstOffsetMs);
    kstNow.setUTCHours(0, 0, 0, 0);
    return new Date(kstNow.getTime() - kstOffsetMs);
  }

  /**
   * 오늘 KST 기준 user 의 cost — { userTotal, featureTotal }.
   * 성공 호출 (status='ok') + retry_parsing 제외 (tokens=0, cost=0 이라 합산 무관 단 명시).
   */
  async getUserDailyCost(
    userId: string,
    feature: LlmFeature,
  ): Promise<{ userTotal: number; featureTotal: number }> {
    const from = this.startOfTodayKstUtc();
    const rows = await this.logRepo
      .createQueryBuilder('l')
      .select('l.feature', 'feature')
      .addSelect('SUM(l.cost_usd)', 'cost')
      .where('l.user_id = :userId', { userId })
      .andWhere('l.created_at >= :from', { from })
      .andWhere("l.status = 'ok'")
      .groupBy('l.feature')
      .getRawMany<{ feature: LlmFeature; cost: string }>();

    let userTotal = 0;
    let featureTotal = 0;
    for (const r of rows) {
      const c = parseFloat(r.cost ?? '0');
      userTotal += c;
      if (r.feature === feature) featureTotal = c;
    }
    return { userTotal, featureTotal };
  }

  /**
   * cost guard check. 초과 시 blocked, 통과 시 ok.
   *
   * @returns `{ blocked: true, reason }` if cap 도달, else `{ blocked: false, ... }`
   */
  async check(
    userId: string,
    feature: LlmFeature,
  ): Promise<
    | {
        blocked: true;
        reason: string;
        currentUserTotal: number;
        currentFeatureTotal: number;
        perUserCap: number;
        perFeatureCap: number;
      }
    | {
        blocked: false;
        currentUserTotal: number;
        currentFeatureTotal: number;
        perUserCap: number;
        perFeatureCap: number;
      }
  > {
    const thresholds = await this.getThresholds();
    if (!thresholds || !thresholds.enabled) {
      // guard kill switch 또는 미설정 → 통과
      return {
        blocked: false,
        currentUserTotal: 0,
        currentFeatureTotal: 0,
        perUserCap: Infinity,
        perFeatureCap: Infinity,
      };
    }

    const perUserCap = Number(thresholds.perUserDailyCostUsd);
    const perFeatureCap = Number(thresholds.perFeatureDailyCostUsd);
    const { userTotal, featureTotal } = await this.getUserDailyCost(
      userId,
      feature,
    );

    if (userTotal >= perUserCap) {
      return {
        blocked: true,
        reason: `per-user daily cost cap 도달 (${userTotal.toFixed(4)} / ${perUserCap})`,
        currentUserTotal: userTotal,
        currentFeatureTotal: featureTotal,
        perUserCap,
        perFeatureCap,
      };
    }
    if (featureTotal >= perFeatureCap) {
      return {
        blocked: true,
        reason: `per-feature daily cost cap 도달 (${feature}: ${featureTotal.toFixed(4)} / ${perFeatureCap})`,
        currentUserTotal: userTotal,
        currentFeatureTotal: featureTotal,
        perUserCap,
        perFeatureCap,
      };
    }

    return {
      blocked: false,
      currentUserTotal: userTotal,
      currentFeatureTotal: featureTotal,
      perUserCap,
      perFeatureCap,
    };
  }
}
