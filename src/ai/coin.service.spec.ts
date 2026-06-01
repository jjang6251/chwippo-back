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
      const r = service.calculateCost({ inputTokens: 1000, outputTokens: 500 });
      // input 1K × $1/M = $0.001 + output 500 × $5/M = $0.0025 = $0.0035
      expect(r.totalUsd).toBeCloseTo(0.0035, 6);
      expect(r.breakdown.input).toBeCloseTo(0.001, 6);
      expect(r.breakdown.output).toBeCloseTo(0.0025, 6);
      expect(r.breakdown.cache_creation).toBe(0);
      expect(r.breakdown.cache_read).toBe(0);
      expect(r.breakdown.web_search).toBe(0);
    });

    it('2) cache_creation 만 — input × 1.25 cost', () => {
      const r = service.calculateCost({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1000,
      });
      // 1000 × $1.25/M = $0.00125
      expect(r.totalUsd).toBeCloseTo(0.00125, 6);
      expect(r.breakdown.cache_creation).toBeCloseTo(0.00125, 6);
    });

    it('3) cache_read 만 — input × 0.10 cost (90% 할인)', () => {
      const r = service.calculateCost({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1000,
      });
      // 1000 × $0.10/M = $0.0001
      expect(r.totalUsd).toBeCloseTo(0.0001, 6);
      expect(r.breakdown.cache_read).toBeCloseTo(0.0001, 6);
    });

    it('4) web_search 1회 — $0.01', () => {
      const r = service.calculateCost({
        inputTokens: 0,
        outputTokens: 0,
        webSearchCount: 1,
      });
      expect(r.totalUsd).toBeCloseTo(0.01, 6);
      expect(r.breakdown.web_search).toBeCloseTo(0.01, 6);
    });

    it('5) 모든 필드 mix — 정확 합산', () => {
      const r = service.calculateCost({
        inputTokens: 5000,
        outputTokens: 1000,
        cacheCreationTokens: 2000,
        cacheReadTokens: 500,
        webSearchCount: 3,
      });
      // input 5K = $0.005 + output 1K = $0.005 + cache_creation 2K = $0.0025
      // + cache_read 500 = $0.00005 + web_search 3 = $0.03
      const expected = 0.005 + 0.005 + 0.0025 + 0.00005 + 0.03;
      expect(r.totalUsd).toBeCloseTo(expected, 6);
    });

    it('6) 0 tokens — cost 0', () => {
      const r = service.calculateCost({ inputTokens: 0, outputTokens: 0 });
      expect(r.totalUsd).toBe(0);
    });

    it('7) 매우 큰 호출 — input 100K → $0.1', () => {
      const r = service.calculateCost({
        inputTokens: 100_000,
        outputTokens: 0,
      });
      expect(r.totalUsd).toBeCloseTo(0.1, 6);
    });

    it('8) usage 누락 (optional 필드 undefined) → 0 처리', () => {
      const r = service.calculateCost({ inputTokens: 1000, outputTokens: 0 });
      // cacheCreation/cacheRead/webSearch undefined → 0
      expect(r.breakdown.cache_creation).toBe(0);
      expect(r.breakdown.cache_read).toBe(0);
      expect(r.breakdown.web_search).toBe(0);
    });
  });

  describe('calculateCoin — 0.1 단위 ceil + 비율 정확', () => {
    it('9) 정상 — input 1000 output 500 → 1000 + 500×5 = 3500 token-eq → 3.5 코인', () => {
      const c = service.calculateCoin({ inputTokens: 1000, outputTokens: 500 });
      expect(c).toBeCloseTo(3.5, 1);
    });

    it('10) 0.1 단위 ceil — input 1523 → 15.23 / 10 → ceil 1.6 (위 = 152.3 / 100 ceil = 153 → 15.3 / 10 = 1.53 ?)', () => {
      // 1523 / 100 = 15.23 → ceil = 16 → /10 = 1.6
      const c = service.calculateCoin({ inputTokens: 1523, outputTokens: 0 });
      expect(c).toBe(1.6);
    });

    it('11) 정확히 100 token → 0.1 코인', () => {
      const c = service.calculateCoin({ inputTokens: 100, outputTokens: 0 });
      expect(c).toBe(0.1);
    });

    it('12) 99 token → 0.1 코인 (ceil)', () => {
      const c = service.calculateCoin({ inputTokens: 99, outputTokens: 0 });
      expect(c).toBe(0.1);
    });

    it('13) 0 tokens → 0 코인', () => {
      const c = service.calculateCoin({ inputTokens: 0, outputTokens: 0 });
      expect(c).toBe(0);
    });

    it('14) cache_read 1000 → 0.1 코인 (90% 할인 반영)', () => {
      // 1000 × 0.1 = 100 token-eq → 0.1 코인
      const c = service.calculateCoin({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1000,
      });
      expect(c).toBe(0.1);
    });

    it('15) cache_creation 1000 → 1.25 → ceil 1.3 코인', () => {
      // 1000 × 1.25 = 1250 token-eq → 12.5 / 10 = 1.25 → ceil 0.1 단위 1.3
      const c = service.calculateCoin({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1000,
      });
      expect(c).toBe(1.3);
    });

    it('16) web_search 1회 → 10 코인 ($0.01 equivalent)', () => {
      const c = service.calculateCoin({
        inputTokens: 0,
        outputTokens: 0,
        webSearchCount: 1,
      });
      // 10000 token-eq / 1000 = 10 코인 (0.1 단위 ceil)
      expect(c).toBe(10);
    });

    it('17) output ≫ input (1:5) — 1000 input + 5000 output → 1000 + 25000 = 26000 token-eq → 26 코인', () => {
      const c = service.calculateCoin({
        inputTokens: 1000,
        outputTokens: 5000,
      });
      expect(c).toBe(26);
    });

    it('18) 모든 필드 mix — 비율 정확', () => {
      // input 5000 + output 1000×5 + cache_creation 2000×1.25 + cache_read 500×0.1 + ws 3×10000
      // = 5000 + 5000 + 2500 + 50 + 30000 = 42550 token-eq
      // → 42550 / 1000 = 42.55 코인 → 0.1 단위 ceil → 42.6 코인
      const c = service.calculateCoin({
        inputTokens: 5000,
        outputTokens: 1000,
        cacheCreationTokens: 2000,
        cacheReadTokens: 500,
        webSearchCount: 3,
      });
      expect(c).toBe(42.6);
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

    it('22) charges_coins=false feature (회사조사) → 항상 ok=true', async () => {
      featureMetaRepo.findOne.mockResolvedValueOnce({
        feature: 'company_research',
        chargesCoins: false,
        avgCoinCost: '0',
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
      const r = await service.canCharge(USER_ID, 'company_research');
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
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('24) 정상 — balance 차감 SQL 실행 + coinCost 반환', async () => {
      dataSource.query.mockResolvedValueOnce(undefined);
      const r = await service.charge(USER_ID, 'coverletter_chat', {
        inputTokens: 1500,
        outputTokens: 500,
      });
      // 1500 + 500×5 = 4000 token-eq → 40 / 10 = 4.0 코인
      expect(r.coinCost).toBe(4);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_coin_balances'),
        [4, USER_ID],
      );
    });

    it('25) charges_coins=false feature → 차감 0 + SQL 안 함', async () => {
      featureMetaRepo.findOne.mockResolvedValueOnce({
        feature: 'company_research',
        chargesCoins: false,
        avgCoinCost: '0',
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const r = await service.charge(USER_ID, 'company_research', {
        inputTokens: 5000,
        outputTokens: 2000,
        webSearchCount: 3,
      });
      expect(r.coinCost).toBe(0);
      expect(r.costUsd).toBeGreaterThan(0); // cost 자체는 계산됨 (audit 용)
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('26) COIN_SYSTEM_ENABLED=false → 차감 0', async () => {
      const old = process.env.COIN_SYSTEM_ENABLED;
      process.env.COIN_SYSTEM_ENABLED = 'false';
      const r = await service.charge(USER_ID, 'coverletter_chat', {
        inputTokens: 1000,
        outputTokens: 500,
      });
      expect(r.coinCost).toBe(0);
      expect(dataSource.query).not.toHaveBeenCalled();
      process.env.COIN_SYSTEM_ENABLED = old;
    });

    it('27) coinCost 0 (tokens 0) → SQL 안 함', async () => {
      const r = await service.charge(USER_ID, 'coverletter_chat', {
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(r.coinCost).toBe(0);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('28) cost_breakdown 5 키 정확 반환', async () => {
      dataSource.query.mockResolvedValueOnce(undefined);
      const r = await service.charge(USER_ID, 'coverletter_chat', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 100,
        cacheReadTokens: 50,
        webSearchCount: 1,
      });
      expect(r.breakdown).toHaveProperty('input');
      expect(r.breakdown).toHaveProperty('output');
      expect(r.breakdown).toHaveProperty('cache_creation');
      expect(r.breakdown).toHaveProperty('cache_read');
      expect(r.breakdown).toHaveProperty('web_search');
    });
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
