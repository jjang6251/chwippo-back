import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BriefingService } from './briefing.service';
import { DeadlineUrgentService } from './deadline-urgent.service';
import { ImminentReminderService } from './imminent-reminder.service';
import { BRIEFING_HOURS, type BriefingHour } from './notification.types';

/**
 * 알림 발송 cron.
 *   - 07·08·09·10시 KST 아침 브리핑 — 사용자 briefingHour 로 자기 시각 slot 에서만 발송
 *     (routine · 이벤트 있을 때만). 각 slot 이 자기 시각(targetHour)을 브리핑 서비스에 전달.
 *   - 15:00 KST 마감 임박 긴급 (save · 오늘 서류 마감)
 *   - 15분 간격 2시간 전 임박 (이벤트시각−2h ∈ [now, now+15m) · 과거 윈도우 미발송)
 *
 * 시각·timezone 전부 KST 고정. 각 서비스가 dedup·필터 담당.
 * 정기 알림 상한(Q2): 아침 브리핑 1통 + 임박형 + 하드캡 일 4통(dispatch 에서 강제).
 */
@Injectable()
export class NotificationCron {
  private readonly logger = new Logger(NotificationCron.name);

  constructor(
    private readonly briefingService: BriefingService,
    private readonly deadlineUrgentService: DeadlineUrgentService,
    private readonly imminentReminderService: ImminentReminderService,
  ) {}

  @Cron('0 7 * * *', { timeZone: 'Asia/Seoul' })
  async runBriefing07(): Promise<void> {
    await this.runBriefingAt(7);
  }

  @Cron('0 8 * * *', { timeZone: 'Asia/Seoul' })
  async runBriefing08(): Promise<void> {
    await this.runBriefingAt(8);
  }

  @Cron('0 9 * * *', { timeZone: 'Asia/Seoul' })
  async runBriefing09(): Promise<void> {
    await this.runBriefingAt(9);
  }

  @Cron('0 10 * * *', { timeZone: 'Asia/Seoul' })
  async runBriefing10(): Promise<void> {
    await this.runBriefingAt(10);
  }

  /** 공용 브리핑 실행 — targetHour 를 선택한 사용자에게만 발송 */
  private async runBriefingAt(hour: BriefingHour): Promise<void> {
    if (!BRIEFING_HOURS.includes(hour)) return; // 방어 (호출부 고정값)
    this.logger.log(`[NotificationCron] 아침 브리핑 시작 (KST ${hour}:00)`);
    try {
      const result = await this.briefingService.sendDailyBriefings(
        new Date(),
        hour,
      );
      this.logger.log(
        `[NotificationCron] 브리핑 완료 (KST ${hour}:00) · 발송 ${result.sentBriefings}건`,
      );
    } catch (err) {
      this.logger.error(
        `[NotificationCron] 브리핑 실패 (KST ${hour}:00): ${(err as Error).message}`,
      );
    }
  }

  /** ② 2시간 전 임박 — 15분 간격 (윈도우 판정은 서비스가 담당) */
  @Cron('*/15 * * * *', { timeZone: 'Asia/Seoul' })
  async runImminentReminder(): Promise<void> {
    try {
      const result = await this.imminentReminderService.sendImminentReminders();
      if (result.sentImminent > 0) {
        this.logger.log(
          `[NotificationCron] 임박 리마인드 발송 ${result.sentImminent}건`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[NotificationCron] 임박 리마인드 실패: ${(err as Error).message}`,
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
