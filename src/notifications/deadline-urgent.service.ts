import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApplicationStep } from '../applications/application-step.entity';
import { User } from '../users/user.entity';
import { NotificationDispatchService } from './notification-dispatch.service';
import { resolveAlarmConfig } from './notification.types';
import { toKstDateString } from '../common/datetime';

interface DeadlineUrgentResult {
  processedUsers: number;
  sentUrgent: number;
}

/**
 * 마감 임박 긴급 — 매일 15:00 KST.
 *
 * 대상: 오늘(KST) 서류 마감(첫 스텝 orderIndex 0)인 카드 · 아직 진행 중(미제출 proxy).
 *   - app.status NOT IN ('PASSED','FAILED') + deleted_at IS NULL
 *   - alarm_config.master && deadlineUrgentEnabled
 *   - user.suspended_at IS NULL
 *   - dedup: 같은 날 긴급 1회
 *
 * "미제출" 완벽 판정은 불가(제출 여부 별도 상태 없음) — 오늘 마감 & 진행 중이면
 * nudge 발송. 이미 냈으면 약한 중복이지만 잘못된 알람은 아님.
 */
@Injectable()
export class DeadlineUrgentService {
  private readonly logger = new Logger(DeadlineUrgentService.name);

  constructor(
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async sendUrgentReminders(
    now: Date = new Date(),
  ): Promise<DeadlineUrgentResult> {
    const todayKst = toKstDateString(now);

    // 오늘 서류 마감(첫 스텝) · 끝나지 않은 카드
    const steps = await this.stepRepo
      .createQueryBuilder('step')
      .innerJoin('step.application', 'app')
      .where('app.deleted_at IS NULL')
      .andWhere("app.status NOT IN ('PASSED','FAILED')")
      .andWhere('step.order_index = 0')
      .andWhere('step.scheduledDate IS NOT NULL')
      .andWhere(
        "(step.scheduledDate AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::DATE = :today",
        { today: todayKst },
      )
      .select(['step.id', 'step.applicationId'])
      .addSelect(['app.id', 'app.userId', 'app.companyName'])
      .getMany();

    if (steps.length === 0) {
      this.logger.log('[DeadlineUrgentService] 오늘 마감 카드 0건');
      return { processedUsers: 0, sentUrgent: 0 };
    }

    // userId 별 (회사명, applicationId) — 여러 개면 첫 건 대표
    const byUser = new Map<
      string,
      { companyName: string; applicationId: string; count: number }
    >();
    for (const step of steps) {
      const app = step.application;
      if (!app?.userId) continue;
      const existing = byUser.get(app.userId);
      if (existing) {
        existing.count += 1;
      } else {
        byUser.set(app.userId, {
          companyName: app.companyName,
          applicationId: step.applicationId,
          count: 1,
        });
      }
    }

    const userIds = Array.from(byUser.keys());
    const users = await this.userRepo.find({
      where: { id: In(userIds) },
      select: {
        id: true,
        suspendedAt: true,
        alarmConfig: true,
        alarmPermissionGranted: true,
      },
    });

    let sent = 0;
    for (const user of users) {
      if (user.suspendedAt) continue;
      const config = resolveAlarmConfig(user.alarmConfig);
      if (!config.master || !config.deadlineUrgentEnabled) continue;

      const info = byUser.get(user.id)!;
      const title = '⏰ 서류 마감 임박';
      const body =
        info.count === 1
          ? `${info.companyName} 서류 마감이 오늘이에요. 제출하셨나요?`
          : `${info.companyName} 외 ${info.count - 1}곳 서류 마감이 오늘이에요.`;

      const ok = await this.dispatch.dispatch(
        { id: user.id, alarmPermissionGranted: user.alarmPermissionGranted },
        'deadline_urgent',
        {
          title,
          body,
          deepLink: `/board/${info.applicationId}`,
          eventCount: info.count,
        },
        now,
      );
      if (ok) sent += 1;
    }

    this.logger.log(
      `[DeadlineUrgentService] 처리 ${users.length}명 · 발송 ${sent}건 (KST ${todayKst})`,
    );
    return { processedUsers: users.length, sentUrgent: sent };
  }
}
