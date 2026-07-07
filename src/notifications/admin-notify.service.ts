import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UserDevice } from '../devices/user-device.entity';
import { Notification } from './notification.entity';
import { PushService } from './push.service';

/**
 * admin 액션 → 사용자 즉시 통지.
 *
 * 정책 (2026-07-04 CEO Q5):
 *   - 정지·해제만 즉시 push (계정 상태라 즉시 알아야 함)
 *   - 코인/plan 변경은 pending_notification 큐 → 다음 브리핑 편입 (심야 push 방지)
 *     → 이건 기존 pendingNotification 메커니즘 유지, 이 서비스는 정지·해제만.
 *
 * admin type 은 dedup 없음 (여러 번 발생 가능). 인앱 알림 항상 생성 + push best-effort.
 * opt-out 불가 (system-critical) — alarm_config 무시.
 */
@Injectable()
export class AdminNotifyService {
  private readonly logger = new Logger(AdminNotifyService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserDevice)
    private readonly deviceRepo: Repository<UserDevice>,
    private readonly pushService: PushService,
  ) {}

  /** 정지 통지 — 즉시. 정지 사용자도 받아야 하므로 suspended 필터 안 함. */
  async notifySuspended(userId: string, reason: string | null): Promise<void> {
    const body = reason
      ? `계정이 정지되었습니다. 사유: ${reason}`
      : '계정이 정지되었습니다. 자세한 내용은 문의해주세요.';
    await this.notifyImmediate(userId, {
      title: '계정 정지 안내',
      body,
      deepLink: '/inquiry',
    });
  }

  /** 정지 해제 통지 — 즉시. */
  async notifyUnsuspended(userId: string): Promise<void> {
    await this.notifyImmediate(userId, {
      title: '계정 정지 해제',
      body: '계정 정지가 해제되었습니다. 다시 이용하실 수 있어요.',
      deepLink: '/calendar',
    });
  }

  /**
   * cost hardening ④ — 범용 즉시 통지 (인앱 + push).
   * QuotaNotifyService 등 다른 모듈의 사용자 통지 진입점.
   */
  async notifyUser(
    userId: string,
    content: { title: string; body: string; deepLink: string },
  ): Promise<void> {
    return this.notifyImmediate(userId, content);
  }

  private async notifyImmediate(
    userId: string,
    content: { title: string; body: string; deepLink: string },
  ): Promise<void> {
    // 인앱 알림 생성 (best-effort · 실패해도 admin 액션은 이미 완료)
    try {
      await this.notificationRepo.insert({
        userId,
        type: 'admin',
        title: content.title,
        body: content.body,
        deepLink: content.deepLink,
        read: false,
      });
    } catch (err) {
      this.logger.warn(
        `[AdminNotify] user ${userId} 인앱 알림 생성 실패: ${(err as Error).message}`,
      );
    }

    // push (권한 있을 때만) — opt-out 불가지만 OS 권한은 존중
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, alarmPermissionGranted: true },
    });
    if (!user?.alarmPermissionGranted) return;

    const devices = await this.deviceRepo.find({
      where: { userId },
      select: { deviceToken: true },
    });
    const tokens = devices.map((d) => d.deviceToken);
    if (tokens.length === 0) return;

    await this.pushService
      .sendToTokens(tokens, content)
      .catch((err) =>
        this.logger.warn(
          `[AdminNotify] user ${userId} push 실패: ${(err as Error).message}`,
        ),
      );
  }
}
