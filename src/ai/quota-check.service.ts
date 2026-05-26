import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { AbuserBanService } from './abuser-ban.service';
import {
  FeatureQuotaConfig,
  type QuotaTier,
} from './entities/feature-quota-config.entity';
import { LlmCallLog, type LlmFeature } from './entities/llm-call-log.entity';

/**
 * F6 PR 2 Phase 1 — 모든 LLM caller 가 호출하는 단일 quota 진입점.
 *
 * **memory `feedback_admin_quota_control` 절대 원칙**:
 * - 모든 LLM feature 는 admin 페이지에서 100% 통제 가능해야 함
 * - 신규 caller 가 본 service 를 호출하지 않으면 admin 통제 우회 (절대 금지)
 *
 * **5단계 체크** (순서대로):
 * 1. user.tier 조회
 * 2. feature_quota_configs WHERE feature, tier 조회 (없으면 fallback default + WARN)
 * 3. enabled=false → blocked (FEATURE_DISABLED, kill switch)
 * 4. user_ai_quotas (PR 1, abuser ban) override → effectiveDayLimit = min(config.dayLimit, override.dailyCapOverride)
 * 5. 최근 24h ok+retry_parsing 카운트 ≥ effectiveDayLimit → blocked (DAY_LIMIT)
 * 6. 이번 달 카운트 ≥ config.monthLimit → blocked (MONTH_LIMIT)
 * 7. 마지막 ok 호출 + cooldownSeconds > now → blocked (COOLDOWN, nextAvailableAt)
 * 8. OK
 *
 * **캐시 X** — 매 호출 DB 조회 (config + count + 마지막 호출). 10ms 추가 수용.
 * admin 변경 즉시 효과 보장 (캐시 stale 차단).
 */

export type QuotaBlockedCode =
  | 'FEATURE_DISABLED' // admin kill switch
  | 'DAY_LIMIT'
  | 'MONTH_LIMIT'
  | 'COOLDOWN';

export type QuotaCheckResult =
  | { blocked: false }
  | {
      blocked: true;
      code: QuotaBlockedCode;
      reason: string;
      nextAvailableAt?: Date;
    };

/**
 * config row 누락 시 fallback. memory 원칙: 새 feature 추가하면 마이그레이션 row 같이 INSERT.
 * 만약 누락 시 보수적 default 적용 + WARN 로그 (admin 이 `/ops/ai-quotas` 에서 "config 누락" 배지 확인).
 */
const FALLBACK_CONFIG = {
  dayLimit: 100,
  monthLimit: 1000,
  cooldownSeconds: 60,
  enabled: true,
} as const;

@Injectable()
export class QuotaCheckService {
  private readonly logger = new Logger(QuotaCheckService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(FeatureQuotaConfig)
    private readonly configRepo: Repository<FeatureQuotaConfig>,
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
    @Inject(forwardRef(() => AbuserBanService))
    private readonly abuserBan: AbuserBanService,
  ) {}

  async checkAndPrepare(
    userId: string,
    feature: LlmFeature,
  ): Promise<QuotaCheckResult> {
    // ── 1. user.tier 조회 ──
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'tier'],
    });
    const tier: QuotaTier = user?.tier ?? 'free';

    // ── 2. config 조회 (없으면 fallback) ──
    const config = await this.configRepo.findOne({
      where: { feature, tier },
    });
    const effective = config
      ? {
          dayLimit: config.dayLimit,
          monthLimit: config.monthLimit,
          cooldownSeconds: config.cooldownSeconds,
          enabled: config.enabled,
        }
      : (() => {
          this.logger.warn(
            `feature_quota_configs row missing (feature=${feature}, tier=${tier}) → fallback default`,
          );
          return FALLBACK_CONFIG;
        })();

    // ── 3. kill switch ──
    if (!effective.enabled) {
      return {
        blocked: true,
        code: 'FEATURE_DISABLED',
        reason: '관리자에 의해 일시 중단된 기능이에요. 곧 복구돼요.',
      };
    }

    // ── 4. user_ai_quotas (PR 1, abuser ban) override 적용 ──
    const override = await this.abuserBan.getActiveOverride(userId);
    const effectiveDayLimit =
      override?.dailyCapOverride != null
        ? Math.min(effective.dayLimit, override.dailyCapOverride)
        : effective.dayLimit;

    // ── 5. day 카운트 ──
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const baseWhere = {
      userId,
      feature,
      status: In(['ok', 'retry_parsing']),
    };
    const dayCount = await this.logRepo.count({
      where: { ...baseWhere, createdAt: Between(since24h, now) },
    });
    if (dayCount >= effectiveDayLimit) {
      return {
        blocked: true,
        code: 'DAY_LIMIT',
        reason: `오늘 사용 한도 ${effectiveDayLimit}회를 모두 사용했어요. 내일 다시 시도해 주세요.`,
      };
    }

    // ── 6. month 카운트 ──
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const monthCount = await this.logRepo.count({
      where: { ...baseWhere, createdAt: Between(monthStart, monthEnd) },
    });
    if (monthCount >= effective.monthLimit) {
      return {
        blocked: true,
        code: 'MONTH_LIMIT',
        reason: `이번 달 사용 한도 ${effective.monthLimit}회를 모두 사용했어요.`,
      };
    }

    // ── 7. cooldown ──
    if (effective.cooldownSeconds > 0) {
      const cooldownStart = new Date(
        now.getTime() - effective.cooldownSeconds * 1000,
      );
      const recent = await this.logRepo.findOne({
        where: {
          userId,
          feature,
          status: In(['ok', 'retry_parsing']),
          createdAt: Between(cooldownStart, now),
        },
        order: { createdAt: 'DESC' },
      });
      if (recent) {
        const nextAvailableAt = new Date(
          recent.createdAt.getTime() + effective.cooldownSeconds * 1000,
        );
        const secondsLeft = Math.ceil(
          (nextAvailableAt.getTime() - now.getTime()) / 1000,
        );
        return {
          blocked: true,
          code: 'COOLDOWN',
          reason: `다음 사용까지 ${secondsLeft}초 남았어요.`,
          nextAvailableAt,
        };
      }
    }

    // ── 8. OK ──
    return { blocked: false };
  }

  /**
   * GET /me/ai-quotas 응답용 — 사용자 현재 본인 기준 모든 feature 의 한도·사용량.
   * frontend `<AiQuotaChip />` 가 사용.
   */
  async getMyQuotas(userId: string): Promise<
    Array<{
      feature: LlmFeature;
      enabled: boolean;
      dayUsed: number;
      dayLimit: number;
      monthUsed: number;
      monthLimit: number;
      cooldownSeconds: number;
      nextAvailableAt: string | null;
    }>
  > {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'tier'],
    });
    const tier: QuotaTier = user?.tier ?? 'free';
    const configs = await this.configRepo.find({ where: { tier } });

    const override = await this.abuserBan.getActiveOverride(userId);
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const results = await Promise.all(
      configs.map(async (c) => {
        const baseWhere = {
          userId,
          feature: c.feature,
          status: In(['ok', 'retry_parsing']),
        };
        const [dayUsed, monthUsed, recent] = await Promise.all([
          this.logRepo.count({
            where: { ...baseWhere, createdAt: Between(since24h, now) },
          }),
          this.logRepo.count({
            where: { ...baseWhere, createdAt: Between(monthStart, monthEnd) },
          }),
          this.logRepo.findOne({
            where: baseWhere,
            order: { createdAt: 'DESC' },
          }),
        ]);
        const effectiveDayLimit =
          override?.dailyCapOverride != null
            ? Math.min(c.dayLimit, override.dailyCapOverride)
            : c.dayLimit;
        const nextAvailableAt =
          recent && c.cooldownSeconds > 0
            ? new Date(recent.createdAt.getTime() + c.cooldownSeconds * 1000)
            : null;
        const nextStr =
          nextAvailableAt && nextAvailableAt > now
            ? nextAvailableAt.toISOString()
            : null;
        return {
          feature: c.feature,
          enabled: c.enabled,
          dayUsed,
          dayLimit: effectiveDayLimit,
          monthUsed,
          monthLimit: c.monthLimit,
          cooldownSeconds: c.cooldownSeconds,
          nextAvailableAt: nextStr,
        };
      }),
    );

    return results;
  }
}
