import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { FeatureCoinMetaAdminService } from './feature-coin-meta-admin.service';
import { AdminAuditService } from './admin-audit.service';
import { FeatureCoinMeta } from '../ai/entities/feature-coin-meta.entity';

const ADMIN = 'admin-uuid';
const CTX = { ip: '203.0.113.42', userAgent: 'UA' };

function makeMeta(overrides: Partial<FeatureCoinMeta> = {}): FeatureCoinMeta {
  return {
    feature: 'company_research',
    chargesCoins: true,
    avgCoinCost: '50.0',
    fixedCoinCost: 50,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('FeatureCoinMetaAdminService', () => {
  let service: FeatureCoinMetaAdminService;
  let repo: jest.Mocked<Repository<FeatureCoinMeta>>;
  let dataSource: jest.Mocked<DataSource>;
  let manager: jest.Mocked<EntityManager>;
  let auditLog: jest.Mock;

  beforeEach(async () => {
    repo = mock<Repository<FeatureCoinMeta>>();
    manager = mock<EntityManager>();
    manager.create.mockImplementation(
      (_t: unknown, input: unknown) => ({ ...(input as object) }) as never,
    );
    manager.save.mockImplementation(async (_t: unknown, input: unknown) => ({
      ...(input as object),
    }));
    auditLog = jest.fn().mockResolvedValue(undefined);

    dataSource = mock<DataSource>();
    dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureCoinMetaAdminService,
        { provide: getRepositoryToken(FeatureCoinMeta), useValue: repo },
        { provide: DataSource, useValue: dataSource },
        { provide: AdminAuditService, useValue: { log: auditLog } },
      ],
    }).compile();
    service = module.get(FeatureCoinMetaAdminService);
  });

  describe('listAll / getOne', () => {
    it('listAll — feature ASC', async () => {
      repo.find.mockResolvedValue([makeMeta()]);
      await service.listAll();
      expect(repo.find).toHaveBeenCalledWith({ order: { feature: 'ASC' } });
    });

    it('getOne 정상', async () => {
      repo.findOne.mockResolvedValue(makeMeta());
      const r = await service.getOne('company_research');
      expect(r.feature).toBe('company_research');
    });

    it('getOne 미존재 → NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getOne('unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateFeatureCoinMeta — 정상', () => {
    it('fixedCoinCost 50 → 70 변경 + audit', async () => {
      manager.findOne.mockResolvedValueOnce(makeMeta({ fixedCoinCost: 50 }));

      const r = await service.updateFeatureCoinMeta(
        ADMIN,
        'company_research',
        { fixedCoinCost: 70 },
        CTX,
      );

      expect(r.fixedCoinCost).toBe(70);
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN,
        'update_feature_coin_meta',
        'feature_coin_meta',
        'company_research',
        expect.objectContaining({
          before: expect.objectContaining({ fixedCoinCost: 50 }),
          after: expect.objectContaining({ fixedCoinCost: 70 }),
        }),
        manager,
        CTX,
      );
    });

    it('avgCoinCost 변경 — 소수 정밀도 (12.5)', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeMeta({ avgCoinCost: '10.0', fixedCoinCost: null }),
      );

      await service.updateFeatureCoinMeta(
        ADMIN,
        'note_summary',
        { avgCoinCost: 12, chargesCoins: true },
        CTX,
      );

      expect(manager.save).toHaveBeenCalledWith(
        FeatureCoinMeta,
        expect.objectContaining({ avgCoinCost: '12.0' }),
      );
    });

    it('description 변경', async () => {
      manager.findOne.mockResolvedValueOnce(makeMeta());

      await service.updateFeatureCoinMeta(
        ADMIN,
        'company_research',
        { description: '회사조사 50 코인 고정' },
        CTX,
      );

      expect(manager.save).toHaveBeenCalledWith(
        FeatureCoinMeta,
        expect.objectContaining({ description: '회사조사 50 코인 고정' }),
      );
    });

    it('chargesCoins=false 변경 (free feature)', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeMeta({ chargesCoins: true, fixedCoinCost: 50 }),
      );

      await service.updateFeatureCoinMeta(
        ADMIN,
        'company_research',
        { chargesCoins: false },
        CTX,
      );

      expect(manager.save).toHaveBeenCalledWith(
        FeatureCoinMeta,
        expect.objectContaining({ chargesCoins: false }),
      );
    });
  });

  describe('semantic validation', () => {
    it('chargesCoins=true + fixedCoinCost=null + avgCoinCost=0 → BadRequestException', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeMeta({
          chargesCoins: false,
          fixedCoinCost: null,
          avgCoinCost: '0.0',
        }),
      );

      await expect(
        service.updateFeatureCoinMeta(
          ADMIN,
          'company_research',
          { chargesCoins: true },
          CTX,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('chargesCoins=true + avgCoinCost 명시 → 통과', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeMeta({
          chargesCoins: false,
          fixedCoinCost: null,
          avgCoinCost: '0.0',
        }),
      );

      const r = await service.updateFeatureCoinMeta(
        ADMIN,
        'company_research',
        { chargesCoins: true, avgCoinCost: 10 },
        CTX,
      );

      expect(r.chargesCoins).toBe(true);
    });
  });

  describe('실패 / 보안', () => {
    it('미존재 feature → NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.updateFeatureCoinMeta(
          ADMIN,
          'unknown',
          { fixedCoinCost: 50 },
          CTX,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('audit ctx (IP/UA) 정확 전달', async () => {
      manager.findOne.mockResolvedValueOnce(makeMeta());

      await service.updateFeatureCoinMeta(
        ADMIN,
        'company_research',
        { fixedCoinCost: 60 },
        CTX,
      );

      expect(auditLog).toHaveBeenCalledWith(
        expect.anything(),
        'update_feature_coin_meta',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        manager,
        CTX,
      );
    });
  });
});
