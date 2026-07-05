import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DailySummaryService } from './daily-summary.service';

/**
 * 일일 요약 cron — 매일 09:30 KST, ops 채널.
 * 발송 자체가 heartbeat (안 오면 = 백엔드/cron 이상).
 */
@Injectable()
export class DailySummaryCron {
  private readonly logger = new Logger(DailySummaryCron.name);

  constructor(private readonly summaryService: DailySummaryService) {}

  @Cron('30 9 * * *', { timeZone: 'Asia/Seoul' })
  async runDailySummary(): Promise<void> {
    this.logger.log('[DailySummaryCron] 시작 (KST 09:30)');
    try {
      await this.summaryService.sendDailySummary();
    } catch (err) {
      this.logger.error(`[DailySummaryCron] 실패: ${(err as Error).message}`);
    }
  }
}
