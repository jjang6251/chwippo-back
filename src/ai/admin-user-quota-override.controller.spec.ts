import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { AbuserBanService } from './abuser-ban.service';
import { QuotaNotifyService } from './quota-notify.service';
import { AdminUserQuotaOverrideController } from './admin-user-quota-override.controller';
import { UserAiQuota } from './entities/user-ai-quota.entity';

/**
 * cost hardening B-4 — 유저 개별 한도 admin controller spec.
 *
 * 시나리오:
 * - GET: row 없음 → {override:null, active:false}
 *        validUntil 미래 → active:true / 과거 → active:false / NULL → active:true (영구)
 * - PUT: service 위임 (validUntil 생략 → null 변환)
 * - DELETE: service 위임 + cleared 반환
 * (권한 401/403 은 RolesGuard 선언 — guard 자체는 공용 spec 커버)
 */
describe('AdminUserQuotaOverrideController', () => {
  let controller: AdminUserQuotaOverrideController;
  let abuserBan: jest.Mocked<AbuserBanService>;
  let quotaNotify: {
    notifyOverrideSet: jest.Mock;
    notifyOverrideCleared: jest.Mock;
  };

  const ADMIN = { id: 'admin-1' };
  const USER_ID = 'b6f0d6a2-0000-4000-8000-000000000001';

  const makeRow = (over: Partial<UserAiQuota> = {}): UserAiQuota =>
    ({
      userId: USER_ID,
      dailyCapOverride: 100,
      validUntil: null,
      reason: 'fair_use',
      quotaResetAt: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as UserAiQuota;

  beforeEach(async () => {
    abuserBan = mock<AbuserBanService>();
    quotaNotify = {
      notifyOverrideSet: jest.fn().mockResolvedValue(undefined),
      notifyOverrideCleared: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminUserQuotaOverrideController],
      providers: [
        { provide: AbuserBanService, useValue: abuserBan },
        { provide: QuotaNotifyService, useValue: quotaNotify },
      ],
    }).compile();
    controller = module.get(AdminUserQuotaOverrideController);
  });

  describe('GET', () => {
    it('row 없음 → override null + active false', async () => {
      abuserBan.getOverrideRaw.mockResolvedValue(null);
      expect(await controller.get(USER_ID)).toEqual({
        override: null,
        active: false,
      });
    });

    it('validUntil NULL (영구) → active true', async () => {
      abuserBan.getOverrideRaw.mockResolvedValue(makeRow());
      const r = await controller.get(USER_ID);
      expect(r.active).toBe(true);
    });

    it('validUntil 미래 → active true / 과거 → false (만료 표시)', async () => {
      abuserBan.getOverrideRaw.mockResolvedValue(
        makeRow({ validUntil: new Date(Date.now() + 86400000) }),
      );
      expect((await controller.get(USER_ID)).active).toBe(true);

      abuserBan.getOverrideRaw.mockResolvedValue(
        makeRow({ validUntil: new Date(Date.now() - 86400000) }),
      );
      expect((await controller.get(USER_ID)).active).toBe(false);
    });
  });

  describe('PUT', () => {
    it('service 위임 — validUntil 생략 시 null 로 변환', async () => {
      abuserBan.setManualOverride.mockResolvedValue(makeRow());

      await controller.set(ADMIN, USER_ID, {
        dailyCapOverride: 100,
        reason: 'fair_use',
      } as never);

      expect(abuserBan.setManualOverride).toHaveBeenCalledWith(
        'admin-1',
        USER_ID,
        { dailyCapOverride: 100, validUntil: null, reason: 'fair_use' },
      );
    });

    it('validUntil 지정 시 그대로 전달 (하향 manual_admin)', async () => {
      abuserBan.setManualOverride.mockResolvedValue(makeRow());
      const until = new Date('2026-08-01');

      await controller.set(ADMIN, USER_ID, {
        dailyCapOverride: 1,
        validUntil: until,
        reason: 'manual_admin',
      } as never);

      expect(abuserBan.setManualOverride).toHaveBeenCalledWith(
        'admin-1',
        USER_ID,
        { dailyCapOverride: 1, validUntil: until, reason: 'manual_admin' },
      );
    });
  });

  describe('DELETE', () => {
    it('service 위임 + cleared 반환', async () => {
      abuserBan.clearOverride.mockResolvedValue({ cleared: true });
      expect(await controller.clear(ADMIN, USER_ID)).toEqual({
        cleared: true,
      });
      expect(abuserBan.clearOverride).toHaveBeenCalledWith('admin-1', USER_ID);
    });
  });

  // cost hardening ④ — 개별 변경 시 해당 유저에게만 통지
  describe('④ 사용자 통지', () => {
    it('PUT 성공 → notifyOverrideSet (해당 유저·설정값 전달)', async () => {
      abuserBan.setManualOverride.mockResolvedValue(makeRow());
      await controller.set(ADMIN, USER_ID, {
        dailyCapOverride: 100,
        reason: 'fair_use',
      } as never);

      expect(quotaNotify.notifyOverrideSet).toHaveBeenCalledWith(USER_ID, {
        dailyCapOverride: 100,
        validUntil: null,
        reason: 'fair_use',
      });
    });

    it('DELETE cleared=true → notifyOverrideCleared / false → 통지 안 함', async () => {
      abuserBan.clearOverride.mockResolvedValue({ cleared: true });
      await controller.clear(ADMIN, USER_ID);
      expect(quotaNotify.notifyOverrideCleared).toHaveBeenCalledWith(USER_ID);

      quotaNotify.notifyOverrideCleared.mockClear();
      abuserBan.clearOverride.mockResolvedValue({ cleared: false });
      await controller.clear(ADMIN, USER_ID);
      expect(quotaNotify.notifyOverrideCleared).not.toHaveBeenCalled();
    });
  });
});
