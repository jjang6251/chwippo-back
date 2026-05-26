import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository } from 'typeorm';
import { AdminAuditService } from '../admin/admin-audit.service';
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
  let config: jest.Mocked<ConfigService>;
  let fetchSpy: jest.SpyInstance;

  const USER_ID = 'user-1';

  beforeEach(async () => {
    quotaRepo = mock<Repository<UserAiQuota>>();
    logRepo = mock<Repository<LlmCallLog>>();
    auditService = mock<AdminAuditService>();
    config = mock<ConfigService>();
    config.get.mockReturnValue(undefined); // default: webhook 미설정

    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AbuserBanService,
        { provide: getRepositoryToken(UserAiQuota), useValue: quotaRepo },
        { provide: getRepositoryToken(LlmCallLog), useValue: logRepo },
        { provide: AdminAuditService, useValue: auditService },
        { provide: ConfigService, useValue: config },
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

  describe('notifyDiscord', () => {
    it('ADMIN_ALERT_WEBHOOK_URL 미설정 → fetch 미호출 (dev 환경 안전)', async () => {
      config.get.mockReturnValue(undefined);
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('webhook URL 설정 → fetch 호출 (content body 포함)', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'ADMIN_ALERT_WEBHOOK_URL'
          ? 'https://discord.com/api/webhooks/test'
          : undefined,
      );
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('webhook 실패 → 에러 로깅만, ban 자체는 정상 발동 (best-effort)', async () => {
      config.get.mockReturnValue('https://discord.com/api/webhooks/test');
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      fetchSpy.mockRejectedValueOnce(new Error('network error'));
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      // ban 발동은 성공
      expect(r.banned).toBe(true);
      expect(quotaRepo.upsert).toHaveBeenCalled();
    });

    it('webhook 4xx/5xx 응답 → 에러 로깅만, ban 정상', async () => {
      config.get.mockReturnValue('https://discord.com/api/webhooks/test');
      quotaRepo.findOne.mockResolvedValue(null);
      logRepo.count.mockResolvedValue(30);
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
      const r = await service.checkAndBan(USER_ID, 'note_summary', 30);
      expect(r.banned).toBe(true);
    });
  });
});
