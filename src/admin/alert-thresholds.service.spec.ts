import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { CostGuardService } from '../ai/cost-guard.service';
import { AdminAuditService } from './admin-audit.service';
import { AlertThresholdsService } from './alert-thresholds.service';
import { AlertHistory } from './entities/alert-history.entity';
import { AlertThresholds } from './entities/alert-thresholds.entity';

const mockCostGuard = { invalidate: jest.fn() };

describe('AlertThresholdsService', () => {
  let service: AlertThresholdsService;
  let repo: jest.Mocked<Repository<AlertThresholds>>;
  let historyRepo: jest.Mocked<Repository<AlertHistory>>;
  let audit: jest.Mocked<AdminAuditService>;

  beforeEach(async () => {
    repo = mock<Repository<AlertThresholds>>();
    historyRepo = mock<Repository<AlertHistory>>();
    audit = mock<AdminAuditService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertThresholdsService,
        { provide: getRepositoryToken(AlertThresholds), useValue: repo },
        { provide: getRepositoryToken(AlertHistory), useValue: historyRepo },
        { provide: AdminAuditService, useValue: audit },
        { provide: CostGuardService, useValue: mockCostGuard },
      ],
    }).compile();
    service = module.get(AlertThresholdsService);
  });

  describe('get', () => {
    it('row 존재 → 그대로 반환', async () => {
      const row = {
        id: 1,
        dailyCostThresholdUsd: 50,
      } as AlertThresholds;
      repo.findOne.mockResolvedValue(row);
      expect(await service.get()).toBe(row);
    });

    it('row 없음 → NotFoundException (자동 생성 X)', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.get()).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    /**
     * 🔴 **엔티티의 전 컬럼을 채운다.** 예전엔 5개짜리 부분 객체에 `as AlertThresholds`
     * 를 씌웠는데, 그러면 "감사 스냅샷에 전 필드가 담기는가" 같은 걸 검증할 수 없다 —
     * 픽스처에 없는 필드는 코드가 담아도 안 담아도 똑같이 통과한다.
     * 컬럼이 추가되면 여기 컴파일 에러로 드러나는 게 맞다.
     */
    const baseRow = (): AlertThresholds => ({
      id: 1,
      dailyCostThresholdUsd: 50,
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
      aiOutageAlertCount10m: 3,
      aiOutageAlertCooldownMin: 30,
      outputTruncationCount1h: 3,
      chargedFailureCount1h: 1,
      updatedBy: null,
      updatedByUser: null,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    });

    it('정상 변경 + audit log', async () => {
      const row = baseRow();
      repo.findOne.mockResolvedValue(row);
      repo.save.mockImplementation(async (r) => r as AlertThresholds);

      const result = await service.update('admin-1', {
        dailyCostThresholdUsd: 100,
      });
      expect(result.dailyCostThresholdUsd).toBe(100);
      expect(result.updatedBy).toBe('admin-1');
      expect(audit.log).toHaveBeenCalledWith(
        'admin-1',
        'update_alert_thresholds',
        'alert_thresholds',
        '1',
        expect.objectContaining({
          before: expect.anything(),
          after: expect.anything(),
        }),
      );
    });

    /**
     * 🔴 2026-08-06 실사고 회귀 — `perFeatureDailyCostUsd` 가 0 이 되어 전 기능 AI 가
     *    사흘간 죽었는데, 감사 로그의 before/after 에 **그 필드가 아예 없어서**
     *    누가 언제 바꿨는지 끝내 알 수 없었다.
     *
     *    위 '정상 변경 + audit log' 는 `expect.anything()` 이라 이 누락을 통과시켰다.
     *    스냅샷은 **값까지** 봐야 한다.
     */
    it('🔴 감사 로그에 cost cap 변경이 값까지 기록된다', async () => {
      const row = baseRow();
      row.perFeatureDailyCostUsd = 5;
      repo.findOne.mockResolvedValue(row);
      repo.save.mockImplementation(async (r) => r as AlertThresholds);

      await service.update('admin-1', { perFeatureDailyCostUsd: 0 });

      const payload = (audit.log as jest.Mock).mock.calls[0][4] as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      expect(payload.before.perFeatureDailyCostUsd).toBe(5);
      expect(payload.after.perFeatureDailyCostUsd).toBe(0);
    });

    it('🔴 스냅샷은 전 임계치를 담는다 — 새 필드가 추가돼도 자동 포함', async () => {
      const row = baseRow();
      repo.findOne.mockResolvedValue(row);
      repo.save.mockImplementation(async (r) => r as AlertThresholds);

      await service.update('admin-1', { enabled: false });

      const payload = (audit.log as jest.Mock).mock.calls[0][4] as {
        before: Record<string, unknown>;
      };
      // 예전엔 4개만 담겨 13개가 흔적 없이 바뀌었다
      for (const key of [
        'perUserDailyCostUsd',
        'perFeatureDailyCostUsd',
        'abuserSuspectDailyCalls',
        'aiOutageAlertCount10m',
        'outputTruncationCount1h',
      ]) {
        expect(payload.before).toHaveProperty(key);
      }
      // id·감사 메타는 스냅샷에 넣지 않는다 (변경 대상이 아니다)
      expect(payload.before).not.toHaveProperty('id');
      expect(payload.before).not.toHaveProperty('updatedBy');
      // 🔴 User 관계는 PII — 감사 로그에 절대 담기지 않는다
      expect(payload.before).not.toHaveProperty('updatedByUser');
    });

    it('enabled=false 토글 (kill switch)', async () => {
      const row = baseRow();
      repo.findOne.mockResolvedValue(row);
      repo.save.mockImplementation(async (r) => r as AlertThresholds);
      const result = await service.update('admin-1', { enabled: false });
      expect(result.enabled).toBe(false);
    });

    it('undefined 필드는 보존 (partial PATCH)', async () => {
      const row = baseRow();
      repo.findOne.mockResolvedValue(row);
      repo.save.mockImplementation(async (r) => r as AlertThresholds);
      const result = await service.update('admin-1', {
        hourlyErrorRateThreshold: 0.05,
      });
      expect(result.dailyCostThresholdUsd).toBe(50); // unchanged
      expect(result.hourlyErrorRateThreshold).toBe(0.05);
    });
  });

  describe('recentHistory', () => {
    it('최근 24h limit 50 desc 정렬', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      } as unknown as SelectQueryBuilder<AlertHistory>;
      historyRepo.createQueryBuilder.mockReturnValue(qb);
      await service.recentHistory();
      expect(qb.orderBy).toHaveBeenCalledWith('h.created_at', 'DESC');
      expect(qb.limit).toHaveBeenCalledWith(50);
    });
  });
  // cost hardening 🟡3 — 임계치 저장 즉시 CostGuard 캐시 무효화
  describe('costGuard invalidate (🟡3)', () => {
    it('update 성공 → costGuard.invalidate 1회 호출 (기존엔 최대 5분 stale)', async () => {
      mockCostGuard.invalidate.mockClear(); // 모듈 레벨 mock — 이전 update 테스트 호출분 제거
      repo.findOne.mockResolvedValue({ id: 1 } as AlertThresholds);
      repo.save.mockImplementation((r) =>
        Promise.resolve(r as AlertThresholds),
      );

      await service.update('admin-1', { perUserDailyCostUsd: 1.0 });

      expect(mockCostGuard.invalidate).toHaveBeenCalledTimes(1);
    });
  });
});
