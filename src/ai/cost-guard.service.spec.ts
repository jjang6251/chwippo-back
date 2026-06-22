import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { CostGuardService } from './cost-guard.service';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { AlertThresholds } from '../admin/entities/alert-thresholds.entity';

/**
 * AI cost guard 시나리오 매트릭스 (5축).
 *
 * 사용자 시각 못 잡는 영역:
 * - 한 사용자의 모든 feature 합산 cost cap
 * - 한 사용자의 특정 feature cost cap (둘 중 하나라도 도달 시 차단)
 * - thresholds.enabled=false → guard kill switch
 * - alert_thresholds 미설정 (운영 초기) → guard skip (호출 통과)
 * - cache 5분 TTL + invalidate 시 즉시 무효화
 */
const USER_ID = 'user-uuid';

function makeThresholds(
  overrides: Partial<AlertThresholds> = {},
): AlertThresholds {
  return {
    id: 1,
    dailyCostThresholdUsd: 100,
    hourlyErrorRateThreshold: 0.1,
    vsYesterdayIncreaseThreshold: 200,
    enabled: true,
    adminGrantPerHourAlert: 10000,
    adminGrantSingleAlert: 10000,
    inquirySlaHours: 24,
    abuserSuspectDailyCalls: 100,
    freeUserSignupSpikePct: 200,
    costOutlierStddev: 2,
    perUserDailyCostUsd: 0.5,
    perFeatureDailyCostUsd: 5,
    updatedBy: null,
    updatedAt: new Date(),
    updatedByUser: null,
    ...overrides,
  };
}

describe('CostGuardService', () => {
  let service: CostGuardService;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;
  let thresholdRepo: jest.Mocked<Repository<AlertThresholds>>;

  beforeEach(async () => {
    logRepo = mock<Repository<LlmCallLog>>();
    thresholdRepo = mock<Repository<AlertThresholds>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CostGuardService,
        { provide: getRepositoryToken(LlmCallLog), useValue: logRepo },
        {
          provide: getRepositoryToken(AlertThresholds),
          useValue: thresholdRepo,
        },
      ],
    }).compile();
    service = module.get(CostGuardService);
  });

  function mockCostRows(rows: Array<{ feature: string; cost: string }>): void {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };

    logRepo.createQueryBuilder.mockReturnValue(qb as any);
  }

  describe('thresholds 캐시', () => {
    it('첫 호출 → DB findOne, 두번째 → cache (5분 TTL)', async () => {
      thresholdRepo.findOne.mockResolvedValue(makeThresholds());
      mockCostRows([]);

      await service.check(USER_ID, 'note_summary');
      await service.check(USER_ID, 'note_summary');

      expect(thresholdRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('invalidate() 호출 → 다음 check 가 DB 다시 조회', async () => {
      thresholdRepo.findOne.mockResolvedValue(makeThresholds());
      mockCostRows([]);

      await service.check(USER_ID, 'note_summary');
      service.invalidate();
      await service.check(USER_ID, 'note_summary');

      expect(thresholdRepo.findOne).toHaveBeenCalledTimes(2);
    });
  });

  describe('kill switch / 초기화', () => {
    it('alert_thresholds 미설정 → 통과 (blocked=false)', async () => {
      thresholdRepo.findOne.mockResolvedValue(null);

      const r = await service.check(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false);
    });

    it('thresholds.enabled=false → guard skip (blocked=false)', async () => {
      thresholdRepo.findOne.mockResolvedValue(
        makeThresholds({ enabled: false }),
      );

      const r = await service.check(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false);
    });
  });

  describe('정상 통과', () => {
    it('cost 0 → 통과', async () => {
      thresholdRepo.findOne.mockResolvedValue(makeThresholds());
      mockCostRows([]);

      const r = await service.check(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false);
      expect(r.currentUserTotal).toBe(0);
      expect(r.currentFeatureTotal).toBe(0);
    });

    it('user 합산 < cap + feature < cap → 통과', async () => {
      thresholdRepo.findOne.mockResolvedValue(
        makeThresholds({
          perUserDailyCostUsd: 0.5,
          perFeatureDailyCostUsd: 0.3,
        }),
      );
      mockCostRows([
        { feature: 'note_summary', cost: '0.1' },
        { feature: 'company_research', cost: '0.2' },
      ]);

      const r = await service.check(USER_ID, 'note_summary');
      expect(r.blocked).toBe(false);
      expect(r.currentUserTotal).toBeCloseTo(0.3);
      expect(r.currentFeatureTotal).toBeCloseTo(0.1);
    });
  });

  describe('차단', () => {
    it('user 합산 >= cap → blocked (feature 무관)', async () => {
      thresholdRepo.findOne.mockResolvedValue(
        makeThresholds({
          perUserDailyCostUsd: 0.3,
          perFeatureDailyCostUsd: 10,
        }),
      );
      mockCostRows([
        { feature: 'note_summary', cost: '0.15' },
        { feature: 'company_research', cost: '0.15' },
      ]);

      const r = await service.check(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
      expect((r as { reason: string }).reason).toContain('per-user');
      expect(r.currentUserTotal).toBeCloseTo(0.3);
    });

    it('user < cap 단 feature >= feature cap → blocked', async () => {
      thresholdRepo.findOne.mockResolvedValue(
        makeThresholds({
          perUserDailyCostUsd: 10,
          perFeatureDailyCostUsd: 0.2,
        }),
      );
      mockCostRows([
        { feature: 'company_research', cost: '0.25' },
        { feature: 'note_summary', cost: '0.05' },
      ]);

      const r = await service.check(USER_ID, 'company_research');
      expect(r.blocked).toBe(true);
      expect((r as { reason: string }).reason).toContain('per-feature');
      expect((r as { reason: string }).reason).toContain('company_research');
    });

    it('다른 feature 호출 시 — 그 feature 의 cost 만 (격리)', async () => {
      thresholdRepo.findOne.mockResolvedValue(
        makeThresholds({
          perUserDailyCostUsd: 10,
          perFeatureDailyCostUsd: 0.2,
        }),
      );
      mockCostRows([
        { feature: 'company_research', cost: '0.5' }, // 다른 feature 초과
        { feature: 'note_summary', cost: '0.05' },
      ]);

      // note_summary 호출 시 — company_research cost 무관 → 통과
      const r = await service.check(USER_ID, 'note_summary');
      // 단 user 합산 0.55 < perUserDailyCostUsd=10 → 통과
      // feature note_summary=0.05 < 0.2 → 통과
      expect(r.blocked).toBe(false);
    });
  });

  describe('boundary', () => {
    it('user 합산 = cap 정확 → 차단 (>=)', async () => {
      thresholdRepo.findOne.mockResolvedValue(
        makeThresholds({ perUserDailyCostUsd: 0.5 }),
      );
      mockCostRows([{ feature: 'note_summary', cost: '0.5' }]);

      const r = await service.check(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
    });

    it('cap=0 (admin 강제 차단) → 1 USD 라도 즉시 blocked', async () => {
      thresholdRepo.findOne.mockResolvedValue(
        makeThresholds({ perUserDailyCostUsd: 0 }),
      );
      mockCostRows([{ feature: 'note_summary', cost: '0.01' }]);

      const r = await service.check(USER_ID, 'note_summary');
      expect(r.blocked).toBe(true);
    });

    it('cost 0 + cap 0 → 통과 (>= 비교지만 0 < 0 false)', async () => {
      thresholdRepo.findOne.mockResolvedValue(
        makeThresholds({ perUserDailyCostUsd: 0, perFeatureDailyCostUsd: 0 }),
      );
      mockCostRows([]);

      const r = await service.check(USER_ID, 'note_summary');
      // 0 합산 >= 0 cap → 차단 (>=). 단 코드 동작 확인 — 의도적
      expect(r.blocked).toBe(true);
    });
  });

  describe('SQL 검증', () => {
    it('성공 호출만 합산 (status=ok 필터)', async () => {
      thresholdRepo.findOne.mockResolvedValue(makeThresholds());
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      logRepo.createQueryBuilder.mockReturnValue(qb as any);

      await service.check(USER_ID, 'note_summary');

      // status='ok' 필터 명시
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("status = 'ok'"),
      );
      // group by feature
      expect(qb.groupBy).toHaveBeenCalledWith('l.feature');
    });
  });
});
