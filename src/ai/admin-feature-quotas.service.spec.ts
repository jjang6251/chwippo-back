import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository } from 'typeorm';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminFeatureQuotasService } from './admin-feature-quotas.service';
import { FeatureQuotaConfig } from './entities/feature-quota-config.entity';

/**
 * F6 PR 2 Phase 1 — AdminFeatureQuotasService spec.
 *
 * 시나리오:
 * - listAll (정렬 OK)
 * - getOne (존재 / 없음 / 잘못된 feature·tier)
 * - update: 변경 사항만 적용 + audit 기록
 * - update: 변경 없음 → audit 미발생
 * - update: dayLimit > monthLimit invariant 위반 → BadRequest
 * - update: enabled false 만 토글 (kill switch)
 * - update: 없는 feature/tier → NotFound / BadRequest
 */
describe('AdminFeatureQuotasService', () => {
  let service: AdminFeatureQuotasService;
  let repo: jest.Mocked<Repository<FeatureQuotaConfig>>;
  let auditService: jest.Mocked<AdminAuditService>;

  const ADMIN = 'admin-1';

  const makeRow = (
    overrides: Partial<FeatureQuotaConfig> = {},
  ): FeatureQuotaConfig =>
    ({
      feature: 'note_summary',
      tier: 'free',
      dayLimit: 30,
      monthLimit: 300,
      cooldownSeconds: 30,
      enabled: true,
      updatedBy: null,
      updatedAt: new Date(),
      ...overrides,
    }) as FeatureQuotaConfig;

  beforeEach(async () => {
    repo = mock<Repository<FeatureQuotaConfig>>();
    auditService = mock<AdminAuditService>();
    repo.save.mockImplementation(async (r) => r as FeatureQuotaConfig);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminFeatureQuotasService,
        {
          provide: getRepositoryToken(FeatureQuotaConfig),
          useValue: repo,
        },
        { provide: AdminAuditService, useValue: auditService },
      ],
    }).compile();
    service = module.get<AdminFeatureQuotasService>(AdminFeatureQuotasService);
  });

  describe('listAll', () => {
    it('feature ASC, tier ASC 정렬', async () => {
      repo.find.mockResolvedValue([makeRow(), makeRow({ tier: 'lite' })]);
      const r = await service.listAll();
      expect(r).toHaveLength(2);
      expect(repo.find).toHaveBeenCalledWith({
        order: { feature: 'ASC', tier: 'ASC' },
      });
    });
  });

  describe('getOne', () => {
    it('정상 — row 반환', async () => {
      repo.findOne.mockResolvedValue(makeRow());
      const r = await service.getOne('note_summary', 'free');
      expect(r.feature).toBe('note_summary');
    });

    it('row 없음 → NotFound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.getOne('note_summary', 'free'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('feature 잘못된 값 → BadRequest', async () => {
      await expect(service.getOne('UNKNOWN', 'free')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('tier 잘못된 값 → BadRequest', async () => {
      await expect(
        service.getOne('note_summary', 'enterprise2'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('정상 — dayLimit 만 변경 + audit 기록', async () => {
      const row = makeRow({ dayLimit: 30 });
      repo.findOne.mockResolvedValue(row);
      const r = await service.update(ADMIN, 'note_summary', 'free', {
        dayLimit: 50,
      });
      expect(r.dayLimit).toBe(50);
      expect(r.updatedBy).toBe(ADMIN);
      expect(repo.save).toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        ADMIN,
        'update_ai_quota',
        'feature_quota',
        'note_summary:free',
        expect.objectContaining({
          feature: 'note_summary',
          tier: 'free',
          before: expect.objectContaining({ dayLimit: 30 }),
          after: expect.objectContaining({ dayLimit: 50 }),
        }),
      );
    });

    it('변경 없음 → audit 미발생 + save 미호출', async () => {
      const row = makeRow();
      repo.findOne.mockResolvedValue(row);
      await service.update(ADMIN, 'note_summary', 'free', {
        dayLimit: 30, // 동일
      });
      expect(repo.save).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('kill switch — enabled=false 만 토글', async () => {
      const row = makeRow({ enabled: true });
      repo.findOne.mockResolvedValue(row);
      const r = await service.update(ADMIN, 'note_summary', 'free', {
        enabled: false,
      });
      expect(r.enabled).toBe(false);
      expect(auditService.log).toHaveBeenCalledWith(
        ADMIN,
        'update_ai_quota',
        'feature_quota',
        'note_summary:free',
        expect.objectContaining({
          after: expect.objectContaining({ enabled: false }),
        }),
      );
    });

    it('dayLimit > monthLimit invariant 위반 → BadRequest', async () => {
      const row = makeRow({ dayLimit: 10, monthLimit: 100 });
      repo.findOne.mockResolvedValue(row);
      await expect(
        service.update(ADMIN, 'note_summary', 'free', {
          dayLimit: 200,
          monthLimit: 100,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('row 없음 → NotFound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.update(ADMIN, 'note_summary', 'free', { dayLimit: 5 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cooldown 만 변경 → cooldown audit 기록', async () => {
      const row = makeRow({ cooldownSeconds: 30 });
      repo.findOne.mockResolvedValue(row);
      const r = await service.update(ADMIN, 'note_summary', 'free', {
        cooldownSeconds: 120,
      });
      expect(r.cooldownSeconds).toBe(120);
      expect(auditService.log).toHaveBeenCalledWith(
        ADMIN,
        'update_ai_quota',
        'feature_quota',
        'note_summary:free',
        expect.objectContaining({
          before: expect.objectContaining({ cooldownSeconds: 30 }),
          after: expect.objectContaining({ cooldownSeconds: 120 }),
        }),
      );
    });

    it('여러 필드 동시 변경 → audit 1건 (before/after 묶음)', async () => {
      const row = makeRow();
      repo.findOne.mockResolvedValue(row);
      await service.update(ADMIN, 'note_summary', 'free', {
        dayLimit: 50,
        monthLimit: 500,
        enabled: false,
      });
      expect(auditService.log).toHaveBeenCalledTimes(1);
    });
  });
});
