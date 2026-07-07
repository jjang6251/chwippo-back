import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AdminNotifyService } from '../notifications/admin-notify.service';
import { toKstDateString } from '../common/datetime';
import { User } from '../users/user.entity';
import type { LlmFeature } from './entities/llm-call-log.entity';
import { getFeatureLabel } from './feature-label';

/**
 * cost hardening ④ — AI 한도 변경·초과·리셋 사용자 통지 (CEO 승인 설계 2026-07-06).
 *
 * | 이벤트 | 대상 | 채널 |
 * |---|---|---|
 * | 전체(tier) 한도 변경 | 해당 tier 전체 | 인앱 (bulk) + push best-effort |
 * | 개별 override 설정/해제/자동제재 | 해당 유저 | 인앱 + push + 접속 시 모달(pending) |
 * | 한도 초과 | 해당 유저 | 인앱 (KST 일 1회 dedup — 재시도 스팸 방지) |
 * | 사용량 리셋 (개별/전체) | 해당 유저/전체 | 인앱 + push |
 *
 * 모든 통지는 best-effort — 본 액션(한도 변경 등)을 절대 막지 않는다.
 * push 는 AdminNotifyService/디바이스 토큰 경유 — 앱 배포 후 자동으로 폰 푸시 활성
 * (이 서비스 코드는 그대로).
 */
@Injectable()
export class QuotaNotifyService {
  private readonly logger = new Logger(QuotaNotifyService.name);

  constructor(
    private readonly adminNotify: AdminNotifyService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  /** 개별 override 설정 — 인앱+push + 접속 시 모달 */
  async notifyOverrideSet(
    userId: string,
    input: {
      dailyCapOverride: number;
      validUntil: Date | null;
      reason: 'manual_admin' | 'fair_use';
    },
  ): Promise<void> {
    const untilText = input.validUntil
      ? `${toKstDateString(input.validUntil)} 까지 `
      : '';
    const title =
      input.reason === 'fair_use'
        ? '🎁 AI 이용 한도가 상향되었어요'
        : '⚙️ AI 이용 한도가 조정되었어요';
    const body = `${untilText}AI 기능 일 한도가 ${input.dailyCapOverride}회로 ${
      input.reason === 'fair_use' ? '상향' : '조정'
    }되었어요.`;
    await this.safeNotifyUser(userId, title, body, true);
  }

  /** 개별 override 해제 — 통상 한도 복귀 */
  async notifyOverrideCleared(userId: string): Promise<void> {
    await this.safeNotifyUser(
      userId,
      '⚙️ AI 이용 한도가 복구되었어요',
      '개별 한도가 해제되어 원래(플랜 기준) 한도로 돌아왔어요.',
      true,
    );
  }

  /** 자동 제재 (3일 연속 한도 도달) — 유저도 알아야 함 */
  async notifyAutoBan(
    userId: string,
    dailyCap: number,
    validUntil: Date,
  ): Promise<void> {
    await this.safeNotifyUser(
      userId,
      '⚠️ AI 이용이 일시 제한되었어요',
      `연속으로 일 한도에 도달해 ${toKstDateString(validUntil)} 까지 일 ${dailyCap}회로 제한돼요. 문의가 있으면 언제든 알려주세요.`,
      true,
    );
  }

  /** 사용량 리셋 (개별) */
  async notifyUserReset(userId: string): Promise<void> {
    await this.safeNotifyUser(
      userId,
      '🔄 AI 사용량이 리셋되었어요',
      '오늘 사용량이 초기화되어 지금 바로 다시 이용할 수 있어요.',
      false, // 좋은 소식이지만 모달까지는 과함 — 인앱+push 만
    );
  }

  /** 전체(tier) 한도 변경 — bulk 인앱. push 는 규모 커지면 별도 검토 (현재 토큰 0) */
  async notifyMatrixChanged(
    feature: LlmFeature,
    tier: string,
    changes: { dayLimit?: number; monthLimit?: number },
  ): Promise<void> {
    const parts: string[] = [];
    if (changes.dayLimit !== undefined) parts.push(`일 ${changes.dayLimit}회`);
    if (changes.monthLimit !== undefined)
      parts.push(`월 ${changes.monthLimit}회`);
    if (parts.length === 0) return; // 한도 외 변경(cooldown 등)은 통지 대상 아님

    const label = getFeatureLabel(feature);
    try {
      await this.dataSource.query(
        `INSERT INTO notifications (user_id, type, title, body, deep_link)
         SELECT id, 'admin', $1, $2, '/settings/help'
         FROM users WHERE tier = $3 AND suspended_at IS NULL`,
        [
          '📊 AI 이용 한도가 변경되었어요',
          `${label} 한도가 ${parts.join(' · ')}로 변경되었어요.`,
          tier,
        ],
      );
    } catch (err) {
      this.logger.warn(
        `matrix 변경 bulk 통지 실패 (${feature}/${tier}): ${(err as Error).message}`,
      );
    }
  }

  /** 전체 사용량 리셋 — bulk 인앱 */
  async notifyAllReset(): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO notifications (user_id, type, title, body, deep_link)
         SELECT id, 'admin', $1, $2, '/settings/help'
         FROM users WHERE suspended_at IS NULL`,
        [
          '🔄 AI 사용량이 리셋되었어요',
          '오늘 사용량이 초기화되어 지금 바로 다시 이용할 수 있어요.',
        ],
      );
    } catch (err) {
      this.logger.warn(`전체 리셋 bulk 통지 실패: ${(err as Error).message}`);
    }
  }

  /**
   * 한도 초과 — KST 일 1회 dedup (같은 feature·같은 날 재시도 스팸 방지).
   * quota-check 의 매 차단 시도마다 호출되므로 반드시 fire-and-forget + dedup.
   */
  async notifyQuotaExceeded(
    userId: string,
    feature: LlmFeature,
    scope: 'day' | 'month',
  ): Promise<void> {
    try {
      const todayKst = toKstDateString(new Date());
      const dup = await this.dataSource.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM notifications
         WHERE user_id = $1 AND type = 'admin'
           AND payload->>'kind' = 'quota_exceeded'
           AND payload->>'feature' = $2
           AND payload->>'scope' = $3
           AND (created_at AT TIME ZONE 'Asia/Seoul')::date = $4::date`,
        [userId, feature, scope, todayKst],
      );
      if (Number(dup[0]?.count ?? 0) > 0) return;

      const label = getFeatureLabel(feature);
      const body =
        scope === 'day'
          ? `오늘 ${label} 한도를 모두 사용했어요. 사용 후 24시간이 지나면 그만큼 다시 이용할 수 있어요.`
          : `이번 달 ${label} 한도를 모두 사용했어요. 다음 달에 다시 이용할 수 있어요.`;
      await this.dataSource.query(
        `INSERT INTO notifications (user_id, type, title, body, deep_link, payload)
         VALUES ($1, 'admin', $2, $3, '/settings/help', $4::jsonb)`,
        [
          userId,
          '⏳ AI 사용 한도에 도달했어요',
          body,
          JSON.stringify({ kind: 'quota_exceeded', feature, scope }),
        ],
      );
    } catch (err) {
      this.logger.warn(
        `한도 초과 통지 실패 (${userId}/${feature}): ${(err as Error).message}`,
      );
    }
  }

  // ── 내부 ──────────────────────────────────────────────

  /** 인앱+push (+옵션: 접속 시 모달). 실패해도 throw 안 함 */
  private async safeNotifyUser(
    userId: string,
    title: string,
    body: string,
    withModal: boolean,
  ): Promise<void> {
    try {
      await this.adminNotify.notifyUser(userId, {
        title,
        body,
        deepLink: '/settings/help',
      });
      if (withModal) {
        await this.userRepo.update(userId, {
          pendingNotification: {
            type: 'quota_override',
            title,
            body,
            createdAt: new Date().toISOString(),
          },
        });
      }
    } catch (err) {
      this.logger.warn(
        `개별 한도 통지 실패 (${userId}): ${(err as Error).message}`,
      );
    }
  }
}
