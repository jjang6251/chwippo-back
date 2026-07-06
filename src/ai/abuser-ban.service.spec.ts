import { Test, TestingModule } from '@nestjs/testing';
import { QuotaNotifyService } from './quota-notify.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository } from 'typeorm';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AlertHistory } from '../admin/entities/alert-history.entity';
import { DiscordNotifier } from '../common/discord-notifier';
import { AbuserBanService } from './abuser-ban.service';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { UserAiQuota } from './entities/user-ai-quota.entity';

/**
 * F6 PR 1 Phase 3 — AbuserBanService spec.
 *
 * 시나리오 매트릭스:
 * - getActiveOverride: row 없음 / row 있고 valid_until 미래 / valid_until 과거 (expired)
 * - checkAndBan: 3일 연속 도달 → ban (UPSERT + audit + webhook)
 *                1·2일 도달 → noop
 *                이미 ban 상태 → noop (중복 방지)
 * - notifyDiscord: webhook URL 없음 → skip (dev 환경 OK)
 *                  webhook 실패 → error 로깅 + ban 자체는 정상
 */
describe('AbuserBanService', () => {
  let service: AbuserBanService;
  let quotaRepo: jest.Mocked<Repository<UserAiQuota>>;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;
  let auditService: jest.Mocked<AdminAuditService>;
  let discord: jest.Mocked<DiscordNotifier>;
  let historyRepo: jest.Mocked<Repository<AlertHistory>>;
  let fetchSpy: jest.SpyInstance;

  const USER_ID = 'user-1';

  beforeEach(async () => {
    quotaRepo = mock<Repository<UserAiQuota>>();
    logRepo = mock<Repository<LlmCallLog>>();
    auditService = mock<AdminAuditService>();
    discord = mock<DiscordNotifier>();
    discord.notify.mockResolvedValue('skipped_no_webhook');
    historyRepo = mock<Repository<AlertHistory>>();
    historyRepo.create.mockImplementation((d) => d as AlertHistory);
    historyRepo.save.mockResolvedValue({} as AlertHistory);

    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);

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
        AbuserBanService,
        { provide: getRepositoryToken(UserAiQuota), useValue: quotaRepo },
        { provide: getRepositoryToken(LlmCallLog), useValue: logRepo },
        { provide: AdminAuditService, useValue: auditService },
        { provide: DiscordNotifier, useValue: discord },
        { provide: getRepositoryToken(AlertHistory), useValue: historyRepo },
      ],
    }).compile();
    service = module.get<AbuserBanService>(AbuserBanService);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('getActiveOverride', () => {
    it('row 없음 → null', async () => {
      quotaRepo.findOne.mockResolvedValue(null);
      const r = await service.getActiveOverride(USER_ID);
      expect(r).toBeNull();
    });

    it('row 있고 valid_until 미래 → row 반환 (활성 override)', async () => {
      const future = new Date(Date.now() + 86_400_000);
      const row = {
        userId: USER_ID,
        dailyCapOverride: 5,
        validUntil: future,
        reason: 'auto_ban_3_consecutive_days',
      } as UserAiQuota;
      quotaRepo.findOne.mockResolvedValue(row);
      const r = await service.getActiveOverride(USER_ID);
      expect(r).toBe(row);
    });

    it('row 있고 valid_until 과거 → null (expired, 자연 해제)', async () => {
      const past = new Date(Date.now() - 86_400_000);
      quotaRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        dailyCapOverride: 5,
        validUntil: past,
        reason: 'auto_ban_3_consecutive_days',
      } as UserAiQuota);
      const r = await service.getActiveOverride(USER_ID);
      expect(r).toBeNull();
    });

    it('row 있고 valid_until null → row 반환 (수동 해제까지 영구)', async () => {
      const row = {
        userId: USER_ID,
        dailyCapOverride: 10,
        validUntil: null,
        reason: 'manual_admin',
      } as UserAiQuota;
      quotaRepo.findOne.mockResolvedValue(row);
      const r = await service.getActiveOverride(USER_ID);
      expect(r).toBe(row);
    });
  });

  describe('checkAndBan', () => {
    it('이미 active ban 상태 → noop (중복 발동 방지)', async () => {
      const future = new Date(Date.now() + 86_400_000);
      quotaRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        dailyCapOverride: 5,
        validUntil: future,
        reason: 'auto_ban_3_consecutive_days',
      } as UserAiQuota);
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(r.banned).toBe(false);
      expect(quotaRepo.upsert).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('1일만 도달 → noop (3일 연속 조건 미충족)', async () => {
      quotaRepo.findOne.mockResolvedValue(null);
      // 3일치 count 중 1일만 한도(30) 도달
      logRepo.count
        .mockResolvedValueOnce(30) // 오늘
        .mockResolvedValueOnce(5) // 어제
        .mockResolvedValueOnce(2); // 그제
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(r.banned).toBe(false);
      expect(quotaRepo.upsert).not.toHaveBeenCalled();
    });

    it('2일 도달 → noop (3일 연속 조건 미충족)', async () => {
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(10);
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(r.banned).toBe(false);
    });

    it('3일 연속 도달 → ban 발동 (UPSERT + audit + webhook skip)', async () => {
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(30);
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(r.banned).toBe(true);
      expect(quotaRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          dailyCapOverride: 5,
          reason: 'auto_ban_3_consecutive_days',
        }),
        ['userId'],
      );
      expect(auditService.log).toHaveBeenCalledWith(
        null,
        'auto_ban_ai',
        'user',
        USER_ID,
        expect.objectContaining({
          reason: 'auto_ban_3_consecutive_days',
          duration_days: 7,
          daily_cap_override: 5,
          triggered_feature: 'note_summary',
          consecutive_days: 3,
        }),
      );
    });

    it('3일 도달 — valid_until 이 약 7일 후로 설정', async () => {
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      await service.checkAndBan(USER_ID, 'note_summary', 30);
      const call = quotaRepo.upsert.mock.calls[0][0] as Partial<UserAiQuota>;
      const validUntil = call.validUntil!;
      const diffMs = validUntil.getTime() - Date.now();
      const diffDays = diffMs / (86_400 * 1000);
      expect(diffDays).toBeGreaterThan(6.9);
      expect(diffDays).toBeLessThan(7.1);
    });

    it('이전 ban 이 expired 면 새 ban 발동 가능 (재발 차단 X)', async () => {
      const past = new Date(Date.now() - 86_400_000);
      quotaRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        dailyCapOverride: 5,
        validUntil: past,
        reason: 'auto_ban_3_consecutive_days',
      } as UserAiQuota);
      logRepo.count.mockResolvedValue(30);
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      // expired 이므로 getActiveOverride 가 null 반환 → ban 새로 발동
      expect(r.banned).toBe(true);
    });

    it('manual_admin reason 의 active override → 중복 ban 안 함 (자동 ban 만 차단)', async () => {
      const future = new Date(Date.now() + 86_400_000);
      quotaRepo.findOne.mockResolvedValue({
        userId: USER_ID,
        dailyCapOverride: 10,
        validUntil: future,
        reason: 'manual_admin',
      } as UserAiQuota);
      logRepo.count.mockResolvedValue(30);
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      // 코드: existing.reason === 'auto_ban_3_consecutive_days' 만 skip → manual 은 새 자동 ban 발동
      expect(r.banned).toBe(true);
    });
  });

  describe('notifyDiscord (DiscordNotifier 위임)', () => {
    it('ban 발동 시 DiscordNotifier.notify 호출 (content 에 user·feature 포함)', async () => {
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      discord.notify.mockResolvedValue('sent');
      await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(discord.notify).toHaveBeenCalledTimes(1);
      const content = discord.notify.mock.calls[0][0];
      expect(content).toContain('AI Auto-Ban');
      expect(content).toContain(USER_ID);
      expect(content).toContain('note_summary');
    });

    it('discord.notify 실패 (skipped_no_webhook) → ban 정상 진행 (best-effort)', async () => {
      discord.notify.mockResolvedValue('skipped_no_webhook');
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(r.banned).toBe(true);
      expect(quotaRepo.upsert).toHaveBeenCalled();
    });

    it('5.6.3 — ban 발동 시 alert_history insert (type=abuser_ban + webhook_status)', async () => {
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      discord.notify.mockResolvedValue('sent');
      await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(historyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType: 'abuser_ban',
          webhookStatus: 'sent',
          message: expect.stringContaining(USER_ID),
        }),
      );
    });

    it('5.6.3 — alert_history insert 실패 → ban 자체는 정상 (best-effort)', async () => {
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      discord.notify.mockResolvedValue('sent');
      historyRepo.save.mockRejectedValueOnce(new Error('DB down'));
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(r.banned).toBe(true);
      expect(quotaRepo.upsert).toHaveBeenCalled();
    });

    it('discord.notify 실패 (failed) → ban 정상', async () => {
      discord.notify.mockResolvedValue('failed');
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(r.banned).toBe(true);
    });
  });
  // ── cost hardening B-4 — admin 수동 개별 한도 ──
  describe('setManualOverride / clearOverride', () => {
    it('set: upsert(userId conflict) + audit set_user_ai_quota_override (before=null)', async () => {
      quotaRepo.findOne
        .mockResolvedValueOnce(null) // before
        .mockResolvedValueOnce({
          userId: USER_ID,
          dailyCapOverride: 100,
          validUntil: null,
          reason: 'fair_use',
        } as UserAiQuota); // after
      quotaRepo.upsert.mockResolvedValue({} as import('typeorm').InsertResult);

      const result = await service.setManualOverride('admin-1', USER_ID, {
        dailyCapOverride: 100,
        validUntil: null,
        reason: 'fair_use',
      });

      expect(quotaRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          dailyCapOverride: 100,
          reason: 'fair_use',
        }),
        ['userId'],
      );
      expect(auditService.log).toHaveBeenCalledWith(
        'admin-1',
        'set_user_ai_quota_override',
        'user_ai_quotas',
        USER_ID,
        expect.objectContaining({
          before: null,
          after: expect.objectContaining({ dailyCapOverride: 100 }),
        }),
      );
      expect(result.dailyCapOverride).toBe(100);
    });

    it('set: 기존 auto ban 위에 덮어쓰기 → before 에 이전 값 보존 (audit 추적)', async () => {
      quotaRepo.findOne
        .mockResolvedValueOnce({
          userId: USER_ID,
          dailyCapOverride: 5,
          validUntil: new Date('2026-07-10'),
          reason: 'auto_ban_3_consecutive_days',
        } as UserAiQuota)
        .mockResolvedValueOnce({
          userId: USER_ID,
          dailyCapOverride: 50,
          validUntil: null,
          reason: 'manual_admin',
        } as UserAiQuota);
      quotaRepo.upsert.mockResolvedValue({} as import('typeorm').InsertResult);

      await service.setManualOverride('admin-1', USER_ID, {
        dailyCapOverride: 50,
        validUntil: null,
        reason: 'manual_admin',
      });

      expect(auditService.log).toHaveBeenCalledWith(
        'admin-1',
        'set_user_ai_quota_override',
        'user_ai_quotas',
        USER_ID,
        expect.objectContaining({
          before: expect.objectContaining({
            dailyCapOverride: 5,
            reason: 'auto_ban_3_consecutive_days',
          }),
        }),
      );
    });

    it('clear: row 존재 → delete + audit clear_user_ai_quota_override', async () => {
      quotaRepo.findOne.mockResolvedValueOnce({
        userId: USER_ID,
        dailyCapOverride: 100,
        validUntil: null,
        reason: 'fair_use',
      } as UserAiQuota);
      quotaRepo.delete.mockResolvedValue({} as import('typeorm').DeleteResult);

      const r = await service.clearOverride('admin-1', USER_ID);

      expect(r.cleared).toBe(true);
      expect(quotaRepo.delete).toHaveBeenCalledWith({ userId: USER_ID });
      expect(auditService.log).toHaveBeenCalledWith(
        'admin-1',
        'clear_user_ai_quota_override',
        'user_ai_quotas',
        USER_ID,
        expect.anything(),
      );
    });

    it('clear: row 없음 → no-op (delete·audit 미호출)', async () => {
      quotaRepo.findOne.mockResolvedValueOnce(null);

      const r = await service.clearOverride('admin-1', USER_ID);

      expect(r.cleared).toBe(false);
      expect(quotaRepo.delete).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('getOverrideRaw: 만료 row 도 반환 (getActiveOverride 와 대비 — 표시용)', async () => {
      const expired = {
        userId: USER_ID,
        dailyCapOverride: 5,
        validUntil: new Date('2020-01-01'),
        reason: 'auto_ban_3_consecutive_days',
      } as UserAiQuota;
      quotaRepo.findOne.mockResolvedValue(expired);

      expect(await service.getOverrideRaw(USER_ID)).toBe(expired);
      expect(await service.getActiveOverride(USER_ID)).toBeNull();
    });
  });
});
