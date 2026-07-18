import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { BriefingService } from './briefing.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { DailyNote } from '../calendar/daily-note.entity';
import { User } from '../users/user.entity';
import type { AlarmConfig } from './notification.types';

// NOW = 2026-07-04 12:00 KST → todayKst '2026-07-04'
const NOW = new Date('2026-07-04T03:00:00Z');
// KST 날짜 헬퍼 — 해당 KST 날짜 정오(UTC 03:00)
const kstDate = (ymd: string) => new Date(`${ymd}T03:00:00Z`);

function makeStep(
  overrides: Omit<Partial<ApplicationStep>, 'application'> & {
    application?: { userId: string; companyName: string };
  },
): ApplicationStep {
  return {
    id: 's1',
    applicationId: 'app-1',
    orderIndex: 0,
    name: '서류 제출',
    scheduledDate: kstDate('2026-07-04'),
    location: null,
    notes: null,
    pinnedContent: null,
    application: { userId: 'u1', companyName: '카카오' },
    ...overrides,
  } as ApplicationStep;
}

function makeUser(
  id: string,
  config: Partial<AlarmConfig> | null,
  overrides: Partial<User> = {},
): User {
  return {
    id,
    suspendedAt: null,
    alarmConfig: config,
    alarmPermissionGranted: true,
    ...overrides,
  } as User;
}

function makeNote(overrides: Partial<DailyNote> = {}): DailyNote {
  return {
    id: 'note-1',
    userId: 'u1',
    date: '2026-07-04',
    hourSlot: null,
    content: '이력서 마무리',
    isDone: false,
    createdAt: kstDate('2026-07-04'),
    ...overrides,
  };
}

describe('BriefingService — 잘못된 알람 방지 필터', () => {
  let service: BriefingService;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let examRepo: jest.Mocked<Repository<ExamSchedule>>;
  let noteRepo: jest.Mocked<Repository<DailyNote>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let dispatch: jest.Mocked<NotificationDispatchService>;
  let stepQb: jest.Mocked<SelectQueryBuilder<ApplicationStep>>;
  let examQb: jest.Mocked<SelectQueryBuilder<ExamSchedule>>;
  let noteQb: jest.Mocked<SelectQueryBuilder<DailyNote>>;

  beforeEach(async () => {
    stepRepo = mock<Repository<ApplicationStep>>();
    examRepo = mock<Repository<ExamSchedule>>();
    noteRepo = mock<Repository<DailyNote>>();
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

    noteQb = mock<SelectQueryBuilder<DailyNote>>();
    ['where', 'andWhere', 'orderBy', 'addOrderBy'].forEach((m) =>
      (noteQb as never as Record<string, jest.Mock>)[m].mockReturnThis(),
    );
    noteQb.getMany.mockResolvedValue([]);
    noteRepo.createQueryBuilder.mockReturnValue(noteQb);

    dispatch.dispatch.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BriefingService,
        { provide: getRepositoryToken(ApplicationStep), useValue: stepRepo },
        { provide: getRepositoryToken(ExamSchedule), useValue: examRepo },
        { provide: getRepositoryToken(DailyNote), useValue: noteRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    service = module.get(BriefingService);
  });

  it('이벤트 0건 → 발송 0 · dispatch 없음 (침묵)', async () => {
    const r = await service.sendDailyBriefings(NOW);
    expect(r.sentBriefings).toBe(0);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('D-0 서류 마감 → briefing 발송', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ scheduledDate: kstDate('2026-07-04') }),
    ]);
    userRepo.find.mockResolvedValue([makeUser('u1', null)]);

    const r = await service.sendDailyBriefings(NOW);

    expect(r.sentBriefings).toBe(1);
    expect(dispatch.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'briefing',
      expect.objectContaining({ deepLink: '/board/app-1' }),
      NOW,
    );
  });

  it('정지 사용자 → skip', async () => {
    stepQb.getMany.mockResolvedValue([makeStep({})]);
    userRepo.find.mockResolvedValue([
      makeUser('u1', null, { suspendedAt: new Date() }),
    ]);

    const r = await service.sendDailyBriefings(NOW);
    expect(r.sentBriefings).toBe(0);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('master=false → skip', async () => {
    stepQb.getMany.mockResolvedValue([makeStep({})]);
    userRepo.find.mockResolvedValue([makeUser('u1', { master: false })]);

    const r = await service.sendDailyBriefings(NOW);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
    expect(r.sentBriefings).toBe(0);
  });

  it('briefingEnabled=false → skip', async () => {
    stepQb.getMany.mockResolvedValue([makeStep({})]);
    userRepo.find.mockResolvedValue([
      makeUser('u1', { briefingEnabled: false }),
    ]);

    await service.sendDailyBriefings(NOW);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('deadlinePoints=d1 + D-3 이벤트 → 필터 제외 (d1은 [0,1]만)', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ scheduledDate: kstDate('2026-07-07') }), // D-3
    ]);
    userRepo.find.mockResolvedValue([makeUser('u1', { deadlinePoints: 'd1' })]);

    await service.sendDailyBriefings(NOW);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('deadlinePoints=d3 + D-3 이벤트 → 포함 발송', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ scheduledDate: kstDate('2026-07-07') }),
    ]);
    userRepo.find.mockResolvedValue([makeUser('u1', { deadlinePoints: 'd3' })]);

    const r = await service.sendDailyBriefings(NOW);
    expect(r.sentBriefings).toBe(1);
  });

  it('면접 스텝 (orderIndex>0) → 라벨에 스텝명 · deepLink board', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({
        orderIndex: 1,
        name: '1차 면접',
        scheduledDate: kstDate('2026-07-05'), // D-1
      }),
    ]);
    userRepo.find.mockResolvedValue([makeUser('u1', null)]);

    await service.sendDailyBriefings(NOW);
    const [, , content] = dispatch.dispatch.mock.calls[0];
    expect(content.body).toContain('1차 면접');
  });

  it('시험 일정 → 포함 (deepLink /calendar)', async () => {
    examQb.getMany.mockResolvedValue([
      {
        id: 'e1',
        user_id: 'u1',
        name: 'TOEIC',
        exam_date: kstDate('2026-07-04'),
      } as ExamSchedule,
    ]);
    userRepo.find.mockResolvedValue([makeUser('u1', null)]);

    const r = await service.sendDailyBriefings(NOW);
    expect(r.sentBriefings).toBe(1);
    const [, , content] = dispatch.dispatch.mock.calls[0];
    expect(content.body).toContain('TOEIC');
  });

  it('한 사용자 다건 이벤트 → 묶어서 1 dispatch (eventCount)', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ id: 's1', scheduledDate: kstDate('2026-07-04') }),
      makeStep({
        id: 's2',
        applicationId: 'app-2',
        orderIndex: 1,
        name: '면접',
        scheduledDate: kstDate('2026-07-05'),
        application: { userId: 'u1', companyName: '네이버' },
      }),
    ]);
    userRepo.find.mockResolvedValue([makeUser('u1', null)]);

    await service.sendDailyBriefings(NOW);
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1);
    const [, , content] = dispatch.dispatch.mock.calls[0];
    expect(content.payload).toEqual({ eventCount: 2 });
  });

  // ── F4 — 오늘 할 일 합류 ──────────────────────────────────────────
  describe('F4 — 오늘 할 일 합류', () => {
    it('이벤트 + 오늘 미완료 할 일 2건 → 본문에 "오늘 할 일 2개" 합류', async () => {
      stepQb.getMany.mockResolvedValue([makeStep({})]);
      userRepo.find.mockResolvedValue([makeUser('u1', null)]);
      noteQb.getMany.mockResolvedValue([
        makeNote({ id: 'n1', content: '이력서 마무리' }),
        makeNote({ id: 'n2', content: '포트폴리오 정리' }),
      ]);

      const r = await service.sendDailyBriefings(NOW);

      expect(r.sentBriefings).toBe(1);
      const [, , content] = dispatch.dispatch.mock.calls[0];
      expect(content.body).toContain('오늘 할 일 2개');
      expect(content.body).toContain('이력서 마무리');
      expect(content.body).toContain('포트폴리오 정리');
      // eventCount(마스킹 요약)는 이벤트만 카운트 — 할 일 미포함
      expect(content.payload).toEqual({ eventCount: 1 });
    });

    it('미완료 4건 → 3건 cap ("오늘 할 일 3개", 4번째 미노출)', async () => {
      stepQb.getMany.mockResolvedValue([makeStep({})]);
      userRepo.find.mockResolvedValue([makeUser('u1', null)]);
      noteQb.getMany.mockResolvedValue([
        makeNote({ id: 'n1', content: '할일-1' }),
        makeNote({ id: 'n2', content: '할일-2' }),
        makeNote({ id: 'n3', content: '할일-3' }),
        makeNote({ id: 'n4', content: '할일-4' }),
      ]);

      await service.sendDailyBriefings(NOW);

      const [, , content] = dispatch.dispatch.mock.calls[0];
      expect(content.body).toContain('오늘 할 일 3개');
      expect(content.body).toContain('할일-3');
      expect(content.body).not.toContain('할일-4');
    });

    it('할 일 0건 → 본문에 할 일 미포함 (기존 동작 무변)', async () => {
      stepQb.getMany.mockResolvedValue([makeStep({})]);
      userRepo.find.mockResolvedValue([makeUser('u1', null)]);
      noteQb.getMany.mockResolvedValue([]); // 완료만 있는 날 = is_done=false 필터로 0건

      const r = await service.sendDailyBriefings(NOW);

      expect(r.sentBriefings).toBe(1);
      const [, , content] = dispatch.dispatch.mock.calls[0];
      expect(content.body).not.toContain('오늘 할 일');
    });

    it('이벤트 0 + 할 일만 → 침묵 (dispatch 없음 · 할 일 조회조차 안 함)', async () => {
      // steps·exams 없음 → eventsByUser 비어 조기 반환. 할 일이 있어도 발송 안 함.
      noteQb.getMany.mockResolvedValue([makeNote({ content: '할 일만 있음' })]);

      const r = await service.sendDailyBriefings(NOW);

      expect(r.sentBriefings).toBe(0);
      expect(dispatch.dispatch).not.toHaveBeenCalled();
      // 조기 반환으로 daily_notes 쿼리 자체가 실행되지 않음 (불필요 쿼리 방지)
      expect(noteRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('briefingEnabled=false → 할 일 있어도 미발송 (설정 off 회귀)', async () => {
      stepQb.getMany.mockResolvedValue([makeStep({})]);
      userRepo.find.mockResolvedValue([
        makeUser('u1', { briefingEnabled: false }),
      ]);
      noteQb.getMany.mockResolvedValue([makeNote({ content: '할일' })]);

      await service.sendDailyBriefings(NOW);
      expect(dispatch.dispatch).not.toHaveBeenCalled();
    });
  });
});
