import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { DeadlineUrgentService } from './deadline-urgent.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { ApplicationStep } from '../applications/application-step.entity';
import { Notification } from './notification.entity';
import { User } from '../users/user.entity';
import type { AlarmConfigUpdate } from './notification.types';

const NOW = new Date('2026-07-04T03:00:00Z'); // KST 2026-07-04 12:00
/** 15:00 KST cron 시각 — imminent 제외 규칙 매트릭스용 */
const NOW15 = new Date('2026-07-04T06:00:00Z'); // KST 2026-07-04 15:00
const kstDate = (ymd: string) => new Date(`${ymd}T03:00:00Z`);
/** KST 시각 지정 helper (예 kstAt('18:00') = 2026-07-04 18:00 KST) */
const kstAt = (hhmm: string) => new Date(`2026-07-04T${hhmm}:00+09:00`);
/** KST 자정 정각 = 날짜만 지정된 마감 (시간 없음) */
const MIDNIGHT_KST = new Date('2026-07-04T00:00:00+09:00');

function makeStep(
  app: { userId: string; companyName: string },
  overrides: Partial<ApplicationStep> = {},
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
    application: app,
    ...overrides,
  } as ApplicationStep;
}

function makeUser(id: string, config: AlarmConfigUpdate | null): User {
  return {
    id,
    suspendedAt: null,
    alarmConfig: config as User['alarmConfig'],
    alarmPermissionGranted: true,
  } as User;
}

/** 오늘 이미 발송된 imminent 인앱 알림 행 (공유 dedup 조회 결과 시뮬레이션) */
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
    createdAt: NOW15,
  };
}

describe('DeadlineUrgentService', () => {
  let service: DeadlineUrgentService;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let notificationRepo: jest.Mocked<Repository<Notification>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let dispatch: jest.Mocked<NotificationDispatchService>;
  let stepQb: jest.Mocked<SelectQueryBuilder<ApplicationStep>>;
  let notifQb: jest.Mocked<SelectQueryBuilder<Notification>>;

  beforeEach(async () => {
    stepRepo = mock<Repository<ApplicationStep>>();
    notificationRepo = mock<Repository<Notification>>();
    userRepo = mock<Repository<User>>();
    dispatch = mock<NotificationDispatchService>();

    stepQb = mock<SelectQueryBuilder<ApplicationStep>>();
    ['innerJoin', 'where', 'andWhere', 'select', 'addSelect'].forEach((m) =>
      (stepQb as never as Record<string, jest.Mock>)[m].mockReturnThis(),
    );
    stepQb.getMany.mockResolvedValue([]);
    stepRepo.createQueryBuilder.mockReturnValue(stepQb);

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
        { provide: getRepositoryToken(ApplicationStep), useValue: stepRepo },
        {
          provide: getRepositoryToken(Notification),
          useValue: notificationRepo,
        },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    service = module.get(DeadlineUrgentService);
  });

  it('오늘 마감 0건 → 발송 0', async () => {
    const r = await service.sendUrgentReminders(NOW);
    expect(r.sentUrgent).toBe(0);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('오늘 서류 마감 → deadline_urgent 발송', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ userId: 'u1', companyName: '카카오' }),
    ]);
    userRepo.find.mockResolvedValue([makeUser('u1', null)]);

    const r = await service.sendUrgentReminders(NOW);

    expect(r.sentUrgent).toBe(1);
    expect(dispatch.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'deadline_urgent',
      expect.objectContaining({ deepLink: '/board/app-1' }),
      NOW,
    );
  });

  it('정지 사용자 → skip', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ userId: 'u1', companyName: '카카오' }),
    ]);
    userRepo.find.mockResolvedValue([
      { id: 'u1', suspendedAt: new Date(), alarmConfig: null } as User,
    ]);

    const r = await service.sendUrgentReminders(NOW);
    expect(r.sentUrgent).toBe(0);
  });

  it('deadlineUrgentEnabled=false → skip', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ userId: 'u1', companyName: '카카오' }),
    ]);
    userRepo.find.mockResolvedValue([
      makeUser('u1', { deadlineUrgentEnabled: false }),
    ]);

    await service.sendUrgentReminders(NOW);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('레거시 master=false 저장값 → 채널 강등(deadlineUrgentEnabled false)으로 skip', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ userId: 'u1', companyName: '카카오' }),
    ]);
    userRepo.find.mockResolvedValue([makeUser('u1', { master: false })]);

    await service.sendUrgentReminders(NOW);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('한 사용자 여러 마감 → count 반영 (외 N곳)', async () => {
    stepQb.getMany.mockResolvedValue([
      makeStep({ userId: 'u1', companyName: '카카오' }, { id: 's1' }),
      makeStep(
        { userId: 'u1', companyName: '네이버' },
        { id: 's2', applicationId: 'app-2' },
      ),
    ]);
    userRepo.find.mockResolvedValue([makeUser('u1', null)]);

    await service.sendUrgentReminders(NOW);
    const [, , content] = dispatch.dispatch.mock.calls[0];
    expect(content.body).toContain('외 1곳');
  });

  // ── imminent 이중 발송 해소 — 백업 보장 매트릭스 (2026-07-19 CEO) ──
  describe('imminent 제외 규칙 (15:00 · 침묵 손실 금지)', () => {
    beforeEach(() => {
      userRepo.find.mockResolvedValue([makeUser('u1', null)]);
    });

    it('1) 날짜만 마감(자정 정각) → 15시 발송 (회귀 불변)', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep(
          { userId: 'u1', companyName: '카카오' },
          { scheduledDate: MIDNIGHT_KST },
        ),
      ]);

      const r = await service.sendUrgentReminders(NOW15);
      expect(r.sentUrgent).toBe(1);
    });

    it('2) T=18:00 + 임박 유효 ON → 15시 제외 (T−2h 미래 = 임박 확실 예정)', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep(
          { userId: 'u1', companyName: '카카오' },
          { scheduledDate: kstAt('18:00') },
        ),
      ]);

      const r = await service.sendUrgentReminders(NOW15);
      expect(r.sentUrgent).toBe(0);
      expect(dispatch.dispatch).not.toHaveBeenCalled();
    });

    it('3) T=16:30 + 오늘 임박 이미 발송됨 → 15시 제외 (중복 방지)', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep(
          { userId: 'u1', companyName: '카카오' },
          { scheduledDate: kstAt('16:30') },
        ),
      ]);
      notifQb.getMany.mockResolvedValue([makeSentRow('u1', 's1')]);

      const r = await service.sendUrgentReminders(NOW15);
      expect(r.sentUrgent).toBe(0);
    });

    it('4) ★핵심 백업: T=16:30 + 임박 미발송(늦은 입력 재현) → 15시 발송', async () => {
      // T−2h = 14:30 은 이미 과거 · 발송 기록도 없음 → 임박은 안 옴 → 15시가 백업
      stepQb.getMany.mockResolvedValue([
        makeStep(
          { userId: 'u1', companyName: '카카오' },
          { scheduledDate: kstAt('16:30') },
        ),
      ]);
      notifQb.getMany.mockResolvedValue([]); // 임박 발송 기록 없음

      const r = await service.sendUrgentReminders(NOW15);
      expect(r.sentUrgent).toBe(1);
    });

    it('5) T=18:00 + imminentEnabled OFF → 15시 발송 (임박 안 오므로)', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep(
          { userId: 'u1', companyName: '카카오' },
          { scheduledDate: kstAt('18:00') },
        ),
      ]);
      userRepo.find.mockResolvedValue([
        makeUser('u1', { imminentEnabled: false }),
      ]);

      const r = await service.sendUrgentReminders(NOW15);
      expect(r.sentUrgent).toBe(1);
    });

    it('6) T=18:00 + eventToggles.deadline OFF → 15시 발송 (임박 kind 필터로 안 오므로)', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep(
          { userId: 'u1', companyName: '카카오' },
          { scheduledDate: kstAt('18:00') },
        ),
      ]);
      userRepo.find.mockResolvedValue([
        makeUser('u1', { eventToggles: { deadline: false } }),
      ]);

      const r = await service.sendUrgentReminders(NOW15);
      expect(r.sentUrgent).toBe(1);
    });

    it('혼합: 제외 대상(T=18:00)과 발송 대상(날짜만) 공존 → 발송 대상만 집계', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep(
          { userId: 'u1', companyName: '카카오' },
          { id: 's1', scheduledDate: kstAt('18:00') }, // 제외 (임박 예정)
        ),
        makeStep(
          { userId: 'u1', companyName: '네이버' },
          {
            id: 's2',
            applicationId: 'app-2',
            scheduledDate: MIDNIGHT_KST, // 발송 (날짜만)
          },
        ),
      ]);

      const r = await service.sendUrgentReminders(NOW15);
      expect(r.sentUrgent).toBe(1);
      const [, , content] = dispatch.dispatch.mock.calls[0];
      expect(content.body).toContain('네이버');
      expect(content.body).not.toContain('외'); // 1건만 남음 — 대표 단수 문구
      expect(content.deepLink).toBe('/board/app-2');
      expect(content.eventCount).toBe(1);
    });

    it('전부 제외되면 dispatch 자체가 없음 (빈 발송 방지)', async () => {
      stepQb.getMany.mockResolvedValue([
        makeStep(
          { userId: 'u1', companyName: '카카오' },
          { scheduledDate: kstAt('18:00') },
        ),
        makeStep(
          { userId: 'u1', companyName: '네이버' },
          { id: 's2', applicationId: 'app-2', scheduledDate: kstAt('19:00') },
        ),
      ]);

      const r = await service.sendUrgentReminders(NOW15);
      expect(r.sentUrgent).toBe(0);
      expect(dispatch.dispatch).not.toHaveBeenCalled();
    });
  });
});
