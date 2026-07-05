import { Module } from '@nestjs/common';
import { DailySummaryService } from './daily-summary.service';
import { DailySummaryCron } from './daily-summary.cron';
import { Http5xxMonitorService } from './http-5xx-monitor.service';

/**
 * 운영 모니터링 — 일일 요약 cron(09:30) + 5xx 스파이크 감시.
 * DiscordNotifier 는 @Global NotifierModule 로 주입.
 */
@Module({
  providers: [DailySummaryService, DailySummaryCron, Http5xxMonitorService],
  exports: [Http5xxMonitorService],
})
export class MonitoringModule {}
