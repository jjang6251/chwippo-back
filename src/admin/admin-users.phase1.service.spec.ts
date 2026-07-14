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
import { Education } from '../myinfo/entities/education.entity';
import { Experience } from '../myinfo/entities/experience.entity';
import { Cert } from '../myinfo/entities/cert.entity';
import { LanguageCert } from '../myinfo/entities/language-cert.entity';
import { Award } from '../myinfo/entities/award.entity';
import { Document } from '../myinfo/entities/document.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { AdminNotifyService } from '../notifications/admin-notify.service';
import { DiscordNotifier } from '../common/discord-notifier';

const mockDiscord = {
  notify: jest.fn().mockResolvedValue('sent'),
};

/**
 * PR_B2 Phase 1.5 — admin 자산 개입 endpoint 의 spec 매트릭스 (~50 케이스).
 *
 * 5축 cover — 정상 / 실패 / boundary / 보안 / 동시성.
 * CEO 명시 "admin = 사용자 자산 직접 개입 → 꼼꼼하게".
 */

const ADMIN_ID = 'admin-uuid';
const TARGET_ID = 'user-uuid';
const CTX = { ip: '203.0.113.42', userAgent: 'Mozilla/5.0 Test' };

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: TARGET_ID,
    kakaoId: 'kakao-1',
    appleSub: null,
    appleEmail: null,
    nickname: '대상유저',
    email: 'target@test.com',
    role: 'user',
    createdAt: new Date('2026-01-01'),
    lastActiveAt: null,
    termsAgreedAt: new Date('2026-01-01'),
    dashboardConfig: null,
    alarmConfig: null,
    alarmPromptedAt: null,
    alarmPermissionGranted: false,
    onboardedAt: null,
    suspendedAt: null,
    aiConsentAt: null,
    aiConsentVersion: null,
    onboardedCoinAt: null,
    suspendReason: null,
    suspendExpiresAt: null,
    pendingNotification: null,
    signupJobCategories: null,
    signupOtherText: null,
    sampleCardsDismissedAt: null,
    calendarHomeIntroDismissedAt: null,
    sessionExpiredNotifiedAt: null,
    tier: 'free',
    ...overrides,
  };
}

function makeBalance(
  overrides: Partial<UserCoinBalance> = {},
): UserCoinBalance {
  return {
    userId: TARGET_ID,
    tier: 'free',
    balance: '100.0',
    nextResetAt: new Date('2026-07-01'),
    planExpiresAt: null,
    planStartedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as UserCoinBalance;
}

describe('AdminUsersService — Phase 1.5 spec 매트릭스', () => {
  let service: AdminUsersService;
  let manager: jest.Mocked<EntityManager>;
  let auditLog: jest.Mock;
  let dataSource: jest.Mocked<DataSource>;

  beforeEach(async () => {
    jest.clearAllMocks();

    manager = mock<EntityManager>();
    // manager.create — entity 인스턴스 생성 흉내
    manager.create.mockImplementation(
      (_target: unknown, input: unknown) => ({ ...(input as object) }) as never,
    );
    manager.save.mockImplementation(
      async (_target: unknown, input: unknown) => ({ ...(input as object) }),
    );

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
        {
          provide: AdminNotifyService,
          useValue: {
            notifySuspended: jest.fn().mockResolvedValue(undefined),
            notifyUnsuspended: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: DiscordNotifier, useValue: mockDiscord },
      ],
    }).compile();

    service = module.get(AdminUsersService);
  });

  // ── grantCoin ─────────────────────────────────────────────────────────
  describe('grantCoin (Q1 + Q26)', () => {
    const dto = { amount: 50, reason: 'refund' as const, memo: '문의 환불' };

    it('정상 grant — balance += amount + pending_notification + audit grant_coin (TX + IP/UA)', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance({ balance: '100.0' }));

      const r = await service.grantCoin(ADMIN_ID, TARGET_ID, dto, CTX);

      expect(r).toEqual({ balance: 150, granted: 50 });
      expect(manager.update).toHaveBeenCalledWith(
        UserCoinBalance,
        { userId: TARGET_ID },
        { balance: '150.0' },
      );
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: TARGET_ID },
        expect.objectContaining({
          pendingNotification: expect.objectContaining({
            type: 'coin_grant',
            title: '코인이 지급되었어요',
          }),
        }),
      );
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN_ID,
        'grant_coin',
        'user',
        TARGET_ID,
        expect.objectContaining({
          amount: 50,
          reason: 'refund',
          memo: '문의 환불',
          balanceBefore: 100,
          balanceAfter: 150,
          selfGrant: false,
        }),
        manager,
        CTX,
      );
      // 타인 지급 → Discord critical 미발송
      expect(mockDiscord.notify).not.toHaveBeenCalled();
    });

    // CEO 확정 B안 — 셀프 지급 "차단 → 허용 + 투명성 강제" (1인 운영 도그푸딩).
    // 기존 "self-grant 차단 — ForbiddenException" 케이스를 B안 동작으로 교체.
    it('self-grant 허용 (B안) — 성공 + audit selfGrant=true + Discord critical 발송', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser({ id: ADMIN_ID }))
        .mockResolvedValueOnce(
          makeBalance({ userId: ADMIN_ID, balance: '0.0' }),
        );

      const r = await service.grantCoin(ADMIN_ID, ADMIN_ID, dto, CTX);

      expect(r).toEqual({ balance: 50, granted: 50 });
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN_ID,
        'grant_coin',
        'user',
        ADMIN_ID,
        expect.objectContaining({ selfGrant: true }),
        manager,
        CTX,
      );
      expect(mockDiscord.notify).toHaveBeenCalledTimes(1);
      expect(mockDiscord.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: '🪙 admin 셀프 코인 지급' }),
        'critical',
      );
    });

    it('self-grant — Discord 발송이 reject 돼도 지급 결과 정상 반환 (best-effort)', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser({ id: ADMIN_ID }))
        .mockResolvedValueOnce(
          makeBalance({ userId: ADMIN_ID, balance: '10.0' }),
        );
      mockDiscord.notify.mockRejectedValueOnce(new Error('webhook down'));

      const r = await service.grantCoin(ADMIN_ID, ADMIN_ID, dto, CTX);

      expect(r).toEqual({ balance: 60, granted: 50 });
    });

    it('사용자 미존재 — NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);

      await expect(
        service.grantCoin(ADMIN_ID, 'no-such', dto, CTX),
      ).rejects.toThrow(NotFoundException);
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('balance row 미존재 — 자동 생성 후 grant', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser({ tier: 'lite' }))
        .mockResolvedValueOnce(null); // balance 없음

      const r = await service.grantCoin(ADMIN_ID, TARGET_ID, dto, CTX);

      expect(manager.save).toHaveBeenCalledWith(
        UserCoinBalance,
        expect.objectContaining({ userId: TARGET_ID, tier: 'lite' }),
      );
      expect(r.granted).toBe(50);
    });

    it('memo 없을 때 — pending_notification body 에 메모 줄 없음', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance());

      await service.grantCoin(
        ADMIN_ID,
        TARGET_ID,
        { amount: 10, reason: 'bonus' },
        CTX,
      );

      const updateCall = manager.update.mock.calls.find(
        ([target]) => target === User,
      );
      const body = (updateCall![2] as { pendingNotification: { body: string } })
        .pendingNotification.body;
      expect(body).toContain('보너스');
      expect(body).not.toContain('메모');
    });

    it('reason 한국어 라벨 매핑 — refund → "환불"', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance());

      await service.grantCoin(ADMIN_ID, TARGET_ID, dto, CTX);

      const updateCall = manager.update.mock.calls.find(
        ([target]) => target === User,
      );
      const body = (updateCall![2] as { pendingNotification: { body: string } })
        .pendingNotification.body;
      expect(body).toContain('환불');
    });

    it('audit ctx (IP/UA) 미전달 시 undefined 그대로 전파', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance());

      await service.grantCoin(ADMIN_ID, TARGET_ID, dto);

      expect(auditLog).toHaveBeenCalledWith(
        ADMIN_ID,
        'grant_coin',
        'user',
        TARGET_ID,
        expect.anything(),
        manager,
        undefined,
      );
    });
  });

  // ── revokeCoin ────────────────────────────────────────────────────────
  describe('revokeCoin (Q12 + Q26)', () => {
    const dto = { amount: 30, reason: 'mistake' as const };

    it('정상 revoke — balance -= amount + audit revoke_coin', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance({ balance: '100.0' }));

      const r = await service.revokeCoin(ADMIN_ID, TARGET_ID, dto, CTX);

      expect(r).toEqual({ balance: 70, actualRevoked: 30, requested: 30 });
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN_ID,
        'revoke_coin',
        'user',
        TARGET_ID,
        expect.objectContaining({
          requested: 30,
          actualRevoked: 30,
          before: 100,
          after: 70,
        }),
        manager,
        CTX,
      );
    });

    it('balance < amount → clamp 0 + actualRevoked = balance', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance({ balance: '20.0' }));

      const r = await service.revokeCoin(
        ADMIN_ID,
        TARGET_ID,
        { amount: 100, reason: 'mistake' },
        CTX,
      );

      expect(r).toEqual({ balance: 0, actualRevoked: 20, requested: 100 });
    });

    it('balance = amount boundary — 정확 0', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance({ balance: '30.0' }));

      const r = await service.revokeCoin(ADMIN_ID, TARGET_ID, dto, CTX);

      expect(r.balance).toBe(0);
      expect(r.actualRevoked).toBe(30);
    });

    it('balance = 0 → BadRequestException (Q26 — 이미 0 이하)', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance({ balance: '0' }));

      await expect(
        service.revokeCoin(ADMIN_ID, TARGET_ID, dto, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('balance < 0 (마이너스 carry-over) → reject', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance({ balance: '-5.0' }));

      await expect(
        service.revokeCoin(ADMIN_ID, TARGET_ID, dto, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('balance row 미존재 → BadRequestException', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(null);

      await expect(
        service.revokeCoin(ADMIN_ID, TARGET_ID, dto, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('self-revoke 차단', async () => {
      await expect(
        service.revokeCoin(TARGET_ID, TARGET_ID, dto, CTX),
      ).rejects.toThrow(ForbiddenException);
    });

    it('사용자 미존재 → NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.revokeCoin(ADMIN_ID, TARGET_ID, dto, CTX),
      ).rejects.toThrow(NotFoundException);
    });

    it('pending_notification 셋팅 — coin_revoke type + 한국어 라벨', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeBalance({ balance: '100.0' }));

      await service.revokeCoin(ADMIN_ID, TARGET_ID, dto, CTX);

      const updateCall = manager.update.mock.calls.find(
        ([target]) => target === User,
      );
      const notif = (
        updateCall![2] as {
          pendingNotification: { type: string; body: string };
        }
      ).pendingNotification;
      expect(notif.type).toBe('coin_revoke');
      expect(notif.body).toContain('잘못 지급 회수');
    });
  });

  // ── suspendUser ───────────────────────────────────────────────────────
  describe('suspendUser (Q13 + Q25)', () => {
    const dto = { reason: '약관 위반 — 도배', expiresAt: undefined };

    it('정상 정지 (영구) — suspended_at=NOW + reason + expiresAt=null + audit suspend', async () => {
      manager.findOne.mockResolvedValueOnce(makeUser());

      const r = await service.suspendUser(ADMIN_ID, TARGET_ID, dto, CTX);

      expect(r.suspendReason).toBe('약관 위반 — 도배');
      expect(r.suspendExpiresAt).toBeNull();
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: TARGET_ID },
        expect.objectContaining({
          suspendedAt: expect.any(Date),
          suspendReason: '약관 위반 — 도배',
          suspendExpiresAt: null,
        }),
      );
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN_ID,
        'suspend',
        'user',
        TARGET_ID,
        expect.objectContaining({
          reason: '약관 위반 — 도배',
          expiresAt: null,
        }),
        manager,
        CTX,
      );
    });

    it('만료 정지 (7일 후) — expiresAt 보존', async () => {
      const future = new Date(Date.now() + 7 * 86400000).toISOString();
      manager.findOne.mockResolvedValueOnce(makeUser());

      const r = await service.suspendUser(
        ADMIN_ID,
        TARGET_ID,
        { reason: '경고 후 재발', expiresAt: future },
        CTX,
      );

      expect(r.suspendExpiresAt).toEqual(new Date(future));
    });

    it('이미 정지 시 — audit update_suspend_reason + before/after', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeUser({
          suspendedAt: new Date('2026-05-01'),
          suspendReason: '이전 사유',
          suspendExpiresAt: null,
        }),
      );

      await service.suspendUser(ADMIN_ID, TARGET_ID, dto, CTX);

      expect(auditLog).toHaveBeenCalledWith(
        ADMIN_ID,
        'update_suspend_reason',
        'user',
        TARGET_ID,
        expect.objectContaining({
          before: expect.objectContaining({ reason: '이전 사유' }),
          after: expect.objectContaining({ reason: '약관 위반 — 도배' }),
        }),
        manager,
        CTX,
      );
    });

    it('이미 정지 시 — suspended_at 유지 (재정지 X)', async () => {
      const prevSuspendedAt = new Date('2026-05-01');
      manager.findOne.mockResolvedValueOnce(
        makeUser({ suspendedAt: prevSuspendedAt }),
      );

      const r = await service.suspendUser(ADMIN_ID, TARGET_ID, dto, CTX);

      expect(r.suspendedAt).toEqual(prevSuspendedAt);
    });

    it('self-suspend 차단', async () => {
      await expect(
        service.suspendUser(TARGET_ID, TARGET_ID, dto, CTX),
      ).rejects.toThrow(ForbiddenException);
    });

    it('admin 끼리 정지 차단 (Q25) — target.role==admin → ForbiddenException', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeUser({ id: 'other-admin', role: 'admin' }),
      );

      await expect(
        service.suspendUser(ADMIN_ID, 'other-admin', dto, CTX),
      ).rejects.toThrow(/admin 계정은 정지할 수 없습니다/);
    });

    it('과거 expiresAt → BadRequestException', async () => {
      manager.findOne.mockResolvedValueOnce(makeUser());

      await expect(
        service.suspendUser(
          ADMIN_ID,
          TARGET_ID,
          { reason: '...', expiresAt: '2020-01-01T00:00:00Z' },
          CTX,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('사용자 미존재 → NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.suspendUser(ADMIN_ID, 'no-such', dto, CTX),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── unsuspendUser ─────────────────────────────────────────────────────
  describe('unsuspendUser', () => {
    it('정상 해제 — 3 컬럼 NULL + audit unsuspend', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeUser({
          suspendedAt: new Date('2026-05-01'),
          suspendReason: '이전 사유',
        }),
      );

      const r = await service.unsuspendUser(ADMIN_ID, TARGET_ID, CTX);

      expect(r).toEqual({ ok: true });
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: TARGET_ID },
        { suspendedAt: null, suspendReason: null, suspendExpiresAt: null },
      );
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN_ID,
        'unsuspend',
        'user',
        TARGET_ID,
        expect.objectContaining({ previousReason: '이전 사유' }),
        manager,
        CTX,
      );
    });

    it('정지 안 됨 — idempotent (audit 미발생)', async () => {
      manager.findOne.mockResolvedValueOnce(makeUser({ suspendedAt: null }));

      const r = await service.unsuspendUser(ADMIN_ID, TARGET_ID, CTX);

      expect(r).toEqual({ ok: true });
      expect(manager.update).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('사용자 미존재 → NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.unsuspendUser(ADMIN_ID, 'no-such', CTX),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
