import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { Notification } from './notification.entity';
import { User } from '../users/user.entity';
import { NotificationDispatchService } from './notification-dispatch.service';
import {
  classifyBriefingEventKind,
  resolveAlarmConfig,
  type EventToggles,
} from './notification.types';
import {
  IMMINENT_LEAD_MS,
  hasKstTime,
  loadSentImminentRefIdsToday,
} from './imminent.util';
import { formatKstDateTime } from '../common/datetime';

/** cron 주기 = 판정 윈도우 (15분) */
const WINDOW_MS = 15 * 60 * 1000;

interface ImminentCandidate {
  userId: string;
  /** dedup 키 조각 — stepId | examId */
  refId: string;
  kind: 'deadline' | 'interview' | 'resultDate' | 'exam';
  eventTime: Date;
  /** 예: "카카오 1차 면접" · "TOEIC" */
  label: string;
  location: string | null;
  deepLink: string;
}

interface ImminentResult {
  processedUsers: number;
  sentImminent: number;
}

/**
 * ② 2시간 전 임박 리마인드 — 15분 @Cron (KST).
 *
 * 발송 조건: "이벤트시각 − 2h ∈ [now, now+15m)" — half-open 윈도우라 슬롯 간
 * 중복·누락이 없고, **과거 윈도우(이미 2h 미만 남음)는 미발송** (서버 재시작으로
 * cron 슬롯을 놓쳐도 다음 슬롯에서 지연 폭주가 일어나지 않음).
 *
 * 대상: 시간이 지정된 스텝(끝난 카드 PASSED/FAILED·삭제 제외·본인) + 시험.
 * "시간 지정" 판정 = KST 00:00:00 정각이 아닌 timestamp (date-only 저장 관례가
 * `T00:00:00+09:00` 이므로 자정 정각은 날짜만 있는 이벤트로 간주·제외).
 *
 * dedup: (user, imminent, refId, KST 날짜) — notification_logs 의 type 단위 UNIQUE 는
 * imminent 미적용(하루 다건 허용)이라, notifications.payload.refId 당일 조회로
 * 서비스 레벨 1회 보장. 재실행·경합 시에도 하드캡(dispatch)이 최종 방어.
 *
 * 필터: user.suspended · alarm_config.imminentEnabled (채널) · 해당 eventToggle (kind 별).
 * 발송은 dispatch 파이프라인 재사용 → 인앱+push·세션 분리·하드캡 자동 편입.
 */
@Injectable()
export class ImminentReminderService {
  private readonly logger = new Logger(ImminentReminderService.name);

  constructor(
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(ExamSchedule)
    private readonly examRepo: Repository<ExamSchedule>,
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async sendImminentReminders(now: Date = new Date()): Promise<ImminentResult> {
    // 윈도우: 이벤트시각 ∈ [now+2h, now+2h15m)
    const from = new Date(now.getTime() + IMMINENT_LEAD_MS);
    const to = new Date(now.getTime() + IMMINENT_LEAD_MS + WINDOW_MS);

    const steps = await this.stepRepo
      .createQueryBuilder('step')
      .innerJoin('step.application', 'app')
      .where('app.deleted_at IS NULL')
      .andWhere("app.status NOT IN ('PASSED','FAILED')")
      .andWhere('step.scheduledDate IS NOT NULL')
      .andWhere('step.scheduledDate >= :from AND step.scheduledDate < :to', {
        from,
        to,
      })
      .select([
        'step.id',
        'step.name',
        'step.orderIndex',
        'step.scheduledDate',
        'step.location',
        'step.applicationId',
      ])
      .addSelect(['app.id', 'app.userId', 'app.companyName'])
      .getMany();

    const exams = await this.examRepo
      .createQueryBuilder('e')
      .where('e.exam_date >= :from AND e.exam_date < :to', { from, to })
      .getMany();

    const candidates: ImminentCandidate[] = [];
    for (const step of steps) {
      const app = step.application;
      if (!app?.userId || !step.scheduledDate) continue;
      if (!this.isInWindow(step.scheduledDate, now)) continue; // 과거·경계 밖 방어
      if (!hasKstTime(step.scheduledDate)) continue; // 시간 없는(자정) 스텝 제외
      const kind = classifyBriefingEventKind(step.orderIndex, step.name);
      candidates.push({
        userId: app.userId,
        refId: step.id,
        kind,
        eventTime: step.scheduledDate,
        label: `${app.companyName} ${kind === 'deadline' ? '서류 마감' : step.name}`,
        location: step.location,
        deepLink: `/board/${step.applicationId}`,
      });
    }
    for (const exam of exams) {
      if (!this.isInWindow(exam.exam_date, now)) continue;
      if (!hasKstTime(exam.exam_date)) continue;
      candidates.push({
        userId: exam.user_id,
        refId: exam.id,
        kind: 'exam',
        eventTime: exam.exam_date,
        label: exam.name,
        location: exam.location,
        deepLink: '/calendar',
      });
    }

    if (candidates.length === 0) {
      return { processedUsers: 0, sentImminent: 0 };
    }

    const userIds = Array.from(new Set(candidates.map((c) => c.userId)));
    const users = await this.userRepo.find({
      where: { id: In(userIds) },
      select: {
        id: true,
        suspendedAt: true,
        alarmConfig: true,
        alarmPermissionGranted: true,
      },
    });
    const alreadySent = await loadSentImminentRefIdsToday(
      this.notificationRepo,
      userIds,
      now,
    );

    let sent = 0;
    for (const user of users) {
      if (user.suspendedAt) continue;
      const config = resolveAlarmConfig(user.alarmConfig);
      // master 는 정규화 후 항상 true (방어적 유지) · 채널 게이트는 imminentEnabled
      if (!config.master || !config.imminentEnabled) continue;

      for (const c of candidates) {
        if (c.userId !== user.id) continue;
        if (!this.kindEnabled(c.kind, config.eventToggles)) continue; // 유형 토글
        if (alreadySent.get(user.id)?.has(c.refId)) continue; // (refId, 날짜) dedup

        const hhmm = formatKstDateTime(c.eventTime).slice(11, 16);
        const body = `${c.label} ${hhmm}${c.location ? ` (${c.location})` : ''}`;
        const ok = await this.dispatch.dispatch(
          { id: user.id, alarmPermissionGranted: user.alarmPermissionGranted },
          'imminent',
          {
            title: '⏰ 2시간 뒤',
            body,
            deepLink: c.deepLink,
            payload: { refId: c.refId, kind: c.kind },
            eventCount: 1,
          },
          now,
        );
        if (ok) sent += 1;
      }
    }

    this.logger.log(
      `[ImminentReminderService] 후보 ${candidates.length}건 · 처리 ${users.length}명 · 발송 ${sent}건`,
    );
    return { processedUsers: users.length, sentImminent: sent };
  }

  /** 이벤트시각 − 2h ∈ [now, now+15m) — 과거 윈도우는 false (지연 폭주 방지) */
  private isInWindow(eventTime: Date, now: Date): boolean {
    const lead = eventTime.getTime() - IMMINENT_LEAD_MS;
    return lead >= now.getTime() && lead < now.getTime() + WINDOW_MS;
  }

  /** 이벤트 kind 가 사용자 eventToggles 로 켜져 있는지 */
  private kindEnabled(
    kind: ImminentCandidate['kind'],
    toggles: EventToggles,
  ): boolean {
    switch (kind) {
      case 'deadline':
        return toggles.deadline;
      case 'interview':
        return toggles.interview;
      case 'exam':
        return toggles.exam;
      case 'resultDate':
        return toggles.resultDate;
    }
  }
}
