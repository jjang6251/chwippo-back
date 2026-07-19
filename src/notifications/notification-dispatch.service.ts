import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UserDevice } from '../devices/user-device.entity';
import { User } from '../users/user.entity';
import { AuthService } from '../auth/auth.service';
import { NotificationLog } from './notification-log.entity';
import { NotificationsService } from './notifications.service';
import { PushService, PushPayload } from './push.service';
import {
  DEDUP_NOTIFICATION_TYPES,
  type NotificationType,
} from './notification.types';
import { toKstDateString } from '../common/datetime';

/** 만료 세션 사용자 대상 마스킹/유도 푸시의 안전 deepLink (특정 board UUID 미노출) */
const MASKED_DEEP_LINK = '/calendar';

export interface DispatchContent {
  title: string;
  body: string;
  deepLink?: string | null;
  payload?: Record<string, unknown> | null;
  /** 마스킹 요약 푸시("일정 N건")용 이벤트 수 (푸시-세션 분리) */
  eventCount?: number;
}

/** 세션 지속성 웨이브 — 유효 세션 없는 사용자 대상 refresh 유도 후 마스킹 발송 중단 기준 (14일) */
const EXPIRED_PUSH_CUTOFF_DAYS = 14;
const EXPIRED_PUSH_CUTOFF_MS = EXPIRED_PUSH_CUTOFF_DAYS * 24 * 60 * 60 * 1000;

/**
 * Q2 하드캡 — 당일(KST) 정기 알림 발송 상한.
 * dispatch 로 보낸 발송 수가 이 값 이상이면 이후 발송을 드롭한다 (스팸 방어).
 * admin-notify(system-critical)는 dispatch 를 경유하지 않으므로 자동 제외.
 */
const DAILY_HARD_CAP = 4;

type PushDecision =
  | { action: 'skip' }
  | {
      action: 'send';
      payload: PushPayload;
      /** 최초 재로그인 유도 푸시 여부 — 발송 성공 후에만 notified_at 기록 */
      isFirstGuidance?: boolean;
    };

/**
 * 알림 전달 공용 로직 — briefing·deadline_urgent·imminent cron 이 공유.
 *
 * 흐름 (원자성 보장):
 *   1. dedup — 오늘(KST) 같은 type 이미 발송했으면 skip (briefing·deadline_urgent 만
 *      · imminent 는 하루 다건 허용, per-refId dedup 은 발송 서비스 책임)
 *   1b. Q2 하드캡 — 당일(KST) 총 발송 ≥4 → 드롭+로그 (admin-notify 경로는 캡 제외)
 *   2. TX: 인앱 Notification 생성 + notification_log insert
 *   3. commit 후 push (best-effort) — 권한 + device 있을 때만
 *
 * 인앱 알림은 push 권한 없어도 생성 (백업 채널).
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    @InjectRepository(UserDevice)
    private readonly deviceRepo: Repository<UserDevice>,
    @InjectRepository(NotificationLog)
    private readonly logRepo: Repository<NotificationLog>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
    private readonly authService: AuthService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * @returns 실제 발송했으면 true, dedup/경합 skip 이면 false
   */
  async dispatch(
    user: { id: string; alarmPermissionGranted: boolean },
    type: Exclude<NotificationType, 'admin'>,
    content: DispatchContent,
    now: Date = new Date(),
  ): Promise<boolean> {
    // type 단위 "하루 1회" dedup — briefing·deadline_urgent 만.
    // imminent 는 하루 다건 허용 (per-refId dedup 은 ImminentReminderService 책임).
    if (
      DEDUP_NOTIFICATION_TYPES.includes(type) &&
      (await this.alreadySentToday(user.id, type, now))
    ) {
      return false;
    }

    // Q2 하드캡 — 당일 발송 수가 상한 이상이면 드롭 (구분 가능한 로그)
    const sentToday = await this.countSentToday(user.id, now);
    if (sentToday >= DAILY_HARD_CAP) {
      this.logger.warn(
        `[dispatch] HARDCAP_DROP user ${user.id} type ${type} — 당일 발송 ${sentToday}건 ≥ 상한 ${DAILY_HARD_CAP} (드롭)`,
      );
      return false;
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        await this.notificationsService.create(
          {
            userId: user.id,
            type,
            title: content.title,
            body: content.body,
            deepLink: content.deepLink ?? null,
            payload: content.payload ?? null,
          },
          manager,
        );
        await manager.getRepository(NotificationLog).insert({
          userId: user.id,
          type,
        });
      });
    } catch (err) {
      // UNIQUE 위반 = 동시 실행 dedup 경합 → 조용히 skip
      this.logger.warn(
        `[dispatch] user ${user.id} type ${type} 저장 실패(dedup 경합 가능): ${(err as Error).message}`,
      );
      return false;
    }

    if (user.alarmPermissionGranted) {
      const devices = await this.deviceRepo.find({
        where: { userId: user.id },
        select: { deviceToken: true },
      });
      const tokens = devices.map((d) => d.deviceToken);
      if (tokens.length > 0) {
        // 푸시-세션 분리: 유효 세션 유무에 따라 실제/유도/마스킹/중단 결정
        const decision = await this.resolvePushDecision(user.id, content, now);
        if (decision.action === 'send') {
          const result = await this.pushService
            .sendToTokens(tokens, decision.payload)
            .catch((err) => {
              this.logger.warn(
                `[dispatch] user ${user.id} push 실패: ${(err as Error).message}`,
              );
              return null;
            });
          // 재로그인 유도 푸시는 "발송 성공 후에만" notified_at 기록 (실패 시 다음에 다시 유도)
          if (decision.isFirstGuidance && result && result.sent > 0) {
            await this.userRepo
              .update(user.id, { sessionExpiredNotifiedAt: now })
              .catch(() => undefined);
          }
        }
      }
    }
    return true;
  }

  /**
   * 푸시-세션 분리 (A안) — 유효 refresh 세션 유무로 푸시 페이로드 결정.
   *
   * - 유효 세션 있음 (또는 legacy 로그인 상태) → 실제 내용 그대로
   *   (세션 유효성 판정은 AuthService.hasValidSession 단일 소스 — 인라인 count 중복 제거)
   * - 유효 세션 0개 (만료·revoke) + 디바이스 토큰 살아있음:
   *   ① 최초 감지 → "로그인 만료" 재로그인 유도 (notified_at 은 발송 성공 후 dispatch 가 기록)
   *   ② 이후 → 마스킹 요약 ("오늘 확인할 일정이 있어요 🔔" / "일정 N건" — 개인 내용 비노출)
   *   ③ 최초 감지 후 14일 경과 → 발송 중단 (skip)
   *
   * 유도·마스킹 푸시의 deepLink 는 `/calendar` 로 고정 — content.deepLink(특정 board UUID) 미노출.
   * 인앱 알림(notifications)은 이 판정 위에서 이미 원문 저장됨 (재로그인 시 알림센터 전체 확인).
   */
  private async resolvePushDecision(
    userId: string,
    content: DispatchContent,
    now: Date,
  ): Promise<PushDecision> {
    // 유효 세션(만료 전·revoke 안 됨) 또는 legacy 로그인 상태 → 실제 내용
    if (await this.authService.hasValidSession(userId, now)) {
      return { action: 'send', payload: this.realPayload(content) };
    }

    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, sessionExpiredNotifiedAt: true },
    });
    const notifiedAt = user?.sessionExpiredNotifiedAt ?? null;
    if (!notifiedAt) {
      // ① 최초 감지 — 재로그인 유도 (anchor 는 발송 성공 후 기록)
      return {
        action: 'send',
        isFirstGuidance: true,
        payload: {
          title: '로그인이 만료됐어요',
          body: '다시 로그인하면 일정 알림이 이어져요',
          deepLink: MASKED_DEEP_LINK,
        },
      };
    }

    // ③ 14일 경과 → 발송 중단
    if (notifiedAt.getTime() <= now.getTime() - EXPIRED_PUSH_CUTOFF_MS) {
      return { action: 'skip' };
    }

    // ② 마스킹 요약 (회사명·전형명·문항 등 개인 내용 비노출)
    const count = content.eventCount ?? 0;
    return {
      action: 'send',
      payload: {
        title: '오늘 확인할 일정이 있어요 🔔',
        body: count > 0 ? `일정 ${count}건` : '확인할 일정이 있어요',
        deepLink: MASKED_DEEP_LINK,
      },
    };
  }

  private realPayload(content: DispatchContent): PushPayload {
    return {
      title: content.title,
      body: content.body,
      deepLink: content.deepLink,
    };
  }

  /**
   * 오늘(KST) 이 사용자에게 dispatch 로 보낸 총 발송 수 (모든 type).
   * Q2 하드캡 판정용. notification_logs 는 dispatch 발송만 기록하므로 그대로 카운트.
   */
  async countSentToday(userId: string, now: Date): Promise<number> {
    const todayKst = toKstDateString(now);
    return this.logRepo
      .createQueryBuilder('log')
      .where('log.user_id = :userId', { userId })
      .andWhere("(log.sent_at AT TIME ZONE 'Asia/Seoul')::DATE = :today", {
        today: todayKst,
      })
      .getCount();
  }

  /** 오늘(KST) 같은 type 발송 기록 존재 여부 */
  async alreadySentToday(
    userId: string,
    type: Exclude<NotificationType, 'admin'>,
    now: Date,
  ): Promise<boolean> {
    const todayKst = toKstDateString(now);
    const count = await this.logRepo
      .createQueryBuilder('log')
      .where('log.user_id = :userId', { userId })
      .andWhere('log.type = :type', { type })
      .andWhere("(log.sent_at AT TIME ZONE 'Asia/Seoul')::DATE = :today", {
        today: todayKst,
      })
      .getCount();
    return count > 0;
  }
}
