import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { DeadlineUrgentService } from './deadline-urgent.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { ApplicationStep } from '../applications/application-step.entity';
import { User } from '../users/user.entity';
import type { AlarmConfig } from './notification.types';

const NOW = new Date('2026-07-04T03:00:00Z'); // KST 2026-07-04 12:00
const kstDate = (ymd: string) => new Date(`${ymd}T03:00:00Z`);

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

function makeUser(id: string, config: Partial<AlarmConfig> | null): User {
  return {
    id,
    suspendedAt: null,
    alarmConfig: config,
    alarmPermissionGranted: true,
  } as User;
}

describe('DeadlineUrgentService', () => {
  let service: DeadlineUrgentService;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let dispatch: jest.Mocked<NotificationDispatchService>;
  let stepQb: jest.Mocked<SelectQueryBuilder<ApplicationStep>>;

  beforeEach(async () => {
    stepRepo = mock<Repository<ApplicationStep>>();
    userRepo = mock<Repository<User>>();
    dispatch = mock<NotificationDispatchService>();

    stepQb = mock<SelectQueryBuilder<ApplicationStep>>();
    ['innerJoin', 'where', 'andWhere', 'select', 'addSelect'].forEach((m) =>
      (stepQb as never as Record<string, jest.Mock>)[m].mockReturnThis(),
    );
    stepQb.getMany.mockResolvedValue([]);
    stepRepo.createQueryBuilder.mockReturnValue(stepQb);
    dispatch.dispatch.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeadlineUrgentService,
        { provide: getRepositoryToken(ApplicationStep), useValue: stepRepo },
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

  it('master=false → skip', async () => {
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
});
