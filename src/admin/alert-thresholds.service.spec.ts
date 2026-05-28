import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { AdminAuditService } from './admin-audit.service';
import { AlertThresholdsService } from './alert-thresholds.service';
import { AlertHistory } from './entities/alert-history.entity';
import { AlertThresholds } from './entities/alert-thresholds.entity';

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
    const baseRow = (): AlertThresholds =>
      ({
        id: 1,
        dailyCostThresholdUsd: 50,
        hourlyErrorRateThreshold: 0.1,
        vsYesterdayIncreaseThreshold: 200,
        enabled: true,
        updatedBy: null,
      }) as AlertThresholds;

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
        expect.objectContaining({ before: expect.anything(), after: expect.anything() }),
      );
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
});
