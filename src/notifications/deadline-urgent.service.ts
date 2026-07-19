import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApplicationStep } from '../applications/application-step.entity';
import { Notification } from './notification.entity';
import { User } from '../users/user.entity';
import { NotificationDispatchService } from './notification-dispatch.service';
import { AlarmConfig, resolveAlarmConfig } from './notification.types';
import {
  IMMINENT_LEAD_MS,
  hasKstTime,
  loadSentImminentRefIdsToday,
} from './imminent.util';
import { toKstDateString } from '../common/datetime';

interface DeadlineUrgentResult {
  processedUsers: number;
  sentUrgent: number;
}

/**
 * 마감 임박 긴급 (마감 당일 알림) — 매일 15:00 KST.
 *
 * 대상: 오늘(KST) 서류 마감(첫 스텝 orderIndex 0)인 카드 · 아직 진행 중(미제출 proxy).
 *   - app.status NOT IN ('PASSED','FAILED') + deleted_at IS NULL
 *   - alarm_config.master && deadlineUrgentEnabled
 *   - user.suspended_at IS NULL
 *   - dedup: 같은 날 긴급 1회
 *
 * "미제출" 완벽 판정은 불가(제출 여부 별도 상태 없음) — 오늘 마감 & 진행 중이면
 * nudge 발송. 이미 냈으면 약한 중복이지만 잘못된 알람은 아님.
 *
 * ## imminent(2시간 전)와의 이중 발송 해소 — 백업 보장 설계 (2026-07-19 CEO)
 * **원칙: "가야 하는데 안 가는" 침묵 손실 절대 금지.** 확실히 임박이 커버하는
 * 마감만 15시에서 제외하고, 불확실하면 15시가 백업 발송한다.
 *   - 시간 없는 마감(KST 자정 정각) → 기존대로 발송 (회귀 불변 · 임박 대상 아님)
 *   - 시간 T 있는 마감 → 아래 **모두** 충족할 때만 제외:
 *     a. 임박 채널 유효 ON (imminentEnabled && eventToggles.deadline — resolve 기준)
 *     b. 오늘 이 refId 로 imminent 이미 발송됨 **또는** T−2h 가 아직 미래
 *        (15시 cron 기준 T > 17:00 — 임박이 확실히 예정)
 *   - "이미 발송" 판정·"시간 있음" 판정은 imminent 와 **단일 공유 함수**
 *     (imminent.util — loadSentImminentRefIdsToday·hasKstTime) 재사용. 판정 불일치 =
 *     양쪽 다 놓치는 틈이므로 복붙 금지.
 */
@Injectable()
export class DeadlineUrgentService {
  private readonly logger = new Logger(DeadlineUrgentService.name);

  constructor(
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
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
      // timestamptz 는 단일 AT TIME ZONE (이중 'UTC' 체인은 naive 전용 — 하루 어긋남)
      .andWhere(
        "(step.scheduledDate AT TIME ZONE 'Asia/Seoul')::DATE = :today",
        { today: todayKst },
      )
      .select(['step.id', 'step.applicationId', 'step.scheduledDate'])
      .addSelect(['app.id', 'app.userId', 'app.companyName'])
      .getMany();

    if (steps.length === 0) {
      this.logger.log('[DeadlineUrgentService] 오늘 마감 카드 0건');
      return { processedUsers: 0, sentUrgent: 0 };
    }

    // userId 별 오늘 마감 스텝 목록
    const stepsByUser = new Map<string, ApplicationStep[]>();
    for (const step of steps) {
      if (!step.application?.userId) continue;
      const arr = stepsByUser.get(step.application.userId) ?? [];
      arr.push(step);
      stepsByUser.set(step.application.userId, arr);
    }

    const userIds = Array.from(stepsByUser.keys());
    const users = await this.userRepo.find({
      where: { id: In(userIds) },
      select: {
        id: true,
        suspendedAt: true,
        alarmConfig: true,
        alarmPermissionGranted: true,
      },
    });
    // imminent 와 동일한 조회로 "오늘 이미 임박 발송된 refId" 확보 (공유 함수)
    const sentImminent = await loadSentImminentRefIdsToday(
      this.notificationRepo,
      userIds,
      now,
    );

    let sent = 0;
    for (const user of users) {
      if (user.suspendedAt) continue;
      const config = resolveAlarmConfig(user.alarmConfig);
      if (!config.master || !config.deadlineUrgentEnabled) continue;

      // imminent 가 확실히 커버하는 마감만 제외 — 불확실하면 발송 (백업 보장)
      const remaining = (stepsByUser.get(user.id) ?? []).filter(
        (step) =>
          !this.coveredByImminent(step, config, sentImminent.get(user.id), now),
      );
      if (remaining.length === 0) continue;

      const rep = remaining[0];
      const companyName = rep.application.companyName;
      const title = '⏰ 서류 마감 임박';
      const body =
        remaining.length === 1
          ? `${companyName} 서류 마감이 오늘이에요. 제출하셨나요?`
          : `${companyName} 외 ${remaining.length - 1}곳 서류 마감이 오늘이에요.`;

      const ok = await this.dispatch.dispatch(
        { id: user.id, alarmPermissionGranted: user.alarmPermissionGranted },
        'deadline_urgent',
        {
          title,
          body,
          deepLink: `/board/${rep.applicationId}`,
          eventCount: remaining.length,
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

  /**
   * 이 마감이 imminent(2시간 전)로 **확실히** 커버되는가 — true 면 15시에서 제외.
   *
   * 판정이 조금이라도 불확실하면 false (15시 백업 발송)로 기운다.
   *
   * ⚠️ 알려진 잔여 구멍 (이번 스코프 밖 · 의도적 미해결):
   *   15시 이후에 "시간 있는 오늘 마감"을 새로 입력했고 임박 윈도우(T−2h)도 이미
   *   지난 경우 → 15시 cron 도 임박 cron 도 못 잡는다. 이는 날짜만 마감을 15시
   *   이후 입력한 기존 특성과 같은 "늦은 입력" 계열 — 별도 보완 없이 동일 취급.
   */
  private coveredByImminent(
    step: ApplicationStep,
    config: AlarmConfig,
    sentRefIds: Set<string> | undefined,
    now: Date,
  ): boolean {
    const t = step.scheduledDate;
    // 시간 없는(자정 정각) 마감 → 임박 대상 아님 · 기존대로 15시 발송 (회귀 불변)
    if (!t || !hasKstTime(t)) return false;
    // a. 임박 채널이 유효 ON 이 아니면 임박은 안 온다 → 15시 발송
    if (!config.imminentEnabled || !config.eventToggles.deadline) return false;
    // b-1. 오늘 이 refId 로 임박이 이미 나갔음 → 중복 방지 제외
    if (sentRefIds?.has(step.id)) return true;
    // b-2. T−2h 가 아직 미래 (15시 기준 T > 17:00) → 임박이 확실히 예정 → 제외
    if (t.getTime() - IMMINENT_LEAD_MS > now.getTime()) return true;
    // 그 외 (임박 윈도우가 지났는데 발송 기록 없음 = 늦은 입력 등) → 백업 발송
    return false;
  }
}
