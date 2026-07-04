import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UserDevice } from '../devices/user-device.entity';
import { NotificationLog } from './notification-log.entity';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import type { NotificationType } from './notification.types';
import { toKstDateString } from '../common/datetime';

export interface DispatchContent {
  title: string;
  body: string;
  deepLink?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * 알림 전달 공용 로직 — briefing·deadline_urgent cron 이 공유.
 *
 * 흐름 (원자성 보장):
 *   1. dedup — 오늘(KST) 같은 type 이미 발송했으면 skip
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
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
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
    if (await this.alreadySentToday(user.id, type, now)) return false;

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
        await this.pushService
          .sendToTokens(tokens, {
            title: content.title,
            body: content.body,
            deepLink: content.deepLink,
          })
          .catch((err) =>
            this.logger.warn(
              `[dispatch] user ${user.id} push 실패: ${(err as Error).message}`,
            ),
          );
      }
    }
    return true;
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
