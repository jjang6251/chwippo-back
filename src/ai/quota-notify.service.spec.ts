import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, Repository } from 'typeorm';
import { AdminNotifyService } from '../notifications/admin-notify.service';
import { User } from '../users/user.entity';
import { QuotaNotifyService } from './quota-notify.service';

/**
 * cost hardening ④ — QuotaNotifyService spec.
 *
 * 시나리오 매트릭스:
 * - notifyOverrideSet: fair_use → 상향 문구 + 인앱/push + 접속 시 모달(pending)
 *                      manual_admin → 조정 문구 / validUntil 있으면 기한 포함
 * - notifyOverrideCleared: 복구 문구 + 모달
 * - notifyAutoBan: 제한 문구 + 모달
 * - notifyUserReset: 인앱/push 만 — 모달 없음 (과통지 방지)
 * - notifyMatrixChanged: 한도 변경분만 문구 · 한도 외 변경(undefined 만) → 통지 자체 skip
 *                        해당 tier + 미정지 유저만 bulk INSERT
 * - notifyQuotaExceeded: 오늘 동일 feature·scope 통지 있으면 dedup skip
 * - best-effort: adminNotify throw 해도 전파 안 됨
 */
describe('QuotaNotifyService', () => {
  let service: QuotaNotifyService;
  let adminNotify: jest.Mocked<AdminNotifyService>;
  let userRepo: jest.Mocked<Repository<User>>;
  let dataSource: jest.Mocked<DataSource>;

  const USER_ID = 'u-1';

  beforeEach(async () => {
    adminNotify = mock<AdminNotifyService>();
    adminNotify.notifyUser.mockResolvedValue(undefined);
    userRepo = mock<Repository<User>>();
    dataSource = mock<DataSource>();
    dataSource.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotaNotifyService,
        { provide: AdminNotifyService, useValue: adminNotify },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(QuotaNotifyService);
  });

  describe('notifyOverrideSet', () => {
    it('fair_use → 상향 문구 + 인앱/push + 접속 시 모달(pending_notification)', async () => {
      await service.notifyOverrideSet(USER_ID, {
        dailyCapOverride: 100,
        validUntil: null,
        reason: 'fair_use',
      });

      expect(adminNotify.notifyUser).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          title: expect.stringContaining('상향'),
          body: expect.stringContaining('100회'),
        }),
      );
      expect(userRepo.update).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          pendingNotification: expect.objectContaining({
            type: 'quota_override',
          }),
        }),
      );
    });

    it('manual_admin + validUntil → 조정 문구 + 기한 포함', async () => {
      await service.notifyOverrideSet(USER_ID, {
        dailyCapOverride: 1,
        validUntil: new Date('2026-08-01T00:00:00+09:00'),
        reason: 'manual_admin',
      });

      const [, content] = adminNotify.notifyUser.mock.calls[0];
      expect(content.title).toContain('조정');
      expect(content.body).toContain('2026-08-01');
      expect(content.body).toContain('1회');
    });
  });

  it('notifyOverrideCleared → 복구 문구 + 모달', async () => {
    await service.notifyOverrideCleared(USER_ID);
    expect(adminNotify.notifyUser).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ title: expect.stringContaining('복구') }),
    );
    expect(userRepo.update).toHaveBeenCalled();
  });

  it('notifyAutoBan → 제한 문구 + 기한 + 모달', async () => {
    await service.notifyAutoBan(
      USER_ID,
      5,
      new Date('2026-07-13T00:00:00+09:00'),
    );
    const [, content] = adminNotify.notifyUser.mock.calls[0];
    expect(content.title).toContain('제한');
    expect(content.body).toContain('2026-07-13');
    expect(content.body).toContain('5회');
    expect(userRepo.update).toHaveBeenCalled();
  });

  it('notifyUserReset → 인앱/push 만, 모달 없음 (과통지 방지)', async () => {
    await service.notifyUserReset(USER_ID);
    expect(adminNotify.notifyUser).toHaveBeenCalled();
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  describe('notifyMatrixChanged', () => {
    it('dayLimit 변경 → 해당 tier·미정지 유저 bulk INSERT (일 N회 문구)', async () => {
      await service.notifyMatrixChanged('coverletter_draft_v2', 'free', {
        dayLimit: 5,
      });

      const [sql, params] = dataSource.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain('INSERT INTO notifications');
      expect(sql).toContain('tier = $3');
      expect(sql).toContain('suspended_at IS NULL');
      expect(params[1]).toContain('일 5회');
      expect(params[2]).toBe('free');
    });

    it('한도 외 변경(둘 다 undefined) → 통지 skip (cooldown 등은 대상 아님)', async () => {
      await service.notifyMatrixChanged('coverletter_draft_v2', 'free', {});
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('notifyQuotaExceeded (일 1회 dedup)', () => {
    it('오늘 첫 초과 → INSERT (payload kind·feature·scope)', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '0' }]) // dedup 조회
        .mockResolvedValueOnce([]); // insert

      await service.notifyQuotaExceeded(USER_ID, 'coverletter_chat', 'day');

      expect(dataSource.query).toHaveBeenCalledTimes(2);
      const [insertSql, insertParams] = dataSource.query.mock.calls[1] as [
        string,
        unknown[],
      ];
      expect(insertSql).toContain('INSERT INTO notifications');
      expect(String(insertParams[3])).toContain('quota_exceeded');
    });

    it('오늘 이미 통지함 → skip (재시도 스팸 방지)', async () => {
      dataSource.query.mockResolvedValueOnce([{ count: '1' }]);

      await service.notifyQuotaExceeded(USER_ID, 'coverletter_chat', 'day');

      expect(dataSource.query).toHaveBeenCalledTimes(1); // dedup 조회만
    });
  });

  it('best-effort — adminNotify throw 해도 전파 안 됨', async () => {
    adminNotify.notifyUser.mockRejectedValue(new Error('down'));
    await expect(
      service.notifyOverrideCleared(USER_ID),
    ).resolves.toBeUndefined();
  });
});
