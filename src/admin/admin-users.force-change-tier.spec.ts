import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { AdminUsersService } from './admin-users.service';
import { AdminAuditService } from './admin-audit.service';
import { User } from '../users/user.entity';
import { Application } from '../applications/application.entity';
import { Inquiry } from '../inquiries/inquiry.entity';
import { UserCoinBalance } from '../ai/entities/user-coin-balance.entity';
import { TierConfig } from '../ai/entities/tier-config.entity';
import { Education } from '../myinfo/entities/education.entity';
import { Experience } from '../myinfo/entities/experience.entity';
import { Cert } from '../myinfo/entities/cert.entity';
import { LanguageCert } from '../myinfo/entities/language-cert.entity';
import { Award } from '../myinfo/entities/award.entity';
import { Document } from '../myinfo/entities/document.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { StorageUsageService } from '../myinfo/storage-usage.service';

/**
 * PR_B2 Phase 3 — forceChangeTier 매트릭스.
 * Q11 (planExpiresAt + quick) + Q2 B (downgrade 다음 cycle) + 사용자 통지 + audit.
 */
const ADMIN = 'admin-uuid';
const USER_ID = 'user-uuid';
const CTX = { ip: '203.0.113.42', userAgent: 'UA' };

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    kakaoId: 'k1',
    nickname: '대상',
    email: null,
    refreshToken: null,
    role: 'user',
    createdAt: new Date(),
    lastActiveAt: null,
    termsAgreedAt: null,
    dashboardConfig: null,
    onboardedAt: null,
    suspendedAt: null,
    aiConsentAt: null,
    aiConsentVersion: null,
    onboardedCoinAt: null,
    suspendReason: null,
    suspendExpiresAt: null,
    pendingNotification: null,
    tier: 'free',
    ...overrides,
  };
}

function makeTierConfig(overrides: Partial<TierConfig> = {}): TierConfig {
  return {
    tier: 'lite',
    monthlyCoinLimit: '800.0',
    inputTokenCapPerCall: 8000,
    defaultCooldownSeconds: 3,
    companyResearchDailyCap: 5,
    noteSummaryCooldownMinutes: 10,
    priceKrw: 4900,
    active: true,
    updatedAt: new Date(),
    ...overrides,
  } as TierConfig;
}

describe('AdminUsersService.forceChangeTier', () => {
  let service: AdminUsersService;
  let manager: jest.Mocked<EntityManager>;
  let dataSource: jest.Mocked<DataSource>;
  let auditLog: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
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
        AdminUsersService,
        {
          provide: getRepositoryToken(User),
          useValue: mock<Repository<User>>(),
        },
        {
          provide: getRepositoryToken(Application),
          useValue: mock<Repository<Application>>(),
        },
        {
          provide: getRepositoryToken(Inquiry),
          useValue: mock<Repository<Inquiry>>(),
        },
        {
          provide: getRepositoryToken(Cert),
          useValue: mock<Repository<Cert>>(),
        },
        {
          provide: getRepositoryToken(Award),
          useValue: mock<Repository<Award>>(),
        },
        {
          provide: getRepositoryToken(LanguageCert),
          useValue: mock<Repository<LanguageCert>>(),
        },
        {
          provide: getRepositoryToken(Experience),
          useValue: mock<Repository<Experience>>(),
        },
        {
          provide: getRepositoryToken(CoverletterCustom),
          useValue: mock<Repository<CoverletterCustom>>(),
        },
        {
          provide: getRepositoryToken(Document),
          useValue: mock<Repository<Document>>(),
        },
        {
          provide: getRepositoryToken(Education),
          useValue: mock<Repository<Education>>(),
        },
        { provide: AdminAuditService, useValue: { log: auditLog } },
        { provide: DataSource, useValue: dataSource },
        {
          provide: StorageUsageService,
          useValue: mock<StorageUsageService>(),
        },
      ],
    }).compile();
    service = module.get(AdminUsersService);
  });

  describe('정상 upgrade (immediate)', () => {
    it('Free → Standard immediate → balance reset = standard monthlyCoinLimit + audit change_plan_with_expires', async () => {
      const future = new Date(Date.now() + 30 * 86400000).toISOString();
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'free' })) // user
        .mockResolvedValueOnce(
          makeTierConfig({ tier: 'standard', monthlyCoinLimit: '1500.0' }),
        ) // tier_config
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '50.0',
        });

      const r = await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'standard',
          planExpiresAt: future,
          applyMode: 'immediate',
          reason: '운영자 보상',
        },
        CTX,
      );

      expect(r.tier).toBe('standard');
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: USER_ID },
        { tier: 'standard' },
      );
      expect(manager.update).toHaveBeenCalledWith(
        UserCoinBalance,
        { userId: USER_ID },
        expect.objectContaining({
          tier: 'standard',
          balance: '1500.0',
        }),
      );
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN,
        'change_plan_with_expires',
        'user',
        USER_ID,
        expect.objectContaining({
          fromTier: 'free',
          toTier: 'standard',
          applyMode: 'immediate',
          appliedImmediately: true,
        }),
        manager,
        CTX,
      );
    });
  });

  describe('정상 downgrade (Q2 B next_cycle)', () => {
    it('Standard → Free next_cycle → tier 유지 + plan_expires_at 셋팅 + audit force_plan_downgrade', async () => {
      const future = new Date(Date.now() + 90 * 86400000).toISOString();
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'standard' }))
        .mockResolvedValueOnce(makeTierConfig({ tier: 'free' }))
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '1000.0',
        });

      const r = await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'free',
          planExpiresAt: future,
          applyMode: 'next_cycle',
          reason: '결제 만료',
        },
        CTX,
      );

      expect(r.tier).toBe('free');
      // tier 그대로 (downgrade 는 cron 이 reset 시점에 처리)
      expect(manager.update).not.toHaveBeenCalledWith(
        User,
        { id: USER_ID },
        { tier: 'free' },
      );
      // plan_expires_at 만 셋팅
      expect(manager.update).toHaveBeenCalledWith(
        UserCoinBalance,
        { userId: USER_ID },
        { planExpiresAt: expect.any(Date) },
      );
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN,
        'force_plan_downgrade',
        'user',
        USER_ID,
        expect.objectContaining({
          fromTier: 'standard',
          toTier: 'free',
          appliedImmediately: false,
        }),
        manager,
        CTX,
      );
    });

    it('Standard → Free immediate → 즉시 강등 + balance reset 0', async () => {
      const future = new Date(Date.now() + 30 * 86400000).toISOString();
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'standard' }))
        .mockResolvedValueOnce(
          makeTierConfig({ tier: 'free', monthlyCoinLimit: '100.0' }),
        )
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '1000.0',
        });

      await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'free',
          planExpiresAt: future,
          applyMode: 'immediate',
          reason: '운영자 강제',
        },
        CTX,
      );

      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: USER_ID },
        { tier: 'free' },
      );
      expect(manager.update).toHaveBeenCalledWith(
        UserCoinBalance,
        { userId: USER_ID },
        expect.objectContaining({
          tier: 'free',
          balance: '100.0',
        }),
      );
    });
  });

  describe('boundary / edge', () => {
    it('same tier no-op + audit 미발생', async () => {
      manager.findOne.mockResolvedValueOnce(makeUser({ tier: 'lite' }));

      const r = await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'lite',
          applyMode: 'immediate',
          reason: '실수',
        },
        CTX,
      );

      expect(r.tier).toBe('lite');
      expect(manager.update).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('planExpiresAt default 30일 (미지정 시)', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'free' }))
        .mockResolvedValueOnce(makeTierConfig({ tier: 'lite' }))
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '0',
        });

      const r = await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'lite',
          applyMode: 'immediate',
          reason: '운영자 부여',
        },
        CTX,
      );

      const days = (r.planExpiresAt!.getTime() - Date.now()) / 86400000;
      expect(days).toBeGreaterThanOrEqual(29);
      expect(days).toBeLessThanOrEqual(31);
    });

    it('과거 planExpiresAt + newTier=lite → BadRequestException', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'free' }))
        .mockResolvedValueOnce(makeTierConfig({ tier: 'lite' }))
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '0',
        });

      await expect(
        service.forceChangeTier(
          ADMIN,
          USER_ID,
          {
            newTier: 'lite',
            planExpiresAt: '2020-01-01T00:00:00Z',
            applyMode: 'immediate',
            reason: 'reason',
          },
          CTX,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('Free 로 변경 + immediate → planExpiresAt = null (무료 무기한)', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'lite' }))
        .mockResolvedValueOnce(makeTierConfig({ tier: 'free' }))
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '500.0',
        });

      const r = await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'free',
          applyMode: 'immediate',
          reason: '운영자 강제 강등',
        },
        CTX,
      );

      expect(r.planExpiresAt).toBeNull();
      // user_coin_balances update — planExpiresAt=null + planStartedAt=null
      const balCall = manager.update.mock.calls.find(
        ([target]) => target === UserCoinBalance,
      );
      expect(
        (balCall![2] as { planExpiresAt: Date | null }).planExpiresAt,
      ).toBeNull();
      expect(
        (balCall![2] as { planStartedAt: Date | null }).planStartedAt,
      ).toBeNull();
    });

    it('Free 로 변경 + next_cycle → planExpiresAt = balance.next_reset_at', async () => {
      const nextReset = new Date('2026-07-01T00:00:00Z');
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'lite' }))
        .mockResolvedValueOnce(makeTierConfig({ tier: 'free' }))
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '500.0',
          nextResetAt: nextReset,
        });

      const r = await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'free',
          applyMode: 'next_cycle',
          reason: '결제 만료 처리',
        },
        CTX,
      );

      expect(r.planExpiresAt).toEqual(nextReset);
    });
  });

  describe('실패 / 보안', () => {
    it('self-tier 변경 차단', async () => {
      await expect(
        service.forceChangeTier(
          USER_ID,
          USER_ID,
          {
            newTier: 'standard',
            applyMode: 'immediate',
            reason: 'self',
          },
          CTX,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('사용자 미존재 → NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.forceChangeTier(
          ADMIN,
          'no-such',
          {
            newTier: 'lite',
            applyMode: 'immediate',
            reason: 'reason',
          },
          CTX,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('tier_config 미존재 (admin 검수 누락) → NotFoundException', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'free' }))
        .mockResolvedValueOnce(null); // tier_config 없음

      await expect(
        service.forceChangeTier(
          ADMIN,
          USER_ID,
          {
            newTier: 'lite',
            applyMode: 'immediate',
            reason: 'reason',
          },
          CTX,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('audit ctx (IP/UA) 정확 전달', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'free' }))
        .mockResolvedValueOnce(makeTierConfig({ tier: 'lite' }))
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '0',
        });

      await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'lite',
          applyMode: 'immediate',
          reason: '운영자',
        },
        CTX,
      );

      expect(auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        manager,
        CTX,
      );
    });
  });

  describe('사용자 통지 (Q24)', () => {
    it('downgrade → pending_notification type=tier_downgrade', async () => {
      const future = new Date(Date.now() + 30 * 86400000).toISOString();
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'standard' }))
        .mockResolvedValueOnce(makeTierConfig({ tier: 'free' }))
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '0',
        });

      await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'free',
          planExpiresAt: future,
          applyMode: 'next_cycle',
          reason: '결제 만료',
        },
        CTX,
      );

      const notifCall = manager.update.mock.calls.find(
        ([target, , value]) =>
          target === User &&
          (value as { pendingNotification?: unknown }).pendingNotification !==
            undefined,
      );
      const notif = (
        notifCall![2] as {
          pendingNotification: { type: string; title: string };
        }
      ).pendingNotification;
      expect(notif.type).toBe('tier_downgrade');
      expect(notif.title).toBe('plan 이 변경되었습니다');
    });

    it('upgrade → pending_notification type=tier_upgrade', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'free' }))
        .mockResolvedValueOnce(makeTierConfig({ tier: 'lite' }))
        .mockResolvedValueOnce({
          userId: USER_ID,
          balance: '0',
        });

      await service.forceChangeTier(
        ADMIN,
        USER_ID,
        {
          newTier: 'lite',
          applyMode: 'immediate',
          reason: '운영자',
        },
        CTX,
      );

      const notifCall = manager.update.mock.calls.find(
        ([target, , value]) =>
          target === User &&
          (value as { pendingNotification?: unknown }).pendingNotification !==
            undefined,
      );
      const notif = (notifCall![2] as { pendingNotification: { type: string } })
        .pendingNotification;
      expect(notif.type).toBe('tier_upgrade');
    });
  });
});
