import { Test, TestingModule } from '@nestjs/testing';
import { QuotaNotifyService } from './quota-notify.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { AbuserBanService } from './abuser-ban.service';
import { FeatureQuotaConfig } from './entities/feature-quota-config.entity';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { UserAiQuota } from './entities/user-ai-quota.entity';
import {
  QuotaCheckService,
  resolveEffectiveDayLimit,
} from './quota-check.service';

/**
 * F6 PR 2 Phase 1 — QuotaCheckService spec.
 *
 * 시나리오 매트릭스 (plan S1-S5):
 * - S1 config 없음 → fallback
 * - S2 enabled=false → FEATURE_DISABLED (kill switch)
 * - S3 day 한도 초과 → DAY_LIMIT
 * - S4 month 한도 초과 → MONTH_LIMIT
 * - S5 cooldown 미경과 → COOLDOWN + nextAvailableAt
 * - tier 분리 (free 변경이 pro 영향 0 검증)
 * - user_ai_quotas (PR 1, abuser ban) override min 적용
 * - getMyQuotas — 사용자 화면용 응답 형식 + 전 feature 집계
 */
describe('QuotaCheckService', () => {
  let service: QuotaCheckService;
  let userRepo: jest.Mocked<Repository<User>>;
  let configRepo: jest.Mocked<Repository<FeatureQuotaConfig>>;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;
  let userQuotaRepo: jest.Mocked<Repository<UserAiQuota>>;
  let abuserBan: jest.Mocked<AbuserBanService>;

  const USER_ID = 'user-1';

  const makeConfig = (
    overrides: Partial<FeatureQuotaConfig> = {},
  ): FeatureQuotaConfig => ({
    feature: 'note_summary',
    tier: 'free',
    dayLimit: 100,
    monthLimit: 1000,
    cooldownSeconds: 30,
    perResourceDayLimit: null,
    enabled: true,
    updatedBy: null,
    updatedByUser: null,
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    userRepo = mock<Repository<User>>();
    configRepo = mock<Repository<FeatureQuotaConfig>>();
    logRepo = mock<Repository<LlmCallLog>>();
    userQuotaRepo = mock<Repository<UserAiQuota>>();
    userQuotaRepo.findOne.mockResolvedValue(null); // 5.6.9 default
    abuserBan = mock<AbuserBanService>();

    // defaults
    userRepo.findOne.mockResolvedValue({ id: USER_ID, tier: 'free' } as User);
    abuserBan.getActiveOverride.mockResolvedValue(null);
    logRepo.count.mockResolvedValue(0);
    logRepo.findOne.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: QuotaNotifyService,
          useValue: {
            notifyOverrideSet: jest.fn().mockResolvedValue(undefined),
            notifyOverrideCleared: jest.fn().mockResolvedValue(undefined),
            notifyAutoBan: jest.fn().mockResolvedValue(undefined),
            notifyUserReset: jest.fn().mockResolvedValue(undefined),
            notifyAllReset: jest.fn().mockResolvedValue(undefined),
            notifyMatrixChanged: jest.fn().mockResolvedValue(undefined),
            notifyQuotaExceeded: jest.fn().mockResolvedValue(undefined),
          },
        },
        QuotaCheckService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        {
          provide: getRepositoryToken(FeatureQuotaConfig),
          useValue: configRepo,
        },
        { provide: getRepositoryToken(LlmCallLog), useValue: logRepo },
        { provide: getRepositoryToken(UserAiQuota), useValue: userQuotaRepo },
        { provide: AbuserBanService, useValue: abuserBan },
      ],
    }).compile();
    service = module.get<QuotaCheckService>(QuotaCheckService);
  });

  // ── 정상 흐름 ──
  describe('checkAndPrepare — 정상', () => {
    it('config 있음 + enabled + cooldown OK + day/month 미달 → blocked=false', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig());
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false);
    });

    it('cooldownSeconds=0 → cooldown 체크 자체 skip (recent 호출 있어도 OK)', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ cooldownSeconds: 0 }));
      logRepo.findOne.mockResolvedValue({
        createdAt: new Date(),
      } as LlmCallLog);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false);
    });
  });

  // ── S1: config 없음 → fallback ──
  describe('config 누락 fallback (S1)', () => {
    it('config row 없음 → fallback default (day 100·month 1000·cooldown 60·enabled true) + WARN', async () => {
      configRepo.findOne.mockResolvedValue(null);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false); // fallback enabled true
    });

    it('config 없음 + day 100 도달 → fallback dayLimit 으로 DAY_LIMIT blocked', async () => {
      configRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValueOnce(100);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
      if (!r.blocked) throw new Error('expected blocked');
      expect(r.code).toBe('DAY_LIMIT');
    });
  });

  // ── S2: kill switch ──
  describe('kill switch (S2)', () => {
    it('enabled=false → FEATURE_DISABLED + 한국어 reason', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ enabled: false }));
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
      if (!r.blocked) throw new Error('expected blocked');
      expect(r.code).toBe('FEATURE_DISABLED');
      expect(r.reason).toContain('관리자');
    });

    it('enabled=false 우선순위 — day 한도 도달이어도 FEATURE_DISABLED 먼저 검출', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ enabled: false }));
      logRepo.count.mockResolvedValueOnce(99999);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
      if (!r.blocked) throw new Error('expected blocked');
      expect(r.code).toBe('FEATURE_DISABLED');
    });
  });

  // ── S3: day 한도 ──
  describe('day 한도 (S3)', () => {
    it('dayCount ≥ dayLimit → DAY_LIMIT', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ dayLimit: 30 }));
      logRepo.count.mockResolvedValueOnce(30);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
      if (!r.blocked) throw new Error('expected blocked');
      expect(r.code).toBe('DAY_LIMIT');
      expect(r.reason).toContain('30회');
    });

    it('dayCount = dayLimit - 1 → OK', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ dayLimit: 30 }));
      logRepo.count.mockResolvedValueOnce(29);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false);
    });
  });

  // ── S4: month 한도 ──
  describe('month 한도 (S4)', () => {
    it('monthCount ≥ monthLimit → MONTH_LIMIT', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ monthLimit: 300 }));
      logRepo.count
        .mockResolvedValueOnce(0) // day
        .mockResolvedValueOnce(300); // month
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
      if (!r.blocked) throw new Error('expected blocked');
      expect(r.code).toBe('MONTH_LIMIT');
      expect(r.reason).toContain('300회');
    });
  });

  // ── S5: cooldown ──
  describe('cooldown (S5)', () => {
    it('cooldown 30s · 최근 10s 전 호출 → COOLDOWN + nextAvailableAt', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ cooldownSeconds: 30 }));
      const recentCall = new Date(Date.now() - 10_000); // 10초 전
      logRepo.findOne.mockResolvedValue({
        createdAt: recentCall,
      } as LlmCallLog);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
      if (!r.blocked) throw new Error('expected blocked');
      expect(r.code).toBe('COOLDOWN');
      expect(r.nextAvailableAt).toBeInstanceOf(Date);
      // 약 20초 후 (30 - 10)
      const diffSec =
        ((r.nextAvailableAt as Date).getTime() - Date.now()) / 1000;
      expect(diffSec).toBeGreaterThan(18);
      expect(diffSec).toBeLessThan(22);
    });

    it('cooldown 30s · 마지막 호출 40초 전 → OK (경과)', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ cooldownSeconds: 30 }));
      logRepo.findOne.mockResolvedValue(null); // 30초 window 안 호출 없음
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false);
    });
  });

  // ── tier 분리 ──
  describe('tier 분리 (S4)', () => {
    it("user.tier='lite' → lite tier config 조회 (free 와 다른 row)", async () => {
      userRepo.findOne.mockResolvedValue({
        id: USER_ID,
        tier: 'lite',
      } as User);
      configRepo.findOne.mockResolvedValue(
        makeConfig({ tier: 'lite', dayLimit: 100 }),
      );
      await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(configRepo.findOne).toHaveBeenCalledWith({
        where: { feature: 'note_summary', tier: 'lite' },
      });
    });

    it('user 없음 → fallback tier=free', async () => {
      userRepo.findOne.mockResolvedValue(null);
      configRepo.findOne.mockResolvedValue(makeConfig());
      await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(configRepo.findOne).toHaveBeenCalledWith({
        where: { feature: 'note_summary', tier: 'free' },
      });
    });
  });

  // ── user_ai_quotas (PR 1, abuser ban) override min 적용 ──
  describe('abuser ban override min 적용', () => {
    it('config.dayLimit=1000 + override.dailyCapOverride=5 → effective=5', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ dayLimit: 1000 }));
      abuserBan.getActiveOverride.mockResolvedValue({
        userId: USER_ID,
        dailyCapOverride: 5,
        validUntil: new Date(Date.now() + 86_400_000),
        reason: 'auto_ban_3_consecutive_days',
      } as unknown as Awaited<ReturnType<typeof abuserBan.getActiveOverride>>);
      logRepo.count.mockResolvedValueOnce(5);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
      if (!r.blocked) throw new Error('expected blocked');
      expect(r.code).toBe('DAY_LIMIT');
      expect(r.reason).toContain('5회'); // override 가 작아서 적용
    });

    it('override.dailyCapOverride=2000 (config 보다 큼) → effective=config(1000) min', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig({ dayLimit: 1000 }));
      abuserBan.getActiveOverride.mockResolvedValue({
        userId: USER_ID,
        dailyCapOverride: 2000,
        validUntil: new Date(Date.now() + 86_400_000),
        reason: 'manual_admin',
      } as unknown as Awaited<ReturnType<typeof abuserBan.getActiveOverride>>);
      logRepo.count.mockResolvedValueOnce(999);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false); // 999 < 1000 (config)
    });
  });

  // ── 우선순위 ──
  describe('체크 순서 우선순위', () => {
    it('enabled=false > day > month > cooldown', async () => {
      configRepo.findOne.mockResolvedValue(
        makeConfig({ enabled: false, dayLimit: 1, monthLimit: 1 }),
      );
      logRepo.count.mockResolvedValue(99999);
      logRepo.findOne.mockResolvedValue({
        createdAt: new Date(),
      } as LlmCallLog);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      if (!r.blocked) throw new Error('expected blocked');
      expect(r.code).toBe('FEATURE_DISABLED');
    });

    it('day 도달이 month 도달보다 우선', async () => {
      configRepo.findOne.mockResolvedValue(
        makeConfig({ dayLimit: 30, monthLimit: 300 }),
      );
      logRepo.count
        .mockResolvedValueOnce(30) // day 도달
        .mockResolvedValueOnce(300); // month 도 도달
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      if (!r.blocked) throw new Error('expected blocked');
      expect(r.code).toBe('DAY_LIMIT');
    });
  });

  // ── getMyQuotas ──
  describe('getMyQuotas — 사용자 화면용 응답', () => {
    it('전 feature config 조회 + 사용량 집계 + nextAvailableAt 계산', async () => {
      configRepo.find.mockResolvedValue([
        makeConfig({ feature: 'note_summary', cooldownSeconds: 30 }),
        makeConfig({
          feature: 'coverletter_draft_v2',
          cooldownSeconds: 120,
          dayLimit: 500,
        }),
      ]);
      logRepo.count.mockResolvedValue(5);
      logRepo.findOne.mockResolvedValue(null); // cooldown 경과
      const r = await service.getMyQuotas(USER_ID);
      expect(r).toHaveLength(2);
      expect(r[0]).toMatchObject({
        feature: 'note_summary',
        enabled: true,
        dayUsed: 5,
        dayLimit: 100,
        cooldownSeconds: 30,
        nextAvailableAt: null,
      });
      expect(r[1].dayLimit).toBe(500);
    });

    it('cooldown 안 호출 있음 → nextAvailableAt 미래 ISO', async () => {
      configRepo.find.mockResolvedValue([
        makeConfig({ feature: 'note_summary', cooldownSeconds: 60 }),
      ]);
      const recent = new Date(Date.now() - 10_000); // 10초 전
      logRepo.count.mockResolvedValue(0);
      logRepo.findOne.mockResolvedValue({ createdAt: recent } as LlmCallLog);
      const r = await service.getMyQuotas(USER_ID);
      expect(r[0].nextAvailableAt).not.toBeNull();
      expect(new Date(r[0].nextAvailableAt!).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });

    it('override 적용 시 dayLimit min', async () => {
      configRepo.find.mockResolvedValue([
        makeConfig({ feature: 'note_summary', dayLimit: 1000 }),
      ]);
      abuserBan.getActiveOverride.mockResolvedValue({
        userId: USER_ID,
        dailyCapOverride: 5,
      } as unknown as Awaited<ReturnType<typeof abuserBan.getActiveOverride>>);
      const r = await service.getMyQuotas(USER_ID);
      expect(r[0].dayLimit).toBe(5);
    });
  });

  // ── 5.6.9 — quota_reset_at 적용 (dayUsed 계산 시 GREATEST(24h, reset_at)) ──
  describe('5.6.9 quota_reset_at', () => {
    it('1) quota_reset_at 없음 (row 없음) → 24h ago 그대로 사용 (기존 동작)', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig());
      abuserBan.getActiveOverride.mockResolvedValue(null);
      // user_ai_quotas row 없음 → null
      userQuotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(5);
      const r = await service.checkAndPrepare(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false);
      // count 쿼리의 createdAt 범위가 24h ago 기반
      // cost hardening 🟡1 — where 는 billableCallWhere 배열 (OR 2갈래, createdAt 동일)
      const callWhere = (logRepo.count as jest.Mock).mock.calls[0][0].where[0];
      expect(callWhere.createdAt).toBeDefined();
    });

    it('2) quota_reset_at="1h ago" → reset_at 이후만 카운트 (since24h 대체)', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig());
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      userQuotaRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        quotaResetAt: { '*': oneHourAgo },
      } as unknown as UserAiQuota);
      logRepo.count.mockResolvedValue(0);
      await service.checkAndPrepare(USER_ID, 'note_summary');
      // count 쿼리의 createdAt 범위가 1h ago 부터 시작
      // cost hardening 🟡1 — where 는 billableCallWhere 배열 (OR 2갈래, createdAt 동일)
      const callWhere = (logRepo.count as jest.Mock).mock.calls[0][0].where[0];
      const between = callWhere.createdAt as { _value: Date[] };
      const start = between._value[0];
      // GREATEST(24h ago, 1h ago) = 1h ago
      expect(start?.getTime()).toBeGreaterThan(Date.now() - 2 * 60 * 60 * 1000);
    });

    it('3) quota_reset_at="25h ago" (만료) → GREATEST(24h, 25h) = 24h 선택 (안전)', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig());
      const farPast = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      userQuotaRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        quotaResetAt: { '*': farPast },
      } as unknown as UserAiQuota);
      logRepo.count.mockResolvedValue(0);
      await service.checkAndPrepare(USER_ID, 'note_summary');
      // cost hardening 🟡1 — where 는 billableCallWhere 배열 (OR 2갈래, createdAt 동일)
      const callWhere = (logRepo.count as jest.Mock).mock.calls[0][0].where[0];
      const between = callWhere.createdAt as { _value: Date[] };
      const start = between._value[0];
      // 24h ago 가 25h ago 보다 최근 → start ≈ 24h ago
      const expected24hAgo = Date.now() - 24 * 60 * 60 * 1000;
      // 1분 오차 허용
      expect(Math.abs(start.getTime() - expected24hAgo)).toBeLessThan(60_000);
    });

    it('4) user_ai_quotas row 있고 quota_reset_at={} (빈 객체) → 24h ago 그대로', async () => {
      configRepo.findOne.mockResolvedValue(makeConfig());
      userQuotaRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        quotaResetAt: {},
      } as UserAiQuota);
      logRepo.count.mockResolvedValue(0);
      await service.checkAndPrepare(USER_ID, 'note_summary');
      // cost hardening 🟡1 — where 는 billableCallWhere 배열 (OR 2갈래, createdAt 동일)
      const callWhere = (logRepo.count as jest.Mock).mock.calls[0][0].where[0];
      const between = callWhere.createdAt as { _value: Date[] };
      const start = between._value[0];
      const expected24hAgo = Date.now() - 24 * 60 * 60 * 1000;
      expect(Math.abs(start.getTime() - expected24hAgo)).toBeLessThan(60_000);
    });
  });
});

// ── cost hardening B-4 — override 적용 규칙 (순수 함수) ──
describe('resolveEffectiveDayLimit', () => {
  it('override 없음 → base 그대로', () => {
    expect(resolveEffectiveDayLimit(10, null)).toBe(10);
    expect(
      resolveEffectiveDayLimit(10, {
        dailyCapOverride: null,
        reason: 'manual_admin',
      }),
    ).toBe(10);
  });

  it('auto ban → 항상 하향(min): override 가 base 보다 커도 완화되지 않음', () => {
    expect(
      resolveEffectiveDayLimit(3, {
        dailyCapOverride: 5,
        reason: 'auto_ban_3_consecutive_days',
      }),
    ).toBe(3);
    expect(
      resolveEffectiveDayLimit(10, {
        dailyCapOverride: 5,
        reason: 'auto_ban_3_consecutive_days',
      }),
    ).toBe(5);
  });

  it('manual_admin·fair_use → admin 의도 그대로 (상향 지원 — 베타 테스터)', () => {
    expect(
      resolveEffectiveDayLimit(3, {
        dailyCapOverride: 100,
        reason: 'fair_use',
      }),
    ).toBe(100);
    expect(
      resolveEffectiveDayLimit(10, {
        dailyCapOverride: 1,
        reason: 'manual_admin',
      }),
    ).toBe(1);
  });

  it('하향 0 → 사실상 전면 차단도 가능', () => {
    expect(
      resolveEffectiveDayLimit(10, {
        dailyCapOverride: 0,
        reason: 'manual_admin',
      }),
    ).toBe(0);
  });
});
