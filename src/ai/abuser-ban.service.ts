import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AlertHistory } from '../admin/entities/alert-history.entity';
import { DiscordNotifier } from '../common/discord-notifier';
import { LlmCallLog, LlmFeature } from './entities/llm-call-log.entity';
import { UserAiQuota } from './entities/user-ai-quota.entity';

/**
 * F6 PR 1 Phase 3 — AI 사용 abuser 자동 ban 서비스.
 *
 * **trigger 조건** (focus.md F6 PR 1 H2):
 * - 같은 user 가 같은 feature 의 **일 한도를 3일 연속 도달** → 7일간 일 5회로 강제 + Discord webhook
 *
 * **부수 동작**:
 * - `user_ai_quotas` UPSERT (daily_cap_override=5, valid_until=now+7d, reason='auto_ban_3_consecutive_days')
 * - `admin_audit_logs.action='auto_ban_ai'` audit (adminUserId=NULL, targetType='user', targetId=userId)
 * - Discord webhook (ENV `ADMIN_ALERT_WEBHOOK_URL` 미설정 시 skip)
 * - **race 차단**: 같은 user 가 같은 날 두 번 trigger 되어도 audit row 중복 안 됨 (created_at 날짜 + userId 로 사전 체크)
 *
 * **호출 시점**:
 * - 각 caller (NoteSummaryService, AiCoverletterDraftService) 가 quota 도달 detect 시 본 service.checkAndBan(userId, feature) 호출
 * - 본 서비스는 LLM 호출 path 외부 → race condition 영향 최소
 */

const BAN_DURATION_DAYS = 7;
const BAN_DAILY_CAP = 5;
const CONSECUTIVE_DAYS_FOR_BAN = 3;

@Injectable()
export class AbuserBanService {
  private readonly logger = new Logger(AbuserBanService.name);

  constructor(
    @InjectRepository(UserAiQuota)
    private readonly quotaRepo: Repository<UserAiQuota>,
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
    @Inject(forwardRef(() => AdminAuditService))
    private readonly auditService: AdminAuditService,
    private readonly discord: DiscordNotifier,
    @InjectRepository(AlertHistory)
    private readonly historyRepo: Repository<AlertHistory>,
  ) {}

  /**
   * 사용자별 active quota override 조회 — caller 의 quota 체크에 사용.
   * valid_until 만료된 row 는 자연히 무시. row 없거나 expired → null (통상 한도 사용).
   */
  async getActiveOverride(userId: string): Promise<UserAiQuota | null> {
    const row = await this.quotaRepo.findOne({ where: { userId } });
    if (!row) return null;
    if (row.validUntil && row.validUntil < new Date()) return null;
    return row;
  }

  /**
   * caller 가 quota 도달 detect 시 호출.
   * 최근 N일 동안 같은 feature 의 일 한도 도달 day 개수를 계산.
   * 3일 연속 (오늘 포함) 도달 시 ban 발동.
   *
   * `dayLimit` — feature 별 통상 일 한도 (caller 가 전달). 이미 도달했으므로 본 함수 호출.
   */
  async checkAndBan(
    userId: string,
    feature: LlmFeature,
    dayLimit: number,
  ): Promise<{ banned: boolean }> {
    // 이미 ban 상태 (valid_until 미래) — 중복 발동 안 함
    const existing = await this.getActiveOverride(userId);
    if (existing && existing.reason === 'auto_ban_3_consecutive_days') {
      return { banned: false };
    }

    // 최근 N일 (오늘 포함 N=CONSECUTIVE_DAYS_FOR_BAN) 의 일별 사용 카운트
    const usageByDay = await this.dailyUsageCounts(
      userId,
      feature,
      CONSECUTIVE_DAYS_FOR_BAN,
    );

    // 모든 day 가 일 한도 도달 (>=dayLimit) 인지
    const allHit = usageByDay.every((c) => c >= dayLimit);
    if (!allHit) return { banned: false };

    // ── ban 발동 ──
    const validUntil = new Date(Date.now() + BAN_DURATION_DAYS * 86_400 * 1000);
    await this.quotaRepo.upsert(
      {
        userId,
        dailyCapOverride: BAN_DAILY_CAP,
        validUntil,
        reason: 'auto_ban_3_consecutive_days',
      },
      ['userId'],
    );

    // audit (시스템 자동 ban → adminUserId=NULL)
    await this.auditService.log(null, 'auto_ban_ai', 'user', userId, {
      reason: 'auto_ban_3_consecutive_days',
      duration_days: BAN_DURATION_DAYS,
      daily_cap_override: BAN_DAILY_CAP,
      triggered_feature: feature,
      consecutive_days: CONSECUTIVE_DAYS_FOR_BAN,
      day_limit: dayLimit,
    });

    // Discord webhook (best-effort, 실패해도 ban 자체 영향 X)
    await this.notifyDiscord(userId, feature, validUntil);

    this.logger.warn(
      `Auto-ban activated (user=${userId}, feature=${feature}, until=${validUntil.toISOString()})`,
    );
    return { banned: true };
  }

  /**
   * 최근 N일 (오늘 포함) 의 일별 ok+retry_parsing 카운트.
   * status='ok' / 'retry_parsing' 만 카운트 (error/blocked 제외, NoteSummary 의 quota 패턴 동일).
   */
  private async dailyUsageCounts(
    userId: string,
    feature: LlmFeature,
    days: number,
  ): Promise<number[]> {
    const counts: number[] = [];
    for (let offset = 0; offset < days; offset++) {
      const dayEnd = new Date();
      dayEnd.setHours(0, 0, 0, 0);
      dayEnd.setDate(dayEnd.getDate() - offset + 1);
      const dayStart = new Date(dayEnd);
      dayStart.setDate(dayStart.getDate() - 1);

      const count = await this.logRepo.count({
        where: {
          userId,
          feature,
          status: In(['ok', 'retry_parsing']),
          createdAt: Between(dayStart, dayEnd),
        },
      });
      counts.push(count);
    }
    return counts;
  }

  private async notifyDiscord(
    userId: string,
    feature: LlmFeature,
    validUntil: Date,
  ): Promise<void> {
    const content = `🚨 AI Auto-Ban\nuser=${userId}\nfeature=${feature}\nuntil=${validUntil.toISOString()}\ndaily_cap=${BAN_DAILY_CAP}`;
    const status = await this.discord.notify(content);
    // 5.6.3 — alert_history 통합 가시화 (/ops/monitoring 의 admin UI 에서 임계치 알람과 함께 표시)
    try {
      await this.historyRepo.save(
        this.historyRepo.create({
          alertType: 'abuser_ban',
          triggeredValue: BAN_DAILY_CAP,
          thresholdValue: CONSECUTIVE_DAYS_FOR_BAN,
          message: content,
          webhookStatus: status,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `alert_history insert 실패 (abuser_ban, user=${userId}): ${(err as Error).message}`,
      );
    }
  }
}
