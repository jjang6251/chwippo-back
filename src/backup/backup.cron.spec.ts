import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { DiscordNotifier } from '../common/discord-notifier';
import { BackupCron } from './backup.cron';
import { BackupService, HeartbeatSummary } from './backup.service';

/**
 * N1 BackupCron spec.
 *
 * 시나리오 매트릭스:
 * - runDaily: BackupService.runBackup 위임 (실패 처리·알림은 service 책임)
 * - runHeartbeat: disabled → 알림 X
 *                 7/7 성공 → ops 채널 녹색 요약
 *                 결손 → 결손일 포함 노란 요약
 *                 summarize throw → critical 로 heartbeat 실패 알림 (침묵 방지)
 */
describe('BackupCron', () => {
  let cron: BackupCron;
  let backupService: jest.Mocked<BackupService>;
  let notifier: jest.Mocked<DiscordNotifier>;

  const HEALTHY: HeartbeatSummary = {
    expectedDays: 7,
    presentDays: 7,
    missingDates: [],
    latestKey: 'daily/chwippo-2026-07-06.dump.enc',
    latestSizeBytes: 4096,
  };

  beforeEach(async () => {
    backupService = mock<BackupService>();
    backupService.isEnabled.mockReturnValue(true);
    backupService.runBackup.mockResolvedValue({
      ok: true,
      uploadedKeys: [],
      deletedCount: 0,
      sizeBytes: 0,
    });
    backupService.summarizeLastWeek.mockResolvedValue(HEALTHY);
    notifier = mock<DiscordNotifier>();
    notifier.notify.mockResolvedValue('sent');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupCron,
        { provide: BackupService, useValue: backupService },
        { provide: DiscordNotifier, useValue: notifier },
      ],
    }).compile();
    cron = module.get(BackupCron);
  });

  it('runDaily → BackupService.runBackup 위임', async () => {
    await cron.runDaily();
    expect(backupService.runBackup).toHaveBeenCalledTimes(1);
  });

  describe('runHeartbeat', () => {
    it('disabled → 알림 X', async () => {
      backupService.isEnabled.mockReturnValue(false);
      await cron.runHeartbeat();
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it('7/7 성공 → ops 채널 요약', async () => {
      await cron.runHeartbeat();
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('7/7') }),
        'ops',
      );
    });

    it('결손 → 결손일 포함 경고 요약', async () => {
      backupService.summarizeLastWeek.mockResolvedValue({
        ...HEALTHY,
        presentDays: 5,
        missingDates: ['2026-07-03', '2026-07-01'],
      });
      await cron.runHeartbeat();
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('결손'),
          description: expect.stringContaining('2026-07-03'),
        }),
        'ops',
      );
    });

    it('summarize throw → critical 로 heartbeat 실패 알림 (침묵 방지)', async () => {
      backupService.summarizeLastWeek.mockRejectedValue(
        new Error('R2 접근 불가'),
      );
      await cron.runHeartbeat();
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('heartbeat 실패'),
        }),
        'critical',
      );
    });
  });
});
