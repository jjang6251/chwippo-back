import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { DataSource } from 'typeorm';
import { TierConfig, type CoinTier } from './entities/tier-config.entity';
import { FeatureCoinMeta } from './entities/feature-coin-meta.entity';
import { UserCoinBalance } from './entities/user-coin-balance.entity';
import { UserPlanHistory } from './entities/user-plan-history.entity';
import type { LlmFeature } from './entities/llm-call-log.entity';
import { startOfNextMonthKst } from '../common/datetime';

/**
 * PR_B1 — 통합 코인 시스템.
 *
 * **흐름**:
 * 1. 호출 시작 전 — `canCharge(userId, feature)` — 추정 buffer 잔여 ≥ 진행 보장
 * 2. LLM 호출 후 — `charge(userId, feature, tokens...)` — 실제 코인 차감 + cost 계산
 * 3. 갱신 — `resetIfDue(userId)` (lazy) / Cron 매일 자정 KST (cron)
 *
 * **차감 정책**:
 * - status='ok' 만 차감 (caller 가 호출 안 함 → charge 안 함)
 * - charges_coins=false feature (회사조사·노트요약) → 차감 0
 * - COIN_SYSTEM_ENABLED=false env → 차감 0 (rollout 안전 가드)
 * - 마이너스 carry-over (잔여 음수 허용)
 *
 * **race-safe**:
 * - UPDATE balance = balance - X (PG single-row atomic)
 * - reset 도 UPDATE WHERE next_reset_at < NOW (atomic check)
 */
@Injectable()
export class CoinService {
  private readonly logger = new Logger(CoinService.name);

  // Haiku 4.5 단가 (USD per 1M tokens / per search)
  // input × 1.25 = cache_creation, input × 0.10 = cache_read (90% 할인)
  static readonly COST_PER_M = {
    input: 1.0,
    output: 5.0,
    cacheCreation: 1.25,
    cacheRead: 0.1,
    webSearch: 10_000, // $10 per 1000 = $0.01 per search → per 1M searches scale 일관성
  } as const;

  constructor(
    @InjectRepository(TierConfig)
    private readonly tierRepo: Repository<TierConfig>,
    @InjectRepository(FeatureCoinMeta)
    private readonly featureMetaRepo: Repository<FeatureCoinMeta>,
    @InjectRepository(UserCoinBalance)
    private readonly balanceRepo: Repository<UserCoinBalance>,
    @InjectRepository(UserPlanHistory)
    private readonly historyRepo: Repository<UserPlanHistory>,
    private readonly dataSource: DataSource,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // Token → Coin · Cost 계산 (Task 1 CRITICAL)
  // ──────────────────────────────────────────────────────────────

  /**
   * 정확한 cost 계산 (USD).
   * 모든 token 종류 + web_search 합산. 마진 보호의 핵심.
   */
  calculateCost(input: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    webSearchCount?: number;
  }): { totalUsd: number; breakdown: Record<string, number> } {
    const c = CoinService.COST_PER_M;
    const inputCost = (input.inputTokens / 1_000_000) * c.input;
    const outputCost = (input.outputTokens / 1_000_000) * c.output;
    const cacheCreationCost =
      ((input.cacheCreationTokens ?? 0) / 1_000_000) * c.cacheCreation;
    const cacheReadCost =
      ((input.cacheReadTokens ?? 0) / 1_000_000) * c.cacheRead;
    const webSearchCost = (input.webSearchCount ?? 0) * 0.01;

    return {
      totalUsd:
        inputCost +
        outputCost +
        cacheCreationCost +
        cacheReadCost +
        webSearchCost,
      breakdown: {
        input: inputCost,
        output: outputCost,
        cache_creation: cacheCreationCost,
        cache_read: cacheReadCost,
        web_search: webSearchCost,
      },
    };
  }

  /**
   * Token + web_search → 코인 환산 (0.1 단위 ceil).
   *
   * 1 코인 = 1K tokens 등가 (input 기준). output·cache·web_search 는
   * 단가 비율 따라 token-equivalent 환산.
   *
   * 단가 (per 1K equivalent tokens):
   * - input 1K = 1 코인 (기준)
   * - output 1K = 5 코인 (5× cost)
   * - cache_creation 1K = 1.25 코인
   * - cache_read 1K = 0.1 코인 (90% 할인)
   * - web_search 1회 ≈ $0.01 = output 2K cost = 10 코인
   */
  calculateCoin(input: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    webSearchCount?: number;
  }): number {
    const equivalentTokens =
      input.inputTokens +
      input.outputTokens * 5 +
      (input.cacheCreationTokens ?? 0) * 1.25 +
      (input.cacheReadTokens ?? 0) * 0.1 +
      (input.webSearchCount ?? 0) * 10_000; // 1 web_search = 10 코인 = 10,000 token-equivalent

    // 0.1 단위 ceil — 1523 tokens → 1.6 코인
    return Math.ceil(equivalentTokens / 100) / 10;
  }

  // ──────────────────────────────────────────────────────────────
  // canCharge (호출 시작 전 추정 check)
  // ──────────────────────────────────────────────────────────────

  /**
   * 호출 시작 전 — 추정 (평균 × 1.2) 잔여 ≥ 진행 보장.
   * COIN_SYSTEM_ENABLED=false 또는 charges_coins=false feature → 항상 통과.
   */
  async canCharge(
    userId: string,
    feature: LlmFeature,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (process.env.COIN_SYSTEM_ENABLED === 'false') return { ok: true };

    const meta = await this.featureMetaRepo.findOne({ where: { feature } });
    if (!meta?.chargesCoins) return { ok: true }; // 회사조사·노트요약 (우리 부담)

    // PR_B1c — fixed_coin_cost 우선 (token 환산 무시). NULL 이면 기존 avg × 1.2 buffer
    const estimate =
      meta.fixedCoinCost !== null
        ? meta.fixedCoinCost
        : Math.ceil(parseFloat(meta.avgCoinCost) * 1.2 * 10) / 10;

    const balance = await this.getBalanceWithLazyReset(userId);
    if (balance.balance < estimate) {
      return {
        ok: false,
        reason: `🪙 코인이 부족해요 (필요 ${estimate}코인, 잔여 ${balance.balance})`,
      };
    }
    return { ok: true };
  }

  // ──────────────────────────────────────────────────────────────
  // charge (실제 차감, atomic)
  // ──────────────────────────────────────────────────────────────

  /**
   * 호출 끝나면 실제 코인 차감 (status='ok' 만).
   * - charges_coins=false → 0 차감
   * - COIN_SYSTEM_ENABLED=false → 0 차감
   * - atomic UPDATE balance = balance - coinCost (마이너스 허용, race-safe)
   */
  async charge(
    userId: string,
    feature: LlmFeature,
    tokens: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
      webSearchCount?: number;
    },
  ): Promise<{
    coinCost: number;
    costUsd: number;
    breakdown: Record<string, number>;
  }> {
    const costInfo = this.calculateCost(tokens);

    if (process.env.COIN_SYSTEM_ENABLED === 'false') {
      return {
        coinCost: 0,
        costUsd: costInfo.totalUsd,
        breakdown: costInfo.breakdown,
      };
    }

    const meta = await this.featureMetaRepo.findOne({ where: { feature } });
    if (!meta?.chargesCoins) {
      return {
        coinCost: 0,
        costUsd: costInfo.totalUsd,
        breakdown: costInfo.breakdown,
      };
    }

    // PR_B1c — fixed_coin_cost 우선 (token 환산 무시). NULL 이면 기존 token 환산
    const coinCost =
      meta.fixedCoinCost !== null
        ? meta.fixedCoinCost
        : this.calculateCoin(tokens);
    if (coinCost === 0) {
      return {
        coinCost: 0,
        costUsd: costInfo.totalUsd,
        breakdown: costInfo.breakdown,
      };
    }

    // atomic UPDATE — 마이너스 허용 (carry-over 정책)
    await this.dataSource.query(
      'UPDATE user_coin_balances SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
      [coinCost, userId],
    );

    return {
      coinCost,
      costUsd: costInfo.totalUsd,
      breakdown: costInfo.breakdown,
    };
  }

  /**
   * PR_B1c CTO 검토 H1 — 차감 후 후속 작업 실패 시 환불 (좀비 in_progress 방지).
   *
   * **호출 시점**: ApplicationsService.generateCoverletter 의 status='completed' UPDATE 실패 시
   *   (코인은 이미 차감됐는데 status 가 'in_progress' 영구 잔류 = 좀비).
   *
   * **동작**: feature 의 fixed_coin_cost 가져와 그만큼 balance += amount.
   *   fixed_coin_cost NULL 인 feature → caller 가 직접 amount 전달 필요 (현재 미지원).
   *
   * **best-effort**: refund 자체 실패는 logger.error 만 + throw 안 함 (caller 가 throw 처리).
   */
  async refund(
    userId: string,
    feature: LlmFeature,
    reason: string,
  ): Promise<{ refunded: number }> {
    if (process.env.COIN_SYSTEM_ENABLED === 'false') return { refunded: 0 };
    const meta = await this.featureMetaRepo.findOne({ where: { feature } });
    if (!meta?.chargesCoins || meta.fixedCoinCost === null) {
      return { refunded: 0 };
    }
    const amount = meta.fixedCoinCost;
    await this.dataSource.query(
      'UPDATE user_coin_balances SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
      [amount, userId],
    );
    this.logger.log(
      `[CoinService.refund] user=${userId} feature=${feature} amount=${amount} reason="${reason}"`,
    );
    return { refunded: amount };
  }

  // ──────────────────────────────────────────────────────────────
  // Reset (lazy + cron)
  // ──────────────────────────────────────────────────────────────

  /**
   * lazy reset — next_reset_at < NOW 이면 reset 후 balance 반환.
   * 신규 user (balance row 없음) → 자동 생성 + 150 부여.
   */
  async getBalanceWithLazyReset(
    userId: string,
  ): Promise<{ balance: number; tier: CoinTier }> {
    const row = await this.balanceRepo.findOne({ where: { userId } });
    if (!row) {
      return this.createInitialBalance(userId);
    }
    if (row.nextResetAt < new Date()) {
      return this.reset(userId);
    }
    return { balance: parseFloat(row.balance), tier: row.tier };
  }

  /**
   * Reset — 마이너스 carry, 양수 lost.
   * `new balance = monthly_limit + min(0, current_balance)`
   */
  async reset(userId: string): Promise<{ balance: number; tier: CoinTier }> {
    const row = await this.balanceRepo.findOne({ where: { userId } });
    if (!row) {
      return this.createInitialBalance(userId);
    }
    const tier = await this.tierRepo.findOne({ where: { tier: row.tier } });
    if (!tier) {
      throw new Error(`tier_configs row missing for tier=${row.tier}`);
    }
    const currentBalance = parseFloat(row.balance);
    const monthlyLimit = parseFloat(tier.monthlyCoinLimit);
    const newBalance = monthlyLimit + Math.min(0, currentBalance); // 마이너스만 carry

    const now = new Date();
    const nextReset = this.calcNextResetAt(row.tier, row.planStartedAt);
    await this.balanceRepo.update(
      { userId },
      {
        balance: newBalance.toFixed(1),
        cycleStartAt: now,
        nextResetAt: nextReset,
      },
    );
    return { balance: newBalance, tier: row.tier };
  }

  /**
   * 신규 user — balance 150 (한도 100 + onboarding 보너스 50) + next_reset_at 다음 매월 1일 KST.
   * 가입 hook (auth.service) 에서 호출 메인. 첫 호출 lazy 가 보조 catch.
   */
  async createInitialBalance(
    userId: string,
  ): Promise<{ balance: number; tier: CoinTier }> {
    const now = new Date();
    const initialBalance = 150; // 100 한도 + 50 보너스
    await this.balanceRepo
      .createQueryBuilder()
      .insert()
      .values({
        userId,
        tier: 'free',
        balance: initialBalance.toFixed(1),
        cycleStartAt: now,
        nextResetAt: startOfNextMonthKst(),
      })
      .orIgnore() // 이미 있으면 무시 (race)
      .execute();
    const row = await this.balanceRepo.findOne({ where: { userId } });
    return {
      balance: row ? parseFloat(row.balance) : initialBalance,
      tier: row?.tier ?? 'free',
    };
  }

  /**
   * 다음 reset 시각 계산.
   * - Free: 다음 매월 1일 0시 KST
   * - Lite/Standard: plan_started_at + 30일 (결제일 기준)
   */
  calcNextResetAt(tier: CoinTier, planStartedAt: Date | null): Date {
    if (tier === 'free') {
      return startOfNextMonthKst();
    }
    const base = planStartedAt ?? new Date();
    const next = new Date(base);
    next.setDate(next.getDate() + 30);
    return next;
  }

  /** Cron 의 due reset — next_reset_at 지난 user 일괄 reset */
  async findDueResets(): Promise<UserCoinBalance[]> {
    return this.balanceRepo.find({
      where: { nextResetAt: LessThan(new Date()) },
    });
  }
}
