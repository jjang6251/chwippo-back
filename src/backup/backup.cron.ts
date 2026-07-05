import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { BackupService } from './backup.service';

/**
 * N1 DB 백업 cron 2개.
 *
 * - 매일 04:00 KST: 백업 실행 (일요일이면 weekly/ 에도 저장 — service 가 판정)
 * - 매주 월 09:00 KST: heartbeat — 침묵 실패 방지. "알림 없음 = 정상" 가정 금지가 원칙이라
 *   성공 중일 때도 주 1회 요약을 ops 채널로 발송.
 *
 * 실패 알림은 BackupService.fail 이 critical 채널로 직접 발송.
 */
@Injectable()
export class BackupCron {
  private readonly logger = new Logger(BackupCron.name);

  constructor(
    private readonly backupService: BackupService,
    private readonly notifier: DiscordNotifier,
  ) {}

  @Cron('0 4 * * *', { timeZone: 'Asia/Seoul' })
  async runDaily(): Promise<void> {
    this.logger.log('[BackupCron] 04:00 KST 백업 시작');
    await this.backupService.runBackup();
  }

  @Cron('0 9 * * 1', { timeZone: 'Asia/Seoul' })
  async runHeartbeat(): Promise<void> {
    if (!this.backupService.isEnabled()) return;
    try {
      const s = await this.backupService.summarizeLastWeek();
      const healthy = s.presentDays === s.expectedDays;
      const sizeKb = Math.round((s.latestSizeBytes ?? 0) / 1024);
      await this.notifier.notify(
        {
          title: healthy
            ? `💾 주간 백업 요약 — ${s.presentDays}/${s.expectedDays} 성공`
            : `⚠️ 주간 백업 요약 — ${s.presentDays}/${s.expectedDays} (결손 있음)`,
          description: [
            s.latestKey
              ? `최신: \`${s.latestKey}\` (${sizeKb}KB)`
              : '최신 백업 없음',
            s.missingDates.length > 0
              ? `결손일: ${s.missingDates.join(', ')}`
              : null,
          ]
            .filter(Boolean)
            .join('\n'),
          color: healthy ? DISCORD_COLORS.green : DISCORD_COLORS.yellow,
        },
        'ops',
      );
    } catch (err) {
      // heartbeat 실패 자체도 알림 (침묵 방지) — best-effort
      this.logger.error(`heartbeat 실패: ${(err as Error).message}`);
      await this.notifier.notify(
        {
          title: '⚠️ 백업 heartbeat 실패',
          description: (err as Error).message.slice(0, 500),
          color: DISCORD_COLORS.yellow,
        },
        'critical',
      );
    }
  }
}
