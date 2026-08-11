import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, type Repository } from 'typeorm';
import { CoinService } from './coin.service';
import { TierConfig } from './entities/tier-config.entity';
import { FeatureCoinMeta } from './entities/feature-coin-meta.entity';
import { UserCoinBalance } from './entities/user-coin-balance.entity';
import { UserPlanHistory } from './entities/user-plan-history.entity';

/**
 * PR_B1 — CoinService spec 매트릭스.
 *
 * **Task 1 CRITICAL — Token 계산 정확성** (18+ 케이스):
 *   - calculateCost: input·output·cache_creation·cache_read·web_search 정확 합산
 *   - calculateCoin: 0.1 단위 ceil + 비율 정확 (output 5× / cache_read 0.1× / web_search = 10코인)
 *
 * **canCharge / charge / reset / createInitial / calcNextResetAt** (Phase 3, 추가 spec)
 */
/**
 * G-1 — `calculateCost`/`calculateCoin` 이 model 을 필수로 받는다.
 * 아래 기대값들은 **모델별 단가 도입 이전** 하드코딩 공식으로 계산된 값이라,
 * Haiku 를 넘겨 그대로 통과하는 것이 곧 **하위호환 증명**이다.
 */
const HAIKU = 'claude-haiku-4-5-20251001';

describe('CoinService', () => {
  let service: CoinService;
  let tierRepo: jest.Mocked<Repository<TierConfig>>;
  let featureMetaRepo: jest.Mocked<Repository<FeatureCoinMeta>>;
  let balanceRepo: jest.Mocked<Repository<UserCoinBalance>>;
  let historyRepo: jest.Mocked<Repository<UserPlanHistory>>;
  let dataSource: { query: jest.Mock };

  const USER_ID = 'u-1';

  beforeEach(async () => {
    tierRepo = mock<Repository<TierConfig>>();
    featureMetaRepo = mock<Repository<FeatureCoinMeta>>();
    balanceRepo = mock<Repository<UserCoinBalance>>();
    historyRepo = mock<Repository<UserPlanHistory>>();
    dataSource = { query: jest.fn() };

    // 기본 tier_configs (Free)
    tierRepo.findOne.mockResolvedValue({
      tier: 'free',
      monthlyCoinLimit: '100.0',
      inputTokenCapPerCall: 8000,
      defaultCooldownSeconds: 3,
      companyResearchDailyCap: 2,
      noteSummaryCooldownMinutes: 60,
      priceKrw: 0,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoinService,
        { provide: getRepositoryToken(TierConfig), useValue: tierRepo },
        {
          provide: getRepositoryToken(FeatureCoinMeta),
          useValue: featureMetaRepo,
        },
        { provide: getRepositoryToken(UserCoinBalance), useValue: balanceRepo },
        { provide: getRepositoryToken(UserPlanHistory), useValue: historyRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<CoinService>(CoinService);
  });

  // ───────────────────────────────────────────────────────────────────
  // Task 1 CRITICAL — Token / Cost / Coin 계산
  // ───────────────────────────────────────────────────────────────────

  describe('calculateCost — Haiku 4.5 단가 정확 합산', () => {
    it('1) 정상 — input 1000 + output 500 → cost $0.0035', () => {
      const r = service.calculateCost(
        { inputTokens: 1000, outputTokens: 500 },
        HAIKU,
      );
      // input 1K × $1/M = $0.001 + output 500 × $5/M = $0.0025 = $0.0035
      expect(r.totalUsd).toBeCloseTo(0.0035, 6);
      expect(r.breakdown.input).toBeCloseTo(0.001, 6);
      expect(r.breakdown.output).toBeCloseTo(0.0025, 6);
      expect(r.breakdown.cache_creation).toBe(0);
      expect(r.breakdown.cache_read).toBe(0);
      expect(r.breakdown.web_search).toBe(0);
    });

    it('2) cache_creation 만 — input × 1.25 cost', () => {
      const r = service.calculateCost(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 1000,
        },
        HAIKU,
      );
      // 1000 × $1.25/M = $0.00125
      expect(r.totalUsd).toBeCloseTo(0.00125, 6);
      expect(r.breakdown.cache_creation).toBeCloseTo(0.00125, 6);
    });

    it('3) cache_read 만 — input × 0.10 cost (90% 할인)', () => {
      const r = service.calculateCost(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 1000,
        },
        HAIKU,
      );
      // 1000 × $0.10/M = $0.0001
      expect(r.totalUsd).toBeCloseTo(0.0001, 6);
      expect(r.breakdown.cache_read).toBeCloseTo(0.0001, 6);
    });

    it('4) web_search 1회 — $0.01', () => {
      const r = service.calculateCost(
        {
          inputTokens: 0,
          outputTokens: 0,
          webSearchCount: 1,
        },
        HAIKU,
      );
      expect(r.totalUsd).toBeCloseTo(0.01, 6);
      expect(r.breakdown.web_search).toBeCloseTo(0.01, 6);
    });

    it('5) 모든 필드 mix — 정확 합산', () => {
      const r = service.calculateCost(
        {
          inputTokens: 5000,
          outputTokens: 1000,
          cacheCreationTokens: 2000,
          cacheReadTokens: 500,
          webSearchCount: 3,
        },
        HAIKU,
      );
      // input 5K = $0.005 + output 1K = $0.005 + cache_creation 2K = $0.0025
      // + cache_read 500 = $0.00005 + web_search 3 = $0.03
      const expected = 0.005 + 0.005 + 0.0025 + 0.00005 + 0.03;
      expect(r.totalUsd).toBeCloseTo(expected, 6);
    });

    it('6) 0 tokens — cost 0', () => {
      const r = service.calculateCost(
        { inputTokens: 0, outputTokens: 0 },
        HAIKU,
      );
      expect(r.totalUsd).toBe(0);
    });

    it('7) 매우 큰 호출 — input 100K → $0.1', () => {
      const r = service.calculateCost(
        {
          inputTokens: 100_000,
          outputTokens: 0,
        },
        HAIKU,
      );
      expect(r.totalUsd).toBeCloseTo(0.1, 6);
    });

    it('8) usage 누락 (optional 필드 undefined) → 0 처리', () => {
      const r = service.calculateCost(
        { inputTokens: 1000, outputTokens: 0 },
        HAIKU,
      );
      // cacheCreation/cacheRead/webSearch undefined → 0
      expect(r.breakdown.cache_creation).toBe(0);
      expect(r.breakdown.cache_read).toBe(0);
      expect(r.breakdown.web_search).toBe(0);
    });
  });

  describe('calculateCoin — 0.1 단위 ceil + 비율 정확', () => {
    it('9) 정상 — input 1000 output 500 → 1000 + 500×5 = 3500 token-eq → 3.5 코인', () => {
      const c = service.calculateCoin(
        { inputTokens: 1000, outputTokens: 500 },
        HAIKU,
      );
      expect(c).toBeCloseTo(3.5, 1);
    });

    it('10) 0.1 단위 ceil — input 1523 → 15.23 / 10 → ceil 1.6 (위 = 152.3 / 100 ceil = 153 → 15.3 / 10 = 1.53 ?)', () => {
      // 1523 / 100 = 15.23 → ceil = 16 → /10 = 1.6
      const c = service.calculateCoin(
        { inputTokens: 1523, outputTokens: 0 },
        HAIKU,
      );
      expect(c).toBe(1.6);
    });

    it('11) 정확히 100 token → 0.1 코인', () => {
      const c = service.calculateCoin(
        { inputTokens: 100, outputTokens: 0 },
        HAIKU,
      );
      expect(c).toBe(0.1);
    });

    it('12) 99 token → 0.1 코인 (ceil)', () => {
      const c = service.calculateCoin(
        { inputTokens: 99, outputTokens: 0 },
        HAIKU,
      );
      expect(c).toBe(0.1);
    });

    it('13) 0 tokens → 0 코인', () => {
      const c = service.calculateCoin(
        { inputTokens: 0, outputTokens: 0 },
        HAIKU,
      );
      expect(c).toBe(0);
    });

    it('14) cache_read 1000 → 0.1 코인 (90% 할인 반영)', () => {
      // 1000 × 0.1 = 100 token-eq → 0.1 코인
      const c = service.calculateCoin(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 1000,
        },
        HAIKU,
      );
      expect(c).toBe(0.1);
    });

    it('15) cache_creation 1000 → 1.25 → ceil 1.3 코인', () => {
      // 1000 × 1.25 = 1250 token-eq → 12.5 / 10 = 1.25 → ceil 0.1 단위 1.3
      const c = service.calculateCoin(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 1000,
        },
        HAIKU,
      );
      expect(c).toBe(1.3);
    });

    it('16) web_search 1회 → 10 코인 ($0.01 equivalent)', () => {
      const c = service.calculateCoin(
        {
          inputTokens: 0,
          outputTokens: 0,
          webSearchCount: 1,
        },
        HAIKU,
      );
      // 10000 token-eq / 1000 = 10 코인 (0.1 단위 ceil)
      expect(c).toBe(10);
    });

    it('17) output ≫ input (1:5) — 1000 input + 5000 output → 1000 + 25000 = 26000 token-eq → 26 코인', () => {
      const c = service.calculateCoin(
        {
          inputTokens: 1000,
          outputTokens: 5000,
        },
        HAIKU,
      );
      expect(c).toBe(26);
    });

    it('18) 모든 필드 mix — 비율 정확', () => {
      // input 5000 + output 1000×5 + cache_creation 2000×1.25 + cache_read 500×0.1 + ws 3×10000
      // = 5000 + 5000 + 2500 + 50 + 30000 = 42550 token-eq
      // → 42550 / 1000 = 42.55 코인 → 0.1 단위 ceil → 42.6 코인
      const c = service.calculateCoin(
        {
          inputTokens: 5000,
          outputTokens: 1000,
          cacheCreationTokens: 2000,
          cacheReadTokens: 500,
          webSearchCount: 3,
        },
        HAIKU,
      );
      expect(c).toBe(42.6);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // estimateCoins — 예약치 (D1c: canCharge 와 GET /me/ai-costs 의 공통 기준)
  // ───────────────────────────────────────────────────────────────────

  describe('estimateCoins — feature 단위 예약치', () => {
    it('avg_coin_cost 3 → 3.6 (×1.2)', async () => {
      featureMetaRepo.findOne.mockResolvedValue({
        feature: 'interview_prep_session',
        chargesCoins: true,
        avgCoinCost: '3.0',
        fixedCoinCost: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const r = await service.estimateCoins('interview_prep_session');
      expect(r).toEqual({ chargesCoins: true, estimatedCoins: 3.6 });
    });

    it('0.1 단위 ceil — avg 2.5 → 3.0 (2.5×1.2=3.0 정확)', async () => {
      featureMetaRepo.findOne.mockResolvedValue({
        feature: 'interview_prep_session',
        chargesCoins: true,
        avgCoinCost: '2.5',
        fixedCoinCost: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const r = await service.estimateCoins('interview_prep_session');
      expect(r.estimatedCoins).toBe(3);
    });

    it('fixed_coin_cost 가 있으면 avg 를 무시하고 그 값', async () => {
      featureMetaRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        chargesCoins: true,
        avgCoinCost: '3.0',
        fixedCoinCost: 50,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const r = await service.estimateCoins('note_summary');
      expect(r).toEqual({ chargesCoins: true, estimatedCoins: 50 });
    });

    it('charges_coins=false (우리 부담) → 0', async () => {
      featureMetaRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        chargesCoins: false,
        avgCoinCost: '0',
        fixedCoinCost: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const r = await service.estimateCoins('note_summary');
      expect(r).toEqual({ chargesCoins: false, estimatedCoins: 0 });
    });

    it('meta 행 자체가 없음 → 0 (chargesCoins() 와 같은 취급)', async () => {
      featureMetaRepo.findOne.mockResolvedValue(null);
      const r = await service.estimateCoins('interview_prep_session');
      expect(r).toEqual({ chargesCoins: false, estimatedCoins: 0 });
    });

    it('🔴 canCharge 의 게이트 기준과 같은 숫자 — 잔여가 예약치보다 0.1 모자라면 막힌다', async () => {
      featureMetaRepo.findOne.mockResolvedValue({
        feature: 'interview_prep_session',
        chargesCoins: true,
        avgCoinCost: '3.0',
        fixedCoinCost: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const { estimatedCoins } = await service.estimateCoins(
        'interview_prep_session',
      );
      balanceRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        tier: 'free',
        balance: (estimatedCoins - 0.1).toFixed(1),
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() + 86400000),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);
      const r = await service.canCharge(USER_ID, 'interview_prep_session');
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(String(estimatedCoins));
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // canCharge — 호출 시작 전 추정 check
  // ───────────────────────────────────────────────────────────────────

  describe('canCharge — 추정 buffer (평균 × 1.2) 잔여 ≥ 진행', () => {
    beforeEach(() => {
      featureMetaRepo.findOne.mockResolvedValue({
        feature: 'coverletter_draft_v2',
        chargesCoins: true,
        avgCoinCost: '10',
        fixedCoinCost: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      balanceRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        tier: 'free',
        balance: '50.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() + 86400000), // 내일
        planStartedAt: null,
        planExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as UserCoinBalance);
    });

    it('19) 잔여 충분 (50 > 12) → ok=true', async () => {
      const r = await service.canCharge(USER_ID, 'coverletter_draft_v2');
      expect(r.ok).toBe(true);
    });

    it('20) 잔여 정확히 추정 (12 = 12) → ok=true', async () => {
      balanceRepo.findOne.mockResolvedValueOnce({
        userId: USER_ID,
        tier: 'free',
        balance: '12.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() + 86400000),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);
      const r = await service.canCharge(USER_ID, 'coverletter_draft_v2');
      expect(r.ok).toBe(true);
    });

    it('21) 잔여 부족 (5 < 12) → ok=false + reason', async () => {
      balanceRepo.findOne.mockResolvedValueOnce({
        userId: USER_ID,
        tier: 'free',
        balance: '5.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() + 86400000),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);
      const r = await service.canCharge(USER_ID, 'coverletter_draft_v2');
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('코인이 부족');
    });

    it('22) charges_coins=false feature (무료 feature — mock meta) → 항상 ok=true', async () => {
      featureMetaRepo.findOne.mockResolvedValueOnce({
        feature: 'note_summary',
        chargesCoins: false,
        avgCoinCost: '0',
        fixedCoinCost: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      balanceRepo.findOne.mockResolvedValueOnce({
        userId: USER_ID,
        tier: 'free',
        balance: '0.0', // 잔여 0 인데도
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() + 86400000),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);
      const r = await service.canCharge(USER_ID, 'note_summary');
      expect(r.ok).toBe(true);
    });

    it('23) COIN_SYSTEM_ENABLED=false → 항상 ok=true (rollout 안전 가드)', async () => {
      const old = process.env.COIN_SYSTEM_ENABLED;
      process.env.COIN_SYSTEM_ENABLED = 'false';
      const r = await service.canCharge(USER_ID, 'coverletter_draft_v2');
      expect(r.ok).toBe(true);
      process.env.COIN_SYSTEM_ENABLED = old;
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // charge — atomic 차감
  // ───────────────────────────────────────────────────────────────────

  describe('charge — atomic UPDATE, 마이너스 carry-over', () => {
    beforeEach(() => {
      featureMetaRepo.findOne.mockResolvedValue({
        feature: 'coverletter_chat',
        chargesCoins: true,
        avgCoinCost: '3',
        fixedCoinCost: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('24) 정상 — balance 차감 SQL 실행 + coinCost 반환', async () => {
      dataSource.query.mockResolvedValueOnce(undefined);
      const r = await service.charge(
        USER_ID,
        'coverletter_chat',
        {
          inputTokens: 1500,
          outputTokens: 500,
        },
        HAIKU,
      );
      // 1500 + 500×5 = 4000 token-eq → 40 / 10 = 4.0 코인
      expect(r.coinCost).toBe(4);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_coin_balances'),
        [4, USER_ID],
      );
    });

    it('25) charges_coins=false feature → 차감 0 + SQL 안 함', async () => {
      featureMetaRepo.findOne.mockResolvedValueOnce({
        feature: 'note_summary',
        chargesCoins: false,
        avgCoinCost: '0',
        fixedCoinCost: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const r = await service.charge(
        USER_ID,
        'note_summary',
        {
          inputTokens: 5000,
          outputTokens: 2000,
          webSearchCount: 3,
        },
        HAIKU,
      );
      expect(r.coinCost).toBe(0);
      expect(r.costUsd).toBeGreaterThan(0); // cost 자체는 계산됨 (audit 용)
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('26) COIN_SYSTEM_ENABLED=false → 차감 0', async () => {
      const old = process.env.COIN_SYSTEM_ENABLED;
      process.env.COIN_SYSTEM_ENABLED = 'false';
      const r = await service.charge(
        USER_ID,
        'coverletter_chat',
        {
          inputTokens: 1000,
          outputTokens: 500,
        },
        HAIKU,
      );
      expect(r.coinCost).toBe(0);
      expect(dataSource.query).not.toHaveBeenCalled();
      process.env.COIN_SYSTEM_ENABLED = old;
    });

    it('27) coinCost 0 (tokens 0) → SQL 안 함', async () => {
      const r = await service.charge(
        USER_ID,
        'coverletter_chat',
        {
          inputTokens: 0,
          outputTokens: 0,
        },
        HAIKU,
      );
      expect(r.coinCost).toBe(0);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('28) cost_breakdown 5 키 정확 반환', async () => {
      dataSource.query.mockResolvedValueOnce(undefined);
      const r = await service.charge(
        USER_ID,
        'coverletter_chat',
        {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationTokens: 100,
          cacheReadTokens: 50,
          webSearchCount: 1,
        },
        HAIKU,
      );
      expect(r.breakdown).toHaveProperty('input');
      expect(r.breakdown).toHaveProperty('output');
      expect(r.breakdown).toHaveProperty('cache_creation');
      expect(r.breakdown).toHaveProperty('cache_read');
      expect(r.breakdown).toHaveProperty('web_search');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // PR_B1c — fixed_coin_cost 모드 (token 환산 무시, 고정 차감)
  // ───────────────────────────────────────────────────────────────────

  describe('fixed_coin_cost 모드 (PR_B1c)', () => {
    beforeEach(() => {
      // company_research = charges_coins=true, fixed_coin_cost=50
      featureMetaRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        chargesCoins: true,
        avgCoinCost: '50',
        fixedCoinCost: 50,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('A1) fixed_coin_cost=50 → token 무관 50 차감 (cache hit 도 동일)', async () => {
      dataSource.query.mockResolvedValueOnce(undefined);
      const r = await service.charge(
        USER_ID,
        'note_summary',
        {
          inputTokens: 0, // cache hit
          outputTokens: 0,
        },
        HAIKU,
      );
      expect(r.coinCost).toBe(50);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_coin_balances'),
        [50, USER_ID],
      );
    });

    it('A2) fixed_coin_cost=50 + 큰 호출 (input 50K + ws 3) → 그래도 50 차감 (token 환산 무시)', async () => {
      dataSource.query.mockResolvedValueOnce(undefined);
      const r = await service.charge(
        USER_ID,
        'note_summary',
        {
          inputTokens: 50_000,
          outputTokens: 2_000,
          webSearchCount: 3,
        },
        HAIKU,
      );
      expect(r.coinCost).toBe(50);
    });

    it('A3) fixed_coin_cost=NULL → 기존 token 환산 사용', async () => {
      featureMetaRepo.findOne.mockResolvedValueOnce({
        feature: 'coverletter_chat',
        chargesCoins: true,
        avgCoinCost: '3',
        fixedCoinCost: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      dataSource.query.mockResolvedValueOnce(undefined);
      const r = await service.charge(
        USER_ID,
        'coverletter_chat',
        {
          inputTokens: 1000,
          outputTokens: 200,
        },
        HAIKU,
      );
      // 1000 + 200×5 = 2000 → 2.0 코인 (token 환산)
      expect(r.coinCost).toBe(2);
    });

    it('A4) charges_coins=false → fixed_coin_cost 있어도 차감 0', async () => {
      featureMetaRepo.findOne.mockResolvedValueOnce({
        feature: 'note_summary',
        chargesCoins: false,
        avgCoinCost: '0',
        fixedCoinCost: 50,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const r = await service.charge(
        USER_ID,
        'note_summary',
        {
          inputTokens: 1000,
          outputTokens: 0,
        },
        HAIKU,
      );
      expect(r.coinCost).toBe(0);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('A5) COIN_SYSTEM_ENABLED=false → fixed_coin_cost 있어도 차감 0', async () => {
      const old = process.env.COIN_SYSTEM_ENABLED;
      process.env.COIN_SYSTEM_ENABLED = 'false';
      const r = await service.charge(
        USER_ID,
        'note_summary',
        {
          inputTokens: 0,
          outputTokens: 0,
        },
        HAIKU,
      );
      expect(r.coinCost).toBe(0);
      expect(dataSource.query).not.toHaveBeenCalled();
      process.env.COIN_SYSTEM_ENABLED = old;
    });

    it('A6) canCharge — fixed_coin_cost=50, 잔여 50 (정확) → ok=true', async () => {
      balanceRepo.findOne.mockResolvedValueOnce({
        userId: USER_ID,
        tier: 'free',
        balance: '50.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() + 86400000),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);
      const r = await service.canCharge(USER_ID, 'note_summary');
      expect(r.ok).toBe(true);
    });

    it('A7) canCharge — fixed_coin_cost=50, 잔여 49 → ok=false + reason (필요 50, 잔여 49)', async () => {
      balanceRepo.findOne.mockResolvedValueOnce({
        userId: USER_ID,
        tier: 'free',
        balance: '49.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() + 86400000),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);
      const r = await service.canCharge(USER_ID, 'note_summary');
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('50');
      expect(r.reason).toContain('49');
    });

    it('A8) atomic — 동시 2 호출 모두 50 차감 (mock 검증)', async () => {
      dataSource.query.mockResolvedValue(undefined);
      const [r1, r2] = await Promise.all([
        service.charge(
          USER_ID,
          'note_summary',
          {
            inputTokens: 0,
            outputTokens: 0,
          },
          HAIKU,
        ),
        service.charge(
          USER_ID,
          'note_summary',
          {
            inputTokens: 0,
            outputTokens: 0,
          },
          HAIKU,
        ),
      ]);
      expect(r1.coinCost).toBe(50);
      expect(r2.coinCost).toBe(50);
      expect(dataSource.query).toHaveBeenCalledTimes(2);
    });

    // ─────────────────────────────────────────────────────
    // CTO 검토 H1 — refund (좀비 방지)
    // ─────────────────────────────────────────────────────
  });

  // ───────────────────────────────────────────────────────────────────
  // Reset / createInitialBalance / calcNextResetAt
  // ───────────────────────────────────────────────────────────────────

  describe('Reset / 신규 user / 다음 reset 시각', () => {
    it('29) calcNextResetAt — Free → 다음 매월 1일 KST 자정', () => {
      const next = service.calcNextResetAt('free', null);
      // KST 자정 = UTC -9시. 즉 UTC 의 hour 가 15 (전월 마지막일 15:00 UTC = 다음 월 1일 0시 KST).
      // toLocaleString hour 형식이 Node ICU 버전 따라 '00' / '24' 다르게 출력 → toISOString + UTC 검증으로 우회.
      expect(next.getUTCHours()).toBe(15); // UTC 15시 = KST 0시
      expect(next.getUTCMinutes()).toBe(0);
      // KST 의 day 가 1 인지 확인 (UTC date + 9시간 후 = KST 의 1일 0시 → UTC 는 전월 마지막일 15시)
      // 또는 toLocaleString day 부분만 검증:
      const kstDay = next.toLocaleString('en-CA', {
        timeZone: 'Asia/Seoul',
        day: '2-digit',
      });
      expect(kstDay).toBe('01');
    });

    it('30) calcNextResetAt — Lite/Standard → plan_started_at + 30일', () => {
      const planStarted = new Date('2026-06-02T00:00:00Z');
      const next = service.calcNextResetAt('lite', planStarted);
      const expected = new Date('2026-07-02T00:00:00Z');
      expect(next.getTime()).toBe(expected.getTime());
    });

    it('31) reset — 마이너스 carry — balance -15, free → reset → 85 (100 - 15)', async () => {
      balanceRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        tier: 'free',
        balance: '-15.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() - 86400000),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);
      balanceRepo.update.mockResolvedValue({ affected: 1 } as never);

      const r = await service.reset(USER_ID);
      expect(r.balance).toBe(85);
      expect(balanceRepo.update).toHaveBeenCalledWith(
        { userId: USER_ID },
        expect.objectContaining({ balance: '85.0' }),
      );
    });

    it('32) reset — 양수 carry X — balance 70 → reset → 100 (그대로 monthly_limit)', async () => {
      balanceRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        tier: 'free',
        balance: '70.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() - 86400000),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);
      balanceRepo.update.mockResolvedValue({ affected: 1 } as never);

      const r = await service.reset(USER_ID);
      expect(r.balance).toBe(100); // 70 lost
    });

    it('33) reset — tier 별 한도 (Lite 800 / Standard 1500) 정확', async () => {
      tierRepo.findOne.mockResolvedValueOnce({
        tier: 'lite',
        monthlyCoinLimit: '800.0',
        inputTokenCapPerCall: 12000,
        defaultCooldownSeconds: 3,
        companyResearchDailyCap: 5,
        noteSummaryCooldownMinutes: 10,
        priceKrw: 4900,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      balanceRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        tier: 'lite',
        balance: '0.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() - 86400000),
        planStartedAt: new Date('2026-06-02'),
        planExpiresAt: null,
      } as unknown as UserCoinBalance);
      balanceRepo.update.mockResolvedValue({ affected: 1 } as never);

      const r = await service.reset(USER_ID);
      expect(r.balance).toBe(800);
    });

    it('34) getBalanceWithLazyReset — next_reset_at > NOW → 그대로 반환', async () => {
      balanceRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        tier: 'free',
        balance: '50.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(Date.now() + 86400000),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);

      const r = await service.getBalanceWithLazyReset(USER_ID);
      expect(r.balance).toBe(50);
      expect(balanceRepo.update).not.toHaveBeenCalled();
    });

    it('35) getBalanceWithLazyReset — 신규 user (row 없음) → createInitialBalance 호출 → balance 150', async () => {
      balanceRepo.findOne.mockResolvedValueOnce(null);
      const qb = {
        insert: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb as never);
      balanceRepo.findOne.mockResolvedValueOnce({
        userId: USER_ID,
        tier: 'free',
        balance: '150.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);

      const r = await service.getBalanceWithLazyReset(USER_ID);
      expect(r.balance).toBe(150);
    });

    it('36) createInitialBalance — 신규 user 150 부여 + tier=free + next_reset 다음 매월 1일', async () => {
      const qb = {
        insert: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb as never);
      balanceRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        tier: 'free',
        balance: '150.0',
        cycleStartAt: new Date(),
        nextResetAt: new Date(),
        planStartedAt: null,
        planExpiresAt: null,
      } as unknown as UserCoinBalance);

      const r = await service.createInitialBalance(USER_ID);
      expect(r.balance).toBe(150);
      expect(r.tier).toBe('free');
      expect(qb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          tier: 'free',
          balance: '150.0',
        }),
      );
    });

    it('37) findDueResets — next_reset_at < NOW 인 row 만 반환', async () => {
      const dueRow = {
        userId: 'u-2',
        nextResetAt: new Date(Date.now() - 1000),
      } as UserCoinBalance;
      balanceRepo.find.mockResolvedValue([dueRow]);

      const r = await service.findDueResets();
      expect(r).toHaveLength(1);
      expect(r[0].userId).toBe('u-2');
    });
  });
});

/**
 * 🔴 G-1 (2026-08-02) — **이 작업 전체의 안전 근거.**
 *
 * 코인 계산을 "Haiku 단가 하드코딩" 에서 "모델별 레지스트리 파생" 으로 바꿨다.
 * 두 가지를 동시에 증명해야 한다:
 *   ① 모델을 안 바꾸면 **차감이 1원도 안 달라진다** (기존 사용자 보호)
 *   ② 모델을 바꾸면 **실제로 달라진다** (이걸 안 보면 배선이 죽어도 ①이 통과한다)
 *
 * ②가 없으면 `weight` 를 통째로 1 로 고정해도 전부 초록불이다.
 */
describe('G-1 — 모델별 코인 환산', () => {
  let svc: CoinService;

  beforeEach(() => {
    svc = new CoinService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  const TOKENS = {
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheCreationTokens: 1_000,
    cacheReadTokens: 5_000,
  };

  describe('① 하위호환 — Haiku 유지 시 옛 공식과 완전 동일', () => {
    /** 변경 전 하드코딩 공식을 그대로 재현 (리터럴 5·1.25·0.1·10,000) */
    const legacyCoin = (t: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
      webSearchCount?: number;
    }) =>
      Math.ceil(
        (t.inputTokens +
          t.outputTokens * 5 +
          (t.cacheCreationTokens ?? 0) * 1.25 +
          (t.cacheReadTokens ?? 0) * 0.1 +
          (t.webSearchCount ?? 0) * 10_000) /
          100,
      ) / 10;

    it('토큰 조합 — 옛 공식과 동일', () => {
      expect(svc.calculateCoin(TOKENS, HAIKU)).toBe(legacyCoin(TOKENS));
    });

    it('web_search 포함 — ceil 밖으로 뺐지만 결과 동일', () => {
      // web_search 항은 10,000 token-equivalent → 100·10 으로 정확히 나누어떨어져
      // ceil 안에 있든 밖에 있든 값이 같다. 이 성질이 깨지면 여기서 잡힌다.
      const t = { ...TOKENS, webSearchCount: 3 };
      expect(svc.calculateCoin(t, HAIKU)).toBe(legacyCoin(t));
    });

    it.each([
      [{ inputTokens: 0, outputTokens: 0 }],
      [{ inputTokens: 99, outputTokens: 0 }],
      [{ inputTokens: 100, outputTokens: 0 }],
      [{ inputTokens: 1523, outputTokens: 0 }],
      [{ inputTokens: 0, outputTokens: 1 }],
    ])('경계값 %j — 옛 공식과 동일', (t) => {
      expect(svc.calculateCoin(t, HAIKU)).toBe(legacyCoin(t));
    });

    it('별칭으로 호출해도 동일', () => {
      expect(svc.calculateCoin(TOKENS, 'claude-haiku-4-5')).toBe(
        svc.calculateCoin(TOKENS, HAIKU),
      );
    });
  });

  describe('② 모델을 바꾸면 실제로 달라진다 (배선이 살아있는지)', () => {
    it('🔴 Sonnet(input 3배)은 Haiku보다 코인을 더 먹는다', () => {
      const haiku = svc.calculateCoin(TOKENS, HAIKU);
      const sonnet = svc.calculateCoin(TOKENS, 'claude-sonnet-4-6');
      expect(sonnet).toBeGreaterThan(haiku);
      // input $1 → $3 이므로 대략 3배. ceil 때문에 정확히 3배는 아니다
      expect(sonnet / haiku).toBeGreaterThan(2.9);
      expect(sonnet / haiku).toBeLessThan(3.1);
    });

    it('gpt-4o-mini(input 0.15배)는 Haiku보다 훨씬 적게 먹는다', () => {
      expect(svc.calculateCoin(TOKENS, 'gpt-4o-mini')).toBeLessThan(
        svc.calculateCoin(TOKENS, HAIKU),
      );
    });

    it('output 배율이 모델마다 다르게 반영된다 (Anthropic 5배 · gpt-4o 4배)', () => {
      const outputOnly = { inputTokens: 0, outputTokens: 100_000 };
      // 같은 input 단가로 정규화해 output 비율만 비교
      const haikuCoin = svc.calculateCoin(outputOnly, HAIKU); // 5배
      const gpt4o = svc.calculateCoin(outputOnly, 'gpt-4o'); // 10/2.5 = 4배
      // gpt-4o 는 input 이 2.5배 비싸지만 output 비율은 4배(<5) → 단순 비교 대신 비율 확인
      expect(haikuCoin).toBe(Math.ceil((100_000 * 5) / 100) / 10);
      expect(gpt4o).toBe(Math.ceil(((100_000 * 4) / 100) * 2.5) / 10);
    });

    it('캐시 읽기 할인율이 provider 별로 다르게 반영된다', () => {
      const cacheOnly = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 100_000,
      };
      // Anthropic 0.1 vs OpenAI 0.5 — 배율 자체가 다르다
      expect(svc.calculateCoin(cacheOnly, HAIKU)).toBe(
        Math.ceil((100_000 * 0.1) / 100) / 10,
      );
      expect(svc.calculateCoin(cacheOnly, 'gpt-4o-mini')).toBe(
        Math.ceil(((100_000 * 0.5) / 100) * 0.15) / 10,
      );
    });

    it('web_search 는 모델과 무관하게 정액 10코인', () => {
      const ws = { inputTokens: 0, outputTokens: 0, webSearchCount: 1 };
      expect(svc.calculateCoin(ws, HAIKU)).toBe(10);
      // Sonnet 이어도 $0.01 은 $0.01 — 코인 화폐가치가 고정이므로 동일
      expect(svc.calculateCoin(ws, 'claude-sonnet-4-6')).toBe(10);
    });

    it('web_search 미지원 모델은 0 (호출될 일 없지만 가산도 없음)', () => {
      expect(
        svc.calculateCoin(
          { inputTokens: 0, outputTokens: 0, webSearchCount: 5 },
          'gpt-4o-mini',
        ),
      ).toBe(0);
    });
  });

  describe('calculateCost — USD 도 모델별', () => {
    it('Sonnet 원가가 Haiku 의 3배(input)·3배(output)', () => {
      const h = svc.calculateCost(
        { inputTokens: 1_000_000, outputTokens: 0 },
        HAIKU,
      );
      const s = svc.calculateCost(
        { inputTokens: 1_000_000, outputTokens: 0 },
        'claude-sonnet-4-6',
      );
      expect(h.totalUsd).toBeCloseTo(1.0, 6);
      expect(s.totalUsd).toBeCloseTo(3.0, 6);
    });

    it('미등록 모델은 anchor 로 폴백 (계산이 멈추지는 않는다)', () => {
      const r = svc.calculateCost(
        { inputTokens: 1_000_000, outputTokens: 0 },
        'gpt-9-ultra',
      );
      expect(r.totalUsd).toBeCloseTo(1.0, 6);
    });
  });
});
