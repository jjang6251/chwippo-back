import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { AlertHistory } from '../admin/entities/alert-history.entity';
import { AlertThresholds } from '../admin/entities/alert-thresholds.entity';
import { formatKstDateTime } from '../common/datetime';
import { DiscordNotifier } from '../common/discord-notifier';
import {
  LlmCallLog,
  type LlmProviderName,
} from './entities/llm-call-log.entity';

/**
 * AI 제공사 장애 실시간 알림 — LlmService 의 error audit 저장 직후 hook.
 *
 * **판정** (Railway 멀티 레플리카 — in-memory 카운터 금지, DB 기반만):
 * 1. llm_call_logs 에서 최근 10분(고정) 해당 provider 의 status='error' 건수 조회.
 * 2. 임계(alert_thresholds.ai_outage_alert_count_10m, 기본 3) 이상 → 발송 후보.
 * 3. 쿨다운(ai_outage_alert_cooldown_min, 기본 30분) 내 동일 provider 'sent' 있으면 skip
 *    (alert_history sliding-window 쿼리 — ThresholdCheckService.fireAlert 패턴 재사용).
 * 4. 동시 2건 race 는 alert_history.dedup_key partial UNIQUE 로 차단 — bucket 이 같은
 *    두 insert 중 하나만 성공, 충돌(23505) 시 발송 스킵.
 *
 * **best-effort** — 어떤 예외도 삼켜 본 AI 호출 흐름을 깨지 않는다.
 */

/** 에러 집계 윈도우 (분) — 고정. count·cooldown 만 admin 조절(alert_thresholds). */
export const OUTAGE_WINDOW_MINUTES = 10;
const DEFAULT_ALERT_COUNT = 3;
const DEFAULT_COOLDOWN_MINUTES = 30;
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class ProviderOutageAlertService {
  private readonly logger = new Logger(ProviderOutageAlertService.name);

  constructor(
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
    @InjectRepository(AlertHistory)
    private readonly historyRepo: Repository<AlertHistory>,
    @InjectRepository(AlertThresholds)
    private readonly thresholdRepo: Repository<AlertThresholds>,
    private readonly discord: DiscordNotifier,
  ) {}

  /**
   * LlmService 가 provider_outage 분류 시 호출. 예외는 전부 삼킨다(best-effort).
   */
  async handleProviderOutage(
    provider: LlmProviderName,
    representativeError: string,
  ): Promise<void> {
    try {
      const cfg = await this.thresholdRepo.findOne({ where: { id: 1 } });
      // enabled=false = 전체 알람 kill switch (기존 임계치 알람과 동일 정책)
      if (cfg && !cfg.enabled) return;
      const countThreshold = cfg?.aiOutageAlertCount10m ?? DEFAULT_ALERT_COUNT;
      const cooldownMin =
        cfg?.aiOutageAlertCooldownMin ?? DEFAULT_COOLDOWN_MINUTES;

      const windowStart = new Date(
        Date.now() - OUTAGE_WINDOW_MINUTES * 60 * 1000,
      );

      // 1. 최근 10분 이 provider 의 error 건수 + fallback 발동 건수 (에러 시에만 실행 — 부담 낮음)
      const row = await this.logRepo
        .createQueryBuilder('l')
        .select('COUNT(*)', 'errors')
        .addSelect(
          "COUNT(*) FILTER (WHERE l.error_message LIKE '[FALLBACK_TRIGGERED]%')",
          'fallbacks',
        )
        .where('l.provider = :provider', { provider })
        .andWhere("l.status = 'error'")
        .andWhere('l.created_at >= :since', { since: windowStart })
        .getRawOne<{ errors: string; fallbacks: string }>();
      const errorCount = Number(row?.errors ?? 0);
      const fallbackCount = Number(row?.fallbacks ?? 0);

      // 2. 임계 미만 → 발송 안 함
      if (errorCount < countThreshold) return;

      // 3. 쿨다운 — 동일 provider 최근 cooldownMin 내 'sent' 있으면 skip (sliding window)
      const cooldownSince = new Date(Date.now() - cooldownMin * 60 * 1000);
      const recentSent = await this.historyRepo
        .createQueryBuilder('h')
        .where('h.alert_type = :type', { type: 'provider_outage' })
        .andWhere('h.webhook_status = :ok', { ok: 'sent' })
        .andWhere('h.dedup_key LIKE :prefix', {
          prefix: `provider_outage:${provider}:%`,
        })
        .andWhere('h.created_at > :since', { since: cooldownSince })
        .getCount();
      if (recentSent > 0) return;

      // 4. race 차단 — 같은 cooldown bucket 이면 dedup_key 동일 → UNIQUE 로 1건만 통과.
      //    동시 요청은 같은 Date.now() bucket 을 계산한다 (경계 순간은 3의 sliding-window 가 보완).
      const bucket = Math.floor(Date.now() / (cooldownMin * 60 * 1000));
      const dedupKey = `provider_outage:${provider}:${bucket}`;

      // 방어적 시크릿 마스킹 — provider 에러 원문에 API 키 파편(sk-...) 이 섞여도 노출 차단.
      // (401 은 internal 이라 hook 미발동이지만 방어적으로 항상 마스킹)
      const safeError = representativeError
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
        .slice(0, 300);
      const message =
        `🚨 AI 제공사 장애 의심 — ${provider}\n` +
        `최근 ${OUTAGE_WINDOW_MINUTES}분 error ${errorCount}건 (임계 ${countThreshold})\n` +
        `fallback 발동 ${fallbackCount}건\n` +
        `대표 에러: ${safeError}\n` +
        `at ${formatKstDateTime(new Date())} (KST)`;

      // 발송 슬롯 선점 — 먼저 insert 해 race 를 UNIQUE 로 차단. 성공 = 우리가 발송 담당.
      // 낙관적으로 'sent' 저장 후, 실제 발송 결과가 다르면 아래에서 update.
      try {
        await this.historyRepo.insert({
          alertType: 'provider_outage',
          triggeredValue: errorCount,
          thresholdValue: countThreshold,
          message,
          webhookStatus: 'sent',
          dedupKey,
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) return; // race 패배 → 다른 레플리카가 발송
        throw err; // 그 외 오류는 바깥 best-effort catch 로
      }

      const status = await this.discord.notify(message, 'critical');
      if (status !== 'sent') {
        // 실제 발송 실패 → 상태 정정 (best-effort). 'sent' 아니면 쿨다운도 안 잡히게 됨.
        await this.historyRepo
          .update({ dedupKey }, { webhookStatus: status })
          .catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(
        `provider outage alert 실패 (provider=${provider}): ${(err as Error).message}`,
      );
    }
  }

  /** Postgres unique_violation(23505) 판정 — TypeORM QueryFailedError.driverError.code */
  private isUniqueViolation(err: unknown): boolean {
    if (err instanceof QueryFailedError) {
      const code = (err.driverError as { code?: string } | undefined)?.code;
      if (code === PG_UNIQUE_VIOLATION) return true;
    }
    const raw = err as
      | { code?: string; driverError?: { code?: string } }
      | undefined;
    return (
      raw?.code === PG_UNIQUE_VIOLATION ||
      raw?.driverError?.code === PG_UNIQUE_VIOLATION
    );
  }
}
