import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { DeadlineUrgentService } from './deadline-urgent.service';
import { ImminentReminderService } from './imminent-reminder.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { Notification } from './notification.entity';
import { User } from '../users/user.entity';
import type { AlarmConfigUpdate } from './notification.types';

/**
 * 종합 매트릭스 — 15시 마감 당일 알림 × imminent(2시간 전) 교차 검증.
 *
 * **목적: 침묵 손실 0 증명.** 각 시나리오에서 두 서비스를 같은 데이터로 실제
 * 실행해 {15시, 임박} 중 **정확히 1개만** 배달됨을 단언한다 — 제외(중복 방지)와
 * 발송(백업 보장)을 같은 테스트에서 교차 확인.
 */

const NOW15 = new Date('2026-07-04T06:00:00Z'); // KST 15:00 (마감 당일 cron)
const kstAt = (hhmm: string) => new Date(`2026-07-04T${hhmm}:00+09:00`);
const MIDNIGHT_KST = kstAt('00:00');

function makeDeadlineStep(scheduledDate: Date): ApplicationStep {
  return {
    id: 's1',
    applicationId: 'app-1',
    orderIndex: 0, // 서류 마감 → imminent kind 'deadline' (eventToggles.deadline)
    name: '서류 제출',
    scheduledDate,
    location: null,
    notes: null,
    pinnedContent: null,
    application: { userId: 'u1', companyName: '카카오' },
  } as ApplicationStep;
}

function makeUser(config: AlarmConfigUpdate | null): User {
  return {
    id: 'u1',
    suspendedAt: null,
    alarmConfig: config as User['alarmConfig'],
    alarmPermissionGranted: true,
  } as User;
}

function makeSentRow(refId: string): Notification {
  return {
    id: `sent-${refId}`,
    userId: 'u1',
    type: 'imminent',
    title: '⏰ 2시간 뒤',
    body: 'x',
    deepLink: null,
    payload: { refId },
    read: false,
    createdAt: NOW15,
  };
}

describe('마감 당일 × 임박 교차 커버리지 (침묵 손실 0)', () => {
  let urgentService: DeadlineUrgentService;
  let imminentService: ImminentReminderService;
  let stepQb: jest.Mocked<SelectQueryBuilder<ApplicationStep>>;
  let examQb: jest.Mocked<SelectQueryBuilder<ExamSchedule>>;
  let notifQb: jest.Mocked<SelectQueryBuilder<Notification>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let dispatch: jest.Mocked<NotificationDispatchService>;

  beforeEach(async () => {
    const stepRepo = mock<Repository<ApplicationStep>>();
    const examRepo = mock<Repository<ExamSchedule>>();
    const notificationRepo = mock<Repository<Notification>>();
    userRepo = mock<Repository<User>>();
    dispatch = mock<NotificationDispatchService>();

    stepQb = mock<SelectQueryBuilder<ApplicationStep>>();
    ['innerJoin', 'where', 'andWhere', 'select', 'addSelect'].forEach((m) =>
      (stepQb as never as Record<string, jest.Mock>)[m].mockReturnThis(),
    );
    stepQb.getMany.mockResolvedValue([]);
    stepRepo.createQueryBuilder.mockReturnValue(stepQb);

    examQb = mock<SelectQueryBuilder<ExamSchedule>>();
    examQb.where.mockReturnThis();
    examQb.getMany.mockResolvedValue([]);
    examRepo.createQueryBuilder.mockReturnValue(examQb);

    notifQb = mock<SelectQueryBuilder<Notification>>();
    ['where', 'andWhere', 'select'].forEach((m) =>
      (notifQb as never as Record<string, jest.Mock>)[m].mockReturnThis(),
    );
    notifQb.getMany.mockResolvedValue([]);
    notificationRepo.createQueryBuilder.mockReturnValue(notifQb);

    dispatch.dispatch.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeadlineUrgentService,
        ImminentReminderService,
        { provide: getRepositoryToken(ApplicationStep), useValue: stepRepo },
        { provide: getRepositoryToken(ExamSchedule), useValue: examRepo },
        {
          provide: getRepositoryToken(Notification),
          useValue: notificationRepo,
        },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    urgentService = module.get(DeadlineUrgentService);
    imminentService = module.get(ImminentReminderService);
  });

  /**
   * 두 서비스를 같은 데이터로 실행 — 배달 합계 반환.
   * priorImminent = 이미 배달된 임박(발송 기록 행) 수를 배달 합계에 포함.
   */
  async function runScenario(opts: {
    step: ApplicationStep;
    config: AlarmConfigUpdate | null;
    sentRows?: Notification[];
    /** 임박 cron 을 돌릴 시각 (null = 이 시나리오에선 임박 슬롯 없음) */
    imminentRunAt: Date | null;
  }): Promise<{ urgent: number; imminent: number; delivered: number }> {
    stepQb.getMany.mockResolvedValue([opts.step]);
    notifQb.getMany.mockResolvedValue(opts.sentRows ?? []);
    userRepo.find.mockResolvedValue([makeUser(opts.config)]);

    const urgent = (await urgentService.sendUrgentReminders(NOW15)).sentUrgent;
    const imminent = opts.imminentRunAt
      ? (await imminentService.sendImminentReminders(opts.imminentRunAt))
          .sentImminent
      : 0;
    const prior = (opts.sentRows ?? []).length;
    return { urgent, imminent, delivered: urgent + imminent + prior };
  }

  it('A) 날짜만 마감 → 15시 1통 · 임박 0 (합계 정확히 1 — 손실도 중복도 없음)', async () => {
    const r = await runScenario({
      step: makeDeadlineStep(MIDNIGHT_KST),
      config: null,
      imminentRunAt: NOW15, // 임박 cron 이 돌아도 자정(시간 없음) 스텝은 무시
    });
    expect(r.urgent).toBe(1);
    expect(r.imminent).toBe(0);
    expect(r.delivered).toBe(1);
  });

  it('B) T=18:00 + 임박 ON → 15시 0 · 임박(16:00 슬롯) 1 (합계 1)', async () => {
    const r = await runScenario({
      step: makeDeadlineStep(kstAt('18:00')),
      config: null,
      imminentRunAt: kstAt('16:00'), // T−2h 슬롯 — 윈도우 [18:00,18:15) 에 T 포함
    });
    expect(r.urgent).toBe(0); // 임박 확실 예정 → 15시 제외
    expect(r.imminent).toBe(1); // 임박이 실제로 배달
    expect(r.delivered).toBe(1);
  });

  it('C) T=16:30 + 임박 기발송 → 15시 0 · 임박 재실행 dedup 0 (배달 = 기발송 1뿐)', async () => {
    const r = await runScenario({
      step: makeDeadlineStep(kstAt('16:30')),
      config: null,
      sentRows: [makeSentRow('s1')], // 14:30 슬롯에서 이미 배달됨
      imminentRunAt: kstAt('14:30'), // 재실행해도 refId dedup 으로 중복 없음
    });
    expect(r.urgent).toBe(0);
    expect(r.imminent).toBe(0);
    expect(r.delivered).toBe(1); // 기발송 1건이 유일한 배달
  });

  it('D) ★백업: T=16:30 + 임박 미발송(늦은 입력) → 15시 1통이 구멍을 막음 (합계 1)', async () => {
    const r = await runScenario({
      step: makeDeadlineStep(kstAt('16:30')),
      config: null,
      imminentRunAt: NOW15, // 15:00 슬롯 윈도우 [17:00,17:15) — 16:30 은 이미 지나침
    });
    expect(r.imminent).toBe(0); // 임박은 못 잡는 상황
    expect(r.urgent).toBe(1); // 15시 백업 발송
    expect(r.delivered).toBe(1);
  });

  it('E) T=18:00 + imminentEnabled OFF → 임박 0 · 15시 1 (합계 1)', async () => {
    const r = await runScenario({
      step: makeDeadlineStep(kstAt('18:00')),
      config: { imminentEnabled: false },
      imminentRunAt: kstAt('16:00'),
    });
    expect(r.imminent).toBe(0); // 채널 OFF
    expect(r.urgent).toBe(1); // 제외 조건 a 불충족 → 발송
    expect(r.delivered).toBe(1);
  });

  it('F) T=18:00 + eventToggles.deadline OFF → 임박 0 · 15시 1 (합계 1)', async () => {
    const r = await runScenario({
      step: makeDeadlineStep(kstAt('18:00')),
      config: { eventToggles: { deadline: false } },
      imminentRunAt: kstAt('16:00'),
    });
    expect(r.imminent).toBe(0); // kind 토글 OFF → 임박 안 감
    expect(r.urgent).toBe(1); // 같은 판정(a)으로 15시가 백업
    expect(r.delivered).toBe(1);
  });
});
