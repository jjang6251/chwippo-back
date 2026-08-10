import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { DataSource } from 'typeorm';
import { TierConfig, type CoinTier } from './entities/tier-config.entity';
import { FeatureCoinMeta } from './entities/feature-coin-meta.entity';
import { UserCoinBalance } from './entities/user-coin-balance.entity';
import { UserPlanHistory } from './entities/user-plan-history.entity';
import type { LlmFeature } from './entities/llm-call-log.entity';
import { startOfNextMonthKst, todayKst } from '../common/datetime';
import { effectivePricing, getModelSpec } from './model-registry';

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

  /**
   * **코인 환산 기준(anchor).** 모델 단가가 아니라 "1 코인이 얼마인가" 의 정의다.
   *
   * `1 코인 = 기준 단가로 input 1K 토큰` → `input $1/M` 이므로 **1 코인 = $0.001**.
   * 값 자체는 Haiku 4.5 단가와 같지만 **의미가 다르다** — 모델이 바뀌어도 이 값은
   * 안 바뀐다. 바뀌면 코인의 화폐 가치가 통째로 흔들려 기존 잔액의 의미가 달라진다.
   *
   * G-1 이전에는 이 상수가 "모델 단가" 역할까지 겸했다. 그래서 모델을 올려도
   * 차감이 그대로여서 **마진만 무너지는** 구조였다. 이제 모델 단가는
   * `MODEL_REGISTRY` 가 갖고, 이 상수는 **환산 기준**으로만 쓴다.
   */
  static readonly COST_PER_M = {
    input: 1.0,
    output: 5.0,
    cacheCreation: 1.25,
    cacheRead: 0.1,
    webSearch: 10_000, // $10 per 1000 = $0.01 per search → per 1M searches scale 일관성
  } as const;

  /** 1 코인의 USD 가치 — anchor input 단가에서 파생 ($1/M ÷ 1,000 = $0.001) */
  private static readonly USD_PER_COIN = CoinService.COST_PER_M.input / 1_000;

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
   * G-1 — 실제 사용된 **모델의 단가**를 레지스트리에서 가져온다.
   * 미등록이면 anchor 로 폴백하되 `llm-pricing` 이 error 로그를 남긴다.
   */
  private pricingFor(model: string) {
    const spec = getModelSpec(model);
    if (spec) return effectivePricing(spec, todayKst());
    const c = CoinService.COST_PER_M;
    return {
      input: c.input,
      output: c.output,
      cacheWriteRatio: c.cacheCreation / c.input,
      cacheReadRatio: c.cacheRead / c.input,
      webSearchUsdPerCall: 0.01,
    };
  }

  /**
   * 정확한 cost 계산 (USD).
   * 모든 token 종류 + web_search 합산. 마진 보호의 핵심.
   *
   * G-1 — `model` 을 **필수 인자**로 받는다. 옵셔널로 두고 Haiku 를 기본값으로 하면
   * 호출부가 빠뜨렸을 때 조용히 틀린 단가로 계산된다 — 이번 작업이 없애려는 바로 그 패턴.
   */
  calculateCost(
    input: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
      webSearchCount?: number;
    },
    model: string,
  ): { totalUsd: number; breakdown: Record<string, number> } {
    const p = this.pricingFor(model);
    const inputCost = (input.inputTokens / 1_000_000) * p.input;
    const outputCost = (input.outputTokens / 1_000_000) * p.output;
    const cacheCreationCost =
      ((input.cacheCreationTokens ?? 0) / 1_000_000) *
      p.input *
      p.cacheWriteRatio;
    const cacheReadCost =
      ((input.cacheReadTokens ?? 0) / 1_000_000) * p.input * p.cacheReadRatio;
    const webSearchCost =
      (input.webSearchCount ?? 0) * (p.webSearchUsdPerCall ?? 0);

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
  calculateCoin(
    input: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
      webSearchCount?: number;
    },
    model: string,
  ): number {
    const p = this.pricingFor(model);

    // 🔴 G-1 핵심 — 모델이 비쌀수록 같은 토큰이 더 많은 코인을 먹는다.
    //   anchor($1/M) 대비 배수. Haiku 면 1 이라 기존과 완전히 동일하다.
    const weight = p.input / CoinService.COST_PER_M.input;
    // output 이 input 의 몇 배인가 — Anthropic 5배 · gpt-4o 계열 4배. 모델마다 다르다
    const outRatio = p.output / p.input;

    const equivalentTokens =
      input.inputTokens +
      input.outputTokens * outRatio +
      (input.cacheCreationTokens ?? 0) * p.cacheWriteRatio +
      (input.cacheReadTokens ?? 0) * p.cacheReadRatio;

    // 0.1 단위 ceil — 1523 tokens → 1.6 코인
    const tokenCoins = Math.ceil((equivalentTokens * weight) / 100) / 10;

    // web_search 는 **모델과 무관하게 정액**($0.01/회)이라 weight 곱셈 밖에 둔다.
    //   코인의 화폐 가치가 고정($0.001)이므로 정액 항목은 항상 같은 코인 수다.
    //   (기존 공식은 10,000 token-equivalent 를 ceil 안에 넣었는데, 그 값이
    //    100·10 으로 정확히 나누어떨어져 **밖으로 빼도 결과가 동일**하다)
    const webSearchCoins =
      ((input.webSearchCount ?? 0) * (p.webSearchUsdPerCall ?? 0)) /
      CoinService.USD_PER_COIN;

    return tokenCoins + webSearchCoins;
  }

  /**
   * 쿼터 정책 웨이브 C — feature 가 코인을 차감하는지 여부 (in-flight lock 적용 판정용).
   * COIN_SYSTEM_ENABLED 와 무관 — 동시호출 방어(lock)는 과금 rollout 상태와 별개로 필요.
   * feature_coin_meta 행 없으면 false (우리 부담 취급).
   */
  async chargesCoins(feature: LlmFeature): Promise<boolean> {
    const meta = await this.featureMetaRepo.findOne({ where: { feature } });
    return meta?.chargesCoins ?? false;
  }

  // ──────────────────────────────────────────────────────────────
  // canCharge (호출 시작 전 추정 check)
  // ──────────────────────────────────────────────────────────────

  /**
   * **예약치(reservation)** — 호출 시작 전 "이 정도는 들 것" 추정. 사용자 무관, feature 단위.
   *
   * 🔴 실제 차감과 다르다 — 차감은 `charge()` 의 토큰 실비 환산이고 보통 이 값보다 적다.
   * 여기는 "잔액이 이만큼은 있어야 시작한다" 는 **게이트 기준**이다.
   *
   * `canCharge` 와 `GET /me/ai-costs`(D1c) 가 **같은 이 메서드**를 쓴다. 공개 조회 API 를
   * 신설한 이유가 "프론트가 단가를 하드코딩하지 않게" 인데, 그 값을 서버 안에서 두 번
   * 계산하면 같은 종류의 드리프트가 백엔드로 옮겨갈 뿐이다.
   */
  async estimateCoins(
    feature: LlmFeature,
  ): Promise<{ chargesCoins: boolean; estimatedCoins: number }> {
    const meta = await this.featureMetaRepo.findOne({ where: { feature } });
    // 회사조사·노트요약 (우리 부담) · 행 자체가 없는 feature 도 여기로 (chargesCoins() 와 동일 취급)
    if (!meta?.chargesCoins) return { chargesCoins: false, estimatedCoins: 0 };

    // PR_B1c — fixed_coin_cost 우선 (token 환산 무시). NULL 이면 기존 avg × 1.2 buffer
    const estimatedCoins =
      meta.fixedCoinCost !== null
        ? meta.fixedCoinCost
        : Math.ceil(parseFloat(meta.avgCoinCost) * 1.2 * 10) / 10;

    return { chargesCoins: true, estimatedCoins };
  }

  /**
   * 호출 시작 전 — 추정 (평균 × 1.2) 잔여 ≥ 진행 보장.
   * COIN_SYSTEM_ENABLED=false 또는 charges_coins=false feature → 항상 통과.
   */
  async canCharge(
    userId: string,
    feature: LlmFeature,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (process.env.COIN_SYSTEM_ENABLED === 'false') return { ok: true };

    const { chargesCoins, estimatedCoins: estimate } =
      await this.estimateCoins(feature);
    if (!chargesCoins) return { ok: true };

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
    /** G-1 — 실제 호출에 쓰인 모델. 단가·코인 배율의 근거라 필수다 */
    model: string,
  ): Promise<{
    coinCost: number;
    costUsd: number;
    breakdown: Record<string, number>;
  }> {
    const costInfo = this.calculateCost(tokens, model);

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
        : this.calculateCoin(tokens, model);
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
