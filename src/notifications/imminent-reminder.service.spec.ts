import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { ImminentReminderService } from './imminent-reminder.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { ApplicationStep } from '../applications/application-step.entity';
import { DailyNote } from '../calendar/daily-note.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { Notification } from './notification.entity';
import { User } from '../users/user.entity';
import type { AlarmConfigUpdate } from './notification.types';

// NOW = 2026-07-04 12:00 KST (03:00Z). 윈도우 = 이벤트시각 ∈ [14:00, 14:15) KST
const NOW = new Date('2026-07-04T03:00:00Z');
/** NOW 로부터 minutes 뒤의 시각 */
const after = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function makeStep(
  overrides: Omit<Partial<ApplicationStep>, 'application'> & {
    application?: { userId: string; companyName: string };
  } = {},
): ApplicationStep {
  return {
    id: 's1',
    applicationId: 'app-1',
    orderIndex: 1,
    name: '1차 면접',
    scheduledDate: after(120), // 정확히 2시간 뒤 = 윈도우 시작 경계
    location: null,
    notes: null,
    pinnedContent: null,
    application: { userId: 'u1', companyName: '카카오' },
    ...overrides,
  } as ApplicationStep;
}

function makeExam(overrides: Partial<ExamSchedule> = {}): ExamSchedule {
  return {
    id: 'e1',
    user_id: 'u1',
    name: 'TOEIC',
    exam_date: after(120),
    location: null,
    ...overrides,
  } as ExamSchedule;
}

/** 오늘 이미 발송된 imminent 인앱 알림 행 (dedup 조회 결과 시뮬레이션) */
function makeSentRow(userId: string, refId: string): Notification {
  return {
    id: `sent-${refId}`,
    userId,
    type: 'imminent',
    title: '⏰ 2시간 뒤',
    body: 'x',
    deepLink: null,
    payload: { refId },
    read: false,
    createdAt: NOW,
  };
}

function makeUser(id: string, config: AlarmConfigUpdate | null): User {
  return {
    id,
    suspendedAt: null,
    alarmConfig: config as User['alarmConfig'],
    alarmPermissionGranted: true,
  } as User;
}

/** payload 를 구조화 이벤트 형태로 좁혀 읽기 (strict 널 체크 통과용) */
function payloadOf(content: { payload?: Record<string, unknown> | null }): {
  eventCount?: number;
  events?: Array<{
    subject: string;
    label: string;
    dday: number;
    deepLink: string | null;
  }>;
  refId?: string;
  kind?: string;
} {
  expect(content.payload).toBeDefined();
  return content.payload as never;
}

describe('ImminentReminderService — ② 2시간 전 리마인드', () => {
  let service: ImminentReminderService;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let examRepo: jest.Mocked<Repository<ExamSchedule>>;
  let notificationRepo: jest.Mocked<Repository<Notification>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let noteRepo: jest.Mocked<Repository<DailyNote>>;
  let dispatch: jest.Mocked<NotificationDispatchService>;
  let stepQb: jest.Mocked<SelectQueryBuilder<ApplicationStep>>;
  let examQb: jest.Mocked<SelectQueryBuilder<ExamSchedule>>;
  let notifQb: jest.Mocked<SelectQueryBuilder<Notification>>;

  beforeEach(async () => {
    stepRepo = mock<Repository<ApplicationStep>>();
    examRepo = mock<Repository<ExamSchedule>>();
    notificationRepo = mock<Repository<Notification>>();
    userRepo = mock<Repository<User>>();
    noteRepo = mock<Repository<DailyNote>>();
    noteRepo.find.mockResolvedValue([]);
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

    userRepo.find.mockResolvedValue([makeUser('u1', null)]);
    dispatch.dispatch.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImminentReminderService,
        { provide: getRepositoryToken(ApplicationStep), useValue: stepRepo },
        { provide: getRepositoryToken(ExamSchedule), useValue: examRepo },
        {
          provide: getRepositoryToken(Notification),
          useValue: notificationRepo,
        },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(DailyNote), useValue: noteRepo },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    service = module.get(ImminentReminderService);
  });

  it('후보 0건 → 발송 0 · dispatch 없음 (침묵)', async () => {
    const r = await service.sendImminentReminders(NOW);
    expect(r.sentImminent).toBe(0);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  // ── 윈도우 경계 (이벤트시각−2h ∈ [now, now+15m)) ─────────────────
  describe('윈도우 경계', () => {
    it('정확히 2시간 뒤 (경계 시작) → 발송', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep({ scheduledDate: after(120) }),
      ]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(1);
    });

    it('2시간 14분 뒤 (윈도우 안) → 발송', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep({ scheduledDate: after(134) }),
      ]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(1);
    });

    it('1시간 45분 뒤 (윈도우 이전에 지났음) → 미발송', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep({ scheduledDate: after(105) }),
      ]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(0);
      expect(dispatch.dispatch).not.toHaveBeenCalled();
    });

    it('2시간 15분 뒤 (half-open 상한 = 다음 슬롯 몫) → 미발송', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep({ scheduledDate: after(135) }),
      ]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(0);
    });

    it('과거 윈도우 (1시간 뒤 = 서버 재시작으로 슬롯 놓친 경우) → 미발송 (지연 폭주 방지)', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep({ scheduledDate: after(60) }),
      ]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(0);
      expect(dispatch.dispatch).not.toHaveBeenCalled();
    });
  });

  it('시간 없는 스텝 (KST 자정 정각 = 날짜만) → 제외', async () => {
    // NOW2 = KST 21:55 → 윈도우 [23:55, 다음날 00:10) 이 자정을 걸침
    const NOW2 = new Date('2026-07-03T12:55:00Z'); // KST 2026-07-03 21:55
    const midnightKst = new Date('2026-07-03T15:00:00Z'); // KST 2026-07-04 00:00:00
    stepQb.getMany.mockResolvedValue([
      makeStep({ scheduledDate: midnightKst }),
    ]);

    const r = await service.sendImminentReminders(NOW2);
    expect(r.sentImminent).toBe(0);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  // ── dedup (user, imminent, refId, 날짜) ──────────────────────────
  describe('dedup', () => {
    it('오늘 같은 refId 이미 발송 → skip (재실행 1회 보장)', async () => {
      stepQb.getMany.mockResolvedValue([makeStep({})]);
      notifQb.getMany.mockResolvedValue([makeSentRow('u1', 's1')]);

      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(0);
      expect(dispatch.dispatch).not.toHaveBeenCalled();
    });

    it('다른 refId 발송 이력은 무관 → 발송', async () => {
      stepQb.getMany.mockResolvedValue([makeStep({})]);
      notifQb.getMany.mockResolvedValue([makeSentRow('u1', 'other-step')]);

      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(1);
    });

    it('타 유저의 같은 refId 이력은 무관 → 발송 (본인 것만 dedup)', async () => {
      stepQb.getMany.mockResolvedValue([makeStep({})]);
      notifQb.getMany.mockResolvedValue([makeSentRow('u2', 's1')]);

      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(1);
    });
  });

  // ── 대상 필터 ────────────────────────────────────────────────────
  it('PASSED/FAILED·삭제 카드 제외 — 쿼리 predicate 확인', async () => {
    await service.sendImminentReminders(NOW);
    expect(stepQb.where).toHaveBeenCalledWith('app.deleted_at IS NULL');
    expect(stepQb.andWhere).toHaveBeenCalledWith(
      "app.status NOT IN ('PASSED','FAILED')",
    );
  });

  it('정지 사용자 → skip', async () => {
    stepQb.getMany.mockResolvedValue([makeStep({})]);
    userRepo.find.mockResolvedValue([
      { ...makeUser('u1', null), suspendedAt: new Date() },
    ]);

    const r = await service.sendImminentReminders(NOW);
    expect(r.sentImminent).toBe(0);
  });

  it('imminentEnabled OFF (채널 토글) → skip', async () => {
    stepQb.getMany.mockResolvedValue([makeStep({})]);
    userRepo.find.mockResolvedValue([
      makeUser('u1', { imminentEnabled: false }),
    ]);

    const r = await service.sendImminentReminders(NOW);
    expect(r.sentImminent).toBe(0);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('레거시 master=false 저장값 → 채널 강등(imminentEnabled false)으로 skip', async () => {
    stepQb.getMany.mockResolvedValue([makeStep({})]);
    userRepo.find.mockResolvedValue([makeUser('u1', { master: false })]);

    const r = await service.sendImminentReminders(NOW);
    expect(r.sentImminent).toBe(0);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('eventToggles.interview OFF → 면접 스텝 skip · 시험은 발송 (유형 토글 존중)', async () => {
    stepQb.getMany.mockResolvedValue([makeStep({})]); // interview
    examQb.getMany.mockResolvedValue([makeExam()]);
    userRepo.find.mockResolvedValue([
      makeUser('u1', { eventToggles: { interview: false } }),
    ]);

    const r = await service.sendImminentReminders(NOW);

    expect(r.sentImminent).toBe(1);
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1);
    const [, type, content] = dispatch.dispatch.mock.calls[0];
    expect(type).toBe('imminent');
    expect(content.body).toContain('TOEIC');
  });

  // ── 발송 내용 ────────────────────────────────────────────────────
  it("스텝 → type 'imminent' · '⏰ 2시간 뒤' + 회사·스텝명·HH:MM·장소 · deepLink board", async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ scheduledDate: after(120), location: '판교' }),
    ]);

    await service.sendImminentReminders(NOW);

    expect(dispatch.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'imminent',
      expect.objectContaining({
        title: '⏰ 2시간 뒤',
        // NOW = KST 12:00 · 이벤트 = 2h 뒤 = KST 14:00
        body: '카카오 1차 면접 14:00 (판교)',
        deepLink: '/board/app-1',
        payload: expect.objectContaining({ refId: 's1', kind: 'interview' }),
      }),
      NOW,
    );
  });

  it("시험 → 시험명·HH:MM · deepLink /calendar · payload kind 'exam'", async () => {
    examQb.getMany.mockResolvedValue([
      makeExam({ exam_date: after(130) }), // KST 14:10
    ]);

    await service.sendImminentReminders(NOW);

    const [, , content] = dispatch.dispatch.mock.calls[0];
    expect(content.body).toBe('TOEIC 14:10');
    expect(content.deepLink).toBe('/calendar');
    // dedup 키(refId·kind)는 그대로 — 이 값이 바뀌면 중복 방지가 깨진다
    expect(payloadOf(content)).toMatchObject({ refId: 'e1', kind: 'exam' });
    // 인앱 구조화 — 단건이라 events 길이 1
    expect(payloadOf(content).events).toHaveLength(1);
    expect(payloadOf(content).events?.[0].deepLink).toBe('/calendar');
  });

  it('한 사용자 다건 이벤트 → 각각 개별 dispatch (하루 다건 허용)', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ id: 's1' }),
      makeStep({
        id: 's2',
        applicationId: 'app-2',
        name: '2차 면접',
        scheduledDate: after(130),
        application: { userId: 'u1', companyName: '네이버' },
      }),
    ]);

    const r = await service.sendImminentReminders(NOW);
    expect(r.sentImminent).toBe(2);
    expect(dispatch.dispatch).toHaveBeenCalledTimes(2);
  });

  it('dispatch false (하드캡 드롭·경합) → sent 미집계', async () => {
    stepQb.getMany.mockResolvedValue([makeStep({})]);
    dispatch.dispatch.mockResolvedValue(false);

    const r = await service.sendImminentReminders(NOW);
    expect(r.sentImminent).toBe(0);
  });
  /**
   * ── 시각 있는 캘린더 메모 (2026-08-29 · 대장 21 정정 12) ──────────────
   *
   * 🔴 **지금까지 어떤 임박 알림도 못 받던 갈래**다. 사용자가 「14:00 스터디」를 적어
   * 둬도 당일 아침 브리핑에 한 줄 뜨는 게 전부였다. 공고 카드가 발표·검진일을 여기에
   * 넣기 시작하면서 「캘린더에 넣었어요」가 실제 알림으로 이어져야 해서 붙였고,
   * 손으로 적은 메모도 같이 혜택을 본다.
   *
   * NOW = 2026-07-04 12:00 KST · 윈도우 = 이벤트시각 ∈ [14:00, 14:15) KST
   */
  describe('캘린더 메모 갈래', () => {
    const makeNote = (over: Partial<DailyNote> = {}): DailyNote => ({
      id: 'n1',
      userId: 'u1',
      date: '2026-07-04',
      hourSlot: 16, // (14-6)*2 = 16 → 14:00 KST = 정확히 2시간 뒤
      content: '무신사 · 서류 합격 발표',
      isDone: false,
      createdAt: NOW,
      ...over,
    });

    it('2시간 전 창에 든 메모를 발송한다 — 내용이 그대로 문구가 된다', async () => {
      noteRepo.find.mockResolvedValue([makeNote()]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(1);
      const [, , content] = dispatch.dispatch.mock.calls[0];
      expect(content.title).toBe('⏰ 2시간 뒤');
      expect(content.body).toBe('무신사 · 서류 합격 발표 14:00');
      expect(content.deepLink).toBe('/calendar');
    });

    it('🔴 dedup 키에 접두어를 붙인다 — 스텝 id 와 섞이면 남의 알림을 삼킨다', async () => {
      noteRepo.find.mockResolvedValue([makeNote()]);
      await service.sendImminentReminders(NOW);
      expect(payloadOf(dispatch.dispatch.mock.calls[0][2]).refId).toBe(
        'note:n1',
      );
    });

    it('같은 메모로 오늘 이미 보냈으면 다시 안 보낸다', async () => {
      noteRepo.find.mockResolvedValue([makeNote()]);
      notifQb.getMany.mockResolvedValue([makeSentRow('u1', 'note:n1')]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(0);
    });

    it('시각 없는 메모(hour_slot NULL)는 애초에 쿼리에서 빠진다', async () => {
      await service.sendImminentReminders(NOW);
      const where = noteRepo.find.mock.calls[0][0]?.where;
      expect(where).toMatchObject({ isDone: false });
      expect(JSON.stringify(where)).toContain('hourSlot');
    });

    it('완료한 메모는 안 보낸다 (쿼리 조건)', async () => {
      await service.sendImminentReminders(NOW);
      expect(noteRepo.find.mock.calls[0][0]?.where).toMatchObject({
        isDone: false,
      });
    });

    it('창 밖 메모는 걸러진다 (2시간 15분 뒤 = 다음 슬롯 몫)', async () => {
      // 14:30 KST = NOW+150분 → lead 가 창(0~15분) 밖
      noteRepo.find.mockResolvedValue([makeNote({ hourSlot: 17 })]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(0);
    });

    it('🔴 자정(슬롯 −12) 메모도 보낸다 — 스텝의 「자정 = 날짜만」 관례를 여기 적용하지 않는다', async () => {
      // 2026-07-05 00:00 KST = NOW+12시간 → 창 밖이지만, **걸러지는 이유가 시각 판정이
      // 아니라 창 판정**임을 확인한다. 창 안으로 옮기면 발송된다.
      noteRepo.find.mockResolvedValue([
        makeNote({ date: '2026-07-04', hourSlot: 16 }),
        makeNote({ id: 'n2', date: '2026-07-05', hourSlot: -12 }),
      ]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(1);
      expect(payloadOf(dispatch.dispatch.mock.calls[0][2]).refId).toBe(
        'note:n1',
      );
    });

    it('임박 채널을 끄면 메모도 안 간다', async () => {
      noteRepo.find.mockResolvedValue([makeNote()]);
      userRepo.find.mockResolvedValue([
        makeUser('u1', { imminentEnabled: false }),
      ]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(0);
    });

    it('🔴 유형 토글(할 일)을 껐다고 메모 임박이 막히지는 않는다 — 사용자가 하지 않은 말이다', async () => {
      noteRepo.find.mockResolvedValue([makeNote()]);
      userRepo.find.mockResolvedValue([
        makeUser('u1', { eventToggles: { todo: false } }),
      ]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(1);
    });

    it('창이 자정을 가로지르면 두 날짜를 조회한다 (KST 달력 날짜 기준)', async () => {
      // 21:50 KST → 창 = [23:50, 00:05) → 7/4 와 7/5 둘 다 필요
      const nearMidnight = new Date('2026-07-04T12:50:00Z'); // 21:50 KST
      await service.sendImminentReminders(nearMidnight);
      const where = noteRepo.find.mock.calls[0][0]?.where;
      expect(JSON.stringify(where)).toContain('2026-07-04');
      expect(JSON.stringify(where)).toContain('2026-07-05');
    });

    it('스텝·시험과 함께 있어도 각각 발송된다 (기존 갈래 회귀)', async () => {
      stepQb.getMany.mockResolvedValue([makeStep({})]);
      examQb.getMany.mockResolvedValue([makeExam()]);
      noteRepo.find.mockResolvedValue([makeNote()]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(3);
    });

    it('본인 메모만 자기 알림으로 간다', async () => {
      noteRepo.find.mockResolvedValue([
        makeNote({ id: 'n1', userId: 'u1' }),
        makeNote({ id: 'n2', userId: 'u2' }),
      ]);
      userRepo.find.mockResolvedValue([makeUser('u1', null)]);
      const r = await service.sendImminentReminders(NOW);
      expect(r.sentImminent).toBe(1);
      expect(dispatch.dispatch.mock.calls[0][0].id).toBe('u1');
    });
  });
});
