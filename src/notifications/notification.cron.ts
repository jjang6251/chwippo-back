import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BriefingService } from './briefing.service';
import { DeadlineUrgentService } from './deadline-urgent.service';

/**
 * 알림 발송 cron — 하루 최대 2통 (Duolingo routine + save 패턴).
 *   - 08:00 KST 아침 브리핑 (routine · 이벤트 있을 때만)
 *   - 15:00 KST 마감 임박 긴급 (save · 오늘 서류 마감)
 *
 * 시각·timezone 전부 KST 고정. 각 서비스가 dedup·필터 담당.
 */
@Injectable()
export class NotificationCron {
  private readonly logger = new Logger(NotificationCron.name);

  constructor(
    private readonly briefingService: BriefingService,
    private readonly deadlineUrgentService: DeadlineUrgentService,
  ) {}

  @Cron('0 8 * * *', { timeZone: 'Asia/Seoul' })
  async runMorningBriefing(): Promise<void> {
    this.logger.log('[NotificationCron] 아침 브리핑 시작 (KST 08:00)');
    try {
      const result = await this.briefingService.sendDailyBriefings();
      this.logger.log(
        `[NotificationCron] 브리핑 완료 · 발송 ${result.sentBriefings}건`,
      );
    } catch (err) {
      this.logger.error(
        `[NotificationCron] 브리핑 실패: ${(err as Error).message}`,
      );
    }
  }

  @Cron('0 15 * * *', { timeZone: 'Asia/Seoul' })
  async runDeadlineUrgent(): Promise<void> {
    this.logger.log('[NotificationCron] 마감 긴급 시작 (KST 15:00)');
    try {
      const result = await this.deadlineUrgentService.sendUrgentReminders();
      this.logger.log(
        `[NotificationCron] 마감 긴급 완료 · 발송 ${result.sentUrgent}건`,
      );
    } catch (err) {
      this.logger.error(
        `[NotificationCron] 마감 긴급 실패: ${(err as Error).message}`,
      );
    }
  }
}
