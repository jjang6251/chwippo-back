import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { User } from '../users/user.entity';
import { NotificationDispatchService } from './notification-dispatch.service';
import {
  DEADLINE_POINT_OFFSETS,
  resolveAlarmConfig,
} from './notification.types';
import { toKstDateString } from '../common/datetime';

interface BriefingEvent {
  kind: 'deadline' | 'interview' | 'exam';
  dday: number;
  label: string; // 표시용 (예 "카카오 서류 마감")
  deepLink: string | null;
}

interface BriefingResult {
  processedUsers: number;
  sentBriefings: number;
}

/**
 * 아침 브리핑 발송 — 매일 08:00 KST.
 *
 * "잘못된 알람 방지" 필터가 전부 여기 집중:
 *   1. app.status NOT IN ('PASSED','FAILED') — 끝난 카드 제외
 *   2. app.deleted_at IS NULL — 삭제 카드 제외
 *   3. user.suspended_at IS NULL — 정지 사용자 제외
 *   4. alarm_config.master && briefingEnabled — 설정 off 제외
 *   5. 이벤트 dday ∈ 사용자 deadlinePoints (d1/d3/d7) — 그 외 offset 제외
 *   6. 이벤트 0건 → 발송 안 함 ("없으면 침묵")
 *   7. notification_logs dedup — 같은 날 재실행해도 1회만
 *
 * 인앱 알림은 이벤트 있으면 항상 생성 (push 권한 없어도 백업 채널).
 * push 는 device 등록 + 권한 있을 때만 (best-effort).
 */
@Injectable()
export class BriefingService {
  private readonly logger = new Logger(BriefingService.name);
  private static readonly ALL_OFFSETS = [0, 1, 3, 7];

  constructor(
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(ExamSchedule)
    private readonly examRepo: Repository<ExamSchedule>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async sendDailyBriefings(now: Date = new Date()): Promise<BriefingResult> {
    const todayKst = toKstDateString(now);
    // 오늘 KST 기준 offset 별 target 날짜 (YYYY-MM-DD) → dday 역매핑
    const dateToOffset = new Map<string, number>();
    for (const offset of BriefingService.ALL_OFFSETS) {
      dateToOffset.set(this.addKstDays(todayKst, offset), offset);
    }
    const targetDates = Array.from(dateToOffset.keys());

    // 이벤트 수집 (userId 별 그룹) — 끝난/삭제 카드 제외
    const eventsByUser = new Map<string, BriefingEvent[]>();

    const steps = await this.stepRepo
      .createQueryBuilder('step')
      .innerJoin('step.application', 'app')
      .where('app.deleted_at IS NULL')
      .andWhere("app.status NOT IN ('PASSED','FAILED')")
      .andWhere('step.scheduledDate IS NOT NULL')
      .andWhere(
        "(step.scheduledDate AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::DATE = ANY(:dates)",
        { dates: targetDates },
      )
      .select([
        'step.id',
        'step.name',
        'step.orderIndex',
        'step.scheduledDate',
        'step.applicationId',
      ])
      .addSelect(['app.id', 'app.userId', 'app.companyName'])
      .getMany();

    for (const step of steps) {
      const app = step.application;
      if (!app?.userId) continue;
      const dateStr = toKstDateString(step.scheduledDate!);
      const dday = dateToOffset.get(dateStr);
      if (dday === undefined) continue;
      // 첫 스텝(orderIndex 0) = 서류 마감 · 그 외 = 면접/전형
      const isDeadline = step.orderIndex === 0;
      const label = `${app.companyName} ${isDeadline ? '서류 마감' : step.name}`;
      this.pushEvent(eventsByUser, app.userId, {
        kind: isDeadline ? 'deadline' : 'interview',
        dday,
        label,
        deepLink: `/board/${step.applicationId}`,
      });
    }

    const exams = await this.examRepo
      .createQueryBuilder('e')
      .where(
        "(e.exam_date AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::DATE = ANY(:dates)",
        { dates: targetDates },
      )
      .getMany();

    for (const exam of exams) {
      const dateStr = toKstDateString(exam.exam_date);
      const dday = dateToOffset.get(dateStr);
      if (dday === undefined) continue;
      this.pushEvent(eventsByUser, exam.user_id, {
        kind: 'exam',
        dday,
        label: exam.name,
        deepLink: '/calendar',
      });
    }

    if (eventsByUser.size === 0) {
      this.logger.log('[BriefingService] 이벤트 있는 사용자 0명 · 발송 없음');
      return { processedUsers: 0, sentBriefings: 0 };
    }

    // 대상 사용자 로드 (정지·설정 필터)
    const userIds = Array.from(eventsByUser.keys());
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
      if (user.suspendedAt) continue; // 정지 사용자 제외
      const config = resolveAlarmConfig(user.alarmConfig);
      if (!config.master || !config.briefingEnabled) continue;

      const allowedOffsets = DEADLINE_POINT_OFFSETS[config.deadlinePoints];
      const events = (eventsByUser.get(user.id) ?? []).filter((e) =>
        allowedOffsets.includes(e.dday),
      );
      if (events.length === 0) continue; // "없으면 침묵"

      const { title, body } = this.buildMessage(events);
      const sortedEvents = [...events].sort((a, b) => a.dday - b.dday);
      const deepLink = sortedEvents[0]?.deepLink ?? '/calendar';
      const ok = await this.dispatch.dispatch(
        { id: user.id, alarmPermissionGranted: user.alarmPermissionGranted },
        'briefing',
        {
          title,
          body,
          deepLink,
          payload: { eventCount: events.length },
          eventCount: events.length,
        },
        now,
      );
      if (ok) sent += 1;
    }

    this.logger.log(
      `[BriefingService] 처리 ${users.length}명 · 발송 ${sent}건 (KST ${todayKst})`,
    );
    return { processedUsers: users.length, sentBriefings: sent };
  }

  private buildMessage(events: BriefingEvent[]): {
    title: string;
    body: string;
  } {
    const sorted = [...events].sort((a, b) => a.dday - b.dday);
    const lines = sorted.map((e) => {
      const ddayLabel = e.dday === 0 ? '오늘' : `D-${e.dday}`;
      return `${e.label} · ${ddayLabel}`;
    });
    const title =
      events.length === 1
        ? '오늘의 일정 알림'
        : `오늘의 일정 ${events.length}건`;
    return { title, body: lines.join('\n') };
  }

  private pushEvent(
    map: Map<string, BriefingEvent[]>,
    userId: string,
    event: BriefingEvent,
  ): void {
    const arr = map.get(userId) ?? [];
    arr.push(event);
    map.set(userId, arr);
  }

  /** YMD 문자열에 일수 더함 (KST date 계산용) */
  private addKstDays(ymd: string, days: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + days);
    const y2 = dt.getUTCFullYear();
    const m2 = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d2 = String(dt.getUTCDate()).padStart(2, '0');
    return `${y2}-${m2}-${d2}`;
  }
}
