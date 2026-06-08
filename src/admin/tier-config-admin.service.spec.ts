import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { TierConfigAdminService } from './tier-config-admin.service';
import { AdminAuditService } from './admin-audit.service';
import { TierConfig } from '../ai/entities/tier-config.entity';
import { UserCoinBalance } from '../ai/entities/user-coin-balance.entity';

/**
 * PR_B2 Phase 3 — TierConfigAdminService spec 매트릭스.
 *
 * Q3 C applyMode immediate / next_reset + S2 운영 사고 대비 + audit before/after.
 * 5축 — 정상 / 실패 / boundary / 보안 / 동시성.
 */
const ADMIN = 'admin-uuid';
const CTX = { ip: '203.0.113.42', userAgent: 'Mozilla/5.0' };

function makeTierConfig(overrides: Partial<TierConfig> = {}): TierConfig {
  return {
    tier: 'free',
    monthlyCoinLimit: '100.0',
    inputTokenCapPerCall: 8000,
    defaultCooldownSeconds: 3,
    companyResearchDailyCap: 2,
    noteSummaryCooldownMinutes: 60,
    priceKrw: 0,
    active: true,
    updatedAt: new Date(),
    ...overrides,
  } as TierConfig;
}

describe('TierConfigAdminService', () => {
  let service: TierConfigAdminService;
  let tierRepo: jest.Mocked<Repository<TierConfig>>;
  let balanceRepo: jest.Mocked<Repository<UserCoinBalance>>;
  let dataSource: jest.Mocked<DataSource>;
  let manager: jest.Mocked<EntityManager>;
  let auditLog: jest.Mock;

  beforeEach(async () => {
    tierRepo = mock<Repository<TierConfig>>();
    balanceRepo = mock<Repository<UserCoinBalance>>();
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
        TierConfigAdminService,
        { provide: getRepositoryToken(TierConfig), useValue: tierRepo },
        { provide: getRepositoryToken(UserCoinBalance), useValue: balanceRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: AdminAuditService, useValue: { log: auditLog } },
      ],
    }).compile();
    service = module.get(TierConfigAdminService);
  });

  // ── listAll / getOne / preview ──
  describe('listAll / getOne / preview', () => {
    it('listAll — tier ASC 정렬', async () => {
      tierRepo.find.mockResolvedValue([makeTierConfig()]);
      await service.listAll();
      expect(tierRepo.find).toHaveBeenCalledWith({ order: { tier: 'ASC' } });
    });

    it('getOne 정상', async () => {
      tierRepo.findOne.mockResolvedValue(makeTierConfig({ tier: 'lite' }));
      const r = await service.getOne('lite');
      expect(r.tier).toBe('lite');
    });

    it('getOne 미존재 → NotFoundException', async () => {
      tierRepo.findOne.mockResolvedValue(null);
      await expect(service.getOne('free')).rejects.toThrow(NotFoundException);
    });

    it('preview — count + sample 10', async () => {
      balanceRepo.count.mockResolvedValue(42);
      balanceRepo.find.mockResolvedValue([
        { userId: 'u1', balance: '50.5' } as UserCoinBalance,
      ]);
      const r = await service.getPreview('free');
      expect(r.affectedUsers).toBe(42);
      expect(r.sample[0]).toEqual({ userId: 'u1', balance: 50.5 });
      expect(balanceRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });
  });

  // ── updateTierConfig — applyMode=next_reset ──
  describe('updateTierConfig (next_reset)', () => {
    it('monthly 변경 + next_reset → user_coin_balances 미변경 + audit', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeTierConfig({ monthlyCoinLimit: '100.0' }),
      );
      manager.count.mockResolvedValue(50);

      const r = await service.updateTierConfig(
        ADMIN,
        'free',
        { monthlyCoinLimit: 150, applyMode: 'next_reset' },
        CTX,
      );

      expect(r.affectedUsers).toBe(50);
      expect(manager.query).not.toHaveBeenCalled(); // immediate 만 query
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN,
        'update_tier_config',
        'tier_config',
        'free',
        expect.objectContaining({
          before: expect.objectContaining({ monthlyCoinLimit: 100 }),
          after: expect.objectContaining({ monthlyCoinLimit: 150 }),
          applyMode: 'next_reset',
          affectedUsers: 50,
        }),
        manager,
        CTX,
      );
    });
  });

  // ── updateTierConfig — applyMode=immediate ──
  describe('updateTierConfig (immediate)', () => {
    it('monthlyLimit 100 → 150 + immediate → user 전체 balance += 50', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeTierConfig({ monthlyCoinLimit: '100.0' }),
      );
      // query → 30명 영향
      manager.query.mockResolvedValueOnce(new Array(30).fill({ user_id: 'x' }));

      const r = await service.updateTierConfig(
        ADMIN,
        'free',
        { monthlyCoinLimit: 150, applyMode: 'immediate' },
        CTX,
      );

      expect(r.affectedUsers).toBe(30);
      // SQL: balance += 50
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_coin_balances'),
        [50, 'free'],
      );
    });

    it('monthlyLimit downgrade 150 → 100 + immediate → balance -= 50', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeTierConfig({ monthlyCoinLimit: '150.0' }),
      );
      manager.query.mockResolvedValueOnce(new Array(10).fill({ user_id: 'x' }));

      await service.updateTierConfig(
        ADMIN,
        'free',
        { monthlyCoinLimit: 100, applyMode: 'immediate' },
        CTX,
      );

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_coin_balances'),
        [-50, 'free'],
      );
    });

    it('monthlyLimit 변경 0 (같은 값) + immediate → query 미호출', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeTierConfig({ monthlyCoinLimit: '100.0' }),
      );
      manager.count.mockResolvedValue(20);

      await service.updateTierConfig(
        ADMIN,
        'free',
        { monthlyCoinLimit: 100, applyMode: 'immediate' },
        CTX,
      );

      expect(manager.query).not.toHaveBeenCalled();
    });

    it('monthlyLimit 변경 없이 다른 컬럼만 + immediate → query 미호출', async () => {
      manager.findOne.mockResolvedValueOnce(makeTierConfig());
      manager.count.mockResolvedValue(20);

      await service.updateTierConfig(
        ADMIN,
        'free',
        { defaultCooldownSeconds: 5, applyMode: 'immediate' },
        CTX,
      );

      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  // ── 컬럼별 partial update ──
  describe('partial update', () => {
    it('inputTokenCapPerCall 단독 변경', async () => {
      manager.findOne.mockResolvedValueOnce(makeTierConfig());
      manager.count.mockResolvedValue(0);

      await service.updateTierConfig(
        ADMIN,
        'free',
        { inputTokenCapPerCall: 16000, applyMode: 'next_reset' },
        CTX,
      );

      expect(manager.save).toHaveBeenCalledWith(
        TierConfig,
        expect.objectContaining({ inputTokenCapPerCall: 16000 }),
      );
    });

    it('active=false (kill switch) 단독', async () => {
      manager.findOne.mockResolvedValueOnce(makeTierConfig({ active: true }));
      manager.count.mockResolvedValue(0);

      await service.updateTierConfig(
        ADMIN,
        'lite',
        { active: false, applyMode: 'next_reset' },
        CTX,
      );

      expect(manager.save).toHaveBeenCalledWith(
        TierConfig,
        expect.objectContaining({ active: false }),
      );
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN,
        'update_tier_config',
        'tier_config',
        'lite',
        expect.objectContaining({
          before: expect.objectContaining({ active: true }),
          after: expect.objectContaining({ active: false }),
        }),
        manager,
        CTX,
      );
    });

    it('priceKrw 변경 — 별도 영향 없음', async () => {
      manager.findOne.mockResolvedValueOnce(makeTierConfig({ priceKrw: 0 }));
      manager.count.mockResolvedValue(5);

      await service.updateTierConfig(
        ADMIN,
        'lite',
        { priceKrw: 4900, applyMode: 'next_reset' },
        CTX,
      );

      expect(manager.save).toHaveBeenCalledWith(
        TierConfig,
        expect.objectContaining({ priceKrw: 4900 }),
      );
    });
  });

  // ── 실패 / 보안 ──
  describe('실패 / 보안', () => {
    it('미존재 tier → NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);

      await expect(
        service.updateTierConfig(
          ADMIN,
          'free',
          { monthlyCoinLimit: 100, applyMode: 'next_reset' },
          CTX,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('audit ctx (IP/UA) 정확 전달', async () => {
      manager.findOne.mockResolvedValueOnce(makeTierConfig());
      manager.count.mockResolvedValue(0);

      await service.updateTierConfig(
        ADMIN,
        'free',
        { monthlyCoinLimit: 110, applyMode: 'next_reset' },
        CTX,
      );

      expect(auditLog).toHaveBeenCalledWith(
        ADMIN,
        'update_tier_config',
        'tier_config',
        'free',
        expect.anything(),
        manager,
        CTX,
      );
    });
  });
});
