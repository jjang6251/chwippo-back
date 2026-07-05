import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordNotifier } from '../common/discord-notifier';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import {
  AlertHistory,
  AlertType,
  WebhookStatus,
} from './entities/alert-history.entity';
import { AlertThresholdsService } from './alert-thresholds.service';

export const DEDUP_WINDOW_MINUTES = 60;

/**
 * F6 PR 2 Phase 5.4 — 비용·에러 임계치 자동 감지 + Discord 알람.
 *
 * - 10분 cron 으로 3종 체크
 * - dedup 1시간 — 같은 alert_type 의 최근 1시간 'sent' 있으면 'skipped_dedup'
 * - enabled=false 면 cron 자체 skip (kill switch)
 * - Discord 호출은 DiscordNotifier 공용 (abuser-ban 과 같은 URL)
 *
 * abuser-ban 은 이 service 안 거치고 자체 실시간 push. alert_history 통합 가시화만.
 */
@Injectable()
export class ThresholdCheckService {
  private readonly logger = new Logger(ThresholdCheckService.name);

  constructor(
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
    @InjectRepository(AlertHistory)
    private readonly historyRepo: Repository<AlertHistory>,
    private readonly thresholds: AlertThresholdsService,
    private readonly discord: DiscordNotifier,
  ) {}

  /** 10분 cron. 임계치 3종 순차 체크. enabled=false 면 전체 skip */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async tick(): Promise<void> {
    try {
      const cfg = await this.thresholds.get();
      if (!cfg.enabled) return;
      await this.checkDailyCost(cfg.dailyCostThresholdUsd);
      await this.checkHourlyErrorRate(cfg.hourlyErrorRateThreshold);
      await this.checkVsYesterday(cfg.vsYesterdayIncreaseThreshold);
    } catch (err) {
      this.logger.error(`tick failed: ${(err as Error).message}`);
    }
  }

  async checkDailyCost(threshold: number): Promise<void> {
    const todayStart = startOfTodayUtc();
    const row = await this.logRepo
      .createQueryBuilder('l')
      .select('COALESCE(SUM(l.cost_usd), 0)', 'cost')
      .where('l.created_at >= :start', { start: todayStart })
      .getRawOne<{ cost: string }>();
    const cost = Number(row?.cost ?? 0);
    if (cost < threshold) return;
    await this.fireAlert(
      'daily_cost',
      cost,
      threshold,
      `🔥 일 누적 비용 임계치 초과\ntoday=$${cost.toFixed(2)}\nthreshold=$${threshold.toFixed(2)}`,
    );
  }

  async checkHourlyErrorRate(threshold: number): Promise<void> {
    const hourStart = new Date(Date.now() - 60 * 60 * 1000);
    const row = await this.logRepo
      .createQueryBuilder('l')
      .select('COUNT(*)', 'total')
      .addSelect("COUNT(*) FILTER (WHERE l.status = 'error')", 'errors')
      .where('l.created_at >= :start', { start: hourStart })
      .getRawOne<{ total: string; errors: string }>();
    const total = Number(row?.total ?? 0);
    const errors = Number(row?.errors ?? 0);
    if (total === 0) return;
    const ratio = errors / total;
    if (ratio < threshold) return;
    await this.fireAlert(
      'hourly_error_rate',
      ratio,
      threshold,
      `⚠️ 최근 1시간 error 비율 임계치 초과\nratio=${(ratio * 100).toFixed(1)}% (${errors}/${total})\nthreshold=${(threshold * 100).toFixed(1)}%`,
    );
  }

  async checkVsYesterday(threshold: number): Promise<void> {
    const now = new Date();
    const todayStart = startOfTodayUtc();
    const minutesIntoDay = Math.floor(
      (now.getTime() - todayStart.getTime()) / (60 * 1000),
    );
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const yesterdaySameTime = new Date(
      yesterdayStart.getTime() + minutesIntoDay * 60 * 1000,
    );

    const [todayRow, yesterdayRow] = await Promise.all([
      this.logRepo
        .createQueryBuilder('l')
        .select('COALESCE(SUM(l.cost_usd), 0)', 'cost')
        .where('l.created_at >= :start AND l.created_at <= :end', {
          start: todayStart,
          end: now,
        })
        .getRawOne<{ cost: string }>(),
      this.logRepo
        .createQueryBuilder('l')
        .select('COALESCE(SUM(l.cost_usd), 0)', 'cost')
        .where('l.created_at >= :start AND l.created_at <= :end', {
          start: yesterdayStart,
          end: yesterdaySameTime,
        })
        .getRawOne<{ cost: string }>(),
    ]);
    const todayCost = Number(todayRow?.cost ?? 0);
    const yesterdayCost = Number(yesterdayRow?.cost ?? 0);
    if (yesterdayCost === 0) return; // 분모 0 safe — 어제 0 이면 비교 불가
    const increasePct = ((todayCost - yesterdayCost) / yesterdayCost) * 100;
    if (increasePct < threshold) return;
    await this.fireAlert(
      'vs_yesterday',
      increasePct,
      threshold,
      `📈 전일 대비 비용 급증\ntoday=$${todayCost.toFixed(2)} vs yesterday(same hour)=$${yesterdayCost.toFixed(2)}\nincrease=+${increasePct.toFixed(1)}% (threshold ${threshold}%)`,
    );
  }

  /** 알람 발송 + dedup 처리 + history 기록 */
  async fireAlert(
    type: AlertType,
    triggered: number,
    threshold: number,
    message: string,
  ): Promise<WebhookStatus> {
    const sinceDedup = new Date(Date.now() - DEDUP_WINDOW_MINUTES * 60 * 1000);
    const recentSent = await this.historyRepo
      .createQueryBuilder('h')
      .where('h.alert_type = :type', { type })
      .andWhere('h.webhook_status = :ok', { ok: 'sent' })
      .andWhere('h.created_at > :since', { since: sinceDedup })
      .getCount();
    if (recentSent > 0) {
      await this.insertHistory(
        type,
        triggered,
        threshold,
        message,
        'skipped_dedup',
      );
      return 'skipped_dedup';
    }

    const result = await this.discord.notify(message, 'critical');
    await this.insertHistory(type, triggered, threshold, message, result);
    return result;
  }

  private async insertHistory(
    type: AlertType,
    triggered: number,
    threshold: number,
    message: string,
    status: WebhookStatus,
  ): Promise<void> {
    await this.historyRepo.save(
      this.historyRepo.create({
        alertType: type,
        triggeredValue: triggered,
        thresholdValue: threshold,
        message,
        webhookStatus: status,
      }),
    );
  }
}

/** UTC 자정 — Date 비교용. KST 자정으로도 가능하나 cron 분포 위해 단순화 */
function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
