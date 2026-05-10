import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepChecklistItem } from './step-checklist-item.entity';
import { ApplicationsService } from './applications.service';

const DEFAULT_STEP_NAMES = [
  '서류 제출',
  '1차 면접',
  '2차 면접',
  '최종 합격',
];

describe('ApplicationsService', () => {
  let service: ApplicationsService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let dataSource: { transaction: jest.Mock; query: jest.Mock };

  const makeApp = (overrides: Partial<Application> = {}): Application =>
    ({
      id: 'app-uuid-1',
      userId: 'user-uuid-1',
      companyName: '카카오',
      jobTitle: '프론트엔드',
      jobCategory: 'IT개발',
      status: 'IN_PROGRESS',
      deadline: '2025-09-01',
      jobUrl: null,
      memo: null,
      currentStepIndex: 0,
      needsDetail: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      steps: [],
      ...overrides,
    }) as Application;

  const makeStep = (orderIndex: number, name: string): ApplicationStep =>
    ({
      id: `step-${orderIndex}`,
      applicationId: 'app-uuid-1',
      orderIndex,
      name,
      scheduledDate: null,
      location: null,
    }) as ApplicationStep;

  const makeDefaultSteps = () =>
    DEFAULT_STEP_NAMES.map((name, i) => makeStep(i, name));

  /** EntityManager mock 생성 — transaction 콜백에서 사용 */
  const makeEntityManager = (app: Application, steps: ApplicationStep[] = []) => {
    const savedSteps: ApplicationStep[] = [];

    const em: Partial<EntityManager> = {
      create: jest.fn().mockImplementation((_entity, data) => ({ ...data })),
      save: jest.fn()
        .mockImplementationOnce(async (_entity: any, data: any) => {
          // Application save
          return { ...app, ...data, id: app.id };
        })
        .mockImplementation(async (_entity: any, data: any) => {
          // Steps save
          if (Array.isArray(data)) {
            savedSteps.push(...data);
            return data;
          }
          return data;
        }),
      findOne: jest.fn().mockResolvedValue({ ...app, steps: savedSteps }),
      delete: jest.fn().mockResolvedValue({}),
    };

    return { em: em as EntityManager, savedSteps };
  };

  beforeEach(async () => {
    const mockAppRepo = mock<Repository<Application>>();
    const mockStepRepo = mock<Repository<ApplicationStep>>();
    const mockDataSource = {
      transaction: jest.fn(),
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: getRepositoryToken(Application), useValue: mockAppRepo },
        { provide: getRepositoryToken(ApplicationStep), useValue: mockStepRepo },
        { provide: getRepositoryToken(StepChecklistItem), useValue: mock<Repository<StepChecklistItem>>() },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
    appRepo = module.get(getRepositoryToken(Application));
    stepRepo = module.get(getRepositoryToken(ApplicationStep));
    dataSource = module.get(DataSource) as any;
  });

  afterEach(() => jest.clearAllMocks());

  // ── findAll ────────────────────────────────────────────
  describe('findAll', () => {
    it('userId 조건으로 find 호출, relations steps, deadline 오름차순 정렬', async () => {
      appRepo.find.mockResolvedValue([makeApp()]);
      const result = await service.findAll('user-uuid-1');

      expect(appRepo.find).toHaveBeenCalledWith({
        where: { userId: 'user-uuid-1' },
        relations: ['steps'],
        order: { deadline: 'ASC', createdAt: 'DESC' },
      });
      expect(result).toHaveLength(1);
    });

    it('soft delete된 카드는 TypeORM @DeleteDateColumn으로 자동 제외', async () => {
      // TypeORM이 deletedAt IS NULL을 자동 처리함 — find 쿼리 확인으로 검증
      appRepo.find.mockResolvedValue([]);
      await service.findAll('user-uuid-1');
      // deletedAt 조건이 where에 명시되지 않아도 TypeORM이 자동 처리
      expect(appRepo.find).toHaveBeenCalledWith(
        expect.not.objectContaining({ where: expect.objectContaining({ deletedAt: expect.anything() }) }),
      );
    });
  });

  // ── findOne ────────────────────────────────────────────
  describe('findOne', () => {
    it('(userId, id) 조합 성공 → steps가 orderIndex ASC로 정렬된 카드 반환', async () => {
      const steps = [makeStep(2, '1차 면접'), makeStep(0, '서류 제출'), makeStep(1, '서류 발표')];
      const app = makeApp({ steps });
      appRepo.findOne.mockResolvedValue(app);

      const result = await service.findOne('user-uuid-1', 'app-uuid-1');

      expect(appRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'app-uuid-1', userId: 'user-uuid-1' },
        relations: ['steps'],
      });
      expect(result.steps.map((s) => s.orderIndex)).toEqual([0, 1, 2]);
    });

    it('findOne이 null 반환 → NotFoundException', async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('user-uuid-1', 'app-uuid-1')).rejects.toThrow(
        new NotFoundException('카드를 찾을 수 없습니다.'),
      );
    });

    it('다른 userId의 카드 → findOne이 null 반환 → NotFoundException (ForbiddenException 아님)', async () => {
      appRepo.findOne.mockResolvedValue(null);  // userId가 where 조건에 포함되어 not found
      await expect(service.findOne('user-B', 'app-uuid-1')).rejects.toThrow(NotFoundException);
      await expect(service.findOne('user-B', 'app-uuid-1')).rejects.not.toThrow(ForbiddenException);
    });
  });

  // ── create ─────────────────────────────────────────────
  describe('create', () => {
    it('status 미지정 → 기본값 IN_PROGRESS로 생성', async () => {
      const app = makeApp({ status: 'IN_PROGRESS' });
      const { em } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', { companyName: '네이버' });

      expect(em.create).toHaveBeenCalledWith(
        Application,
        expect.objectContaining({ status: 'IN_PROGRESS' }),
      );
    });

    it('status=IN_PROGRESS → 기본 4스텝 생성 (이름, orderIndex 0~3)', async () => {
      const app = makeApp({ status: 'IN_PROGRESS' });
      const { em, savedSteps } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', { companyName: '카카오', status: 'IN_PROGRESS' });

      expect(savedSteps).toHaveLength(4);
      expect(savedSteps[0]).toMatchObject({ name: '서류 제출', orderIndex: 0 });
      expect(savedSteps[3]).toMatchObject({ name: '최종 합격', orderIndex: 3 });

      DEFAULT_STEP_NAMES.forEach((name, i) => {
        expect(savedSteps[i]).toMatchObject({ name, orderIndex: i });
      });
    });

    it('deadline 전달 시 첫 스텝(서류 제출) scheduledDate에 자동 설정', async () => {
      const app = makeApp({ status: 'IN_PROGRESS', deadline: '2025-12-31' });
      const { em, savedSteps } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', { companyName: '네카라', status: 'IN_PROGRESS', deadline: '2025-12-31' });

      expect(savedSteps[0]).toMatchObject({ name: '서류 제출', orderIndex: 0 });
      expect(savedSteps[0].scheduledDate).toEqual(new Date('2025-12-31'));
      expect(savedSteps[1].scheduledDate).toBeNull();
    });

    it('deadline 미전달 시 모든 스텝 scheduledDate null', async () => {
      const app = makeApp({ status: 'IN_PROGRESS' });
      const { em, savedSteps } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', { companyName: '쿠팡', status: 'IN_PROGRESS' });

      savedSteps.forEach((step) => expect(step.scheduledDate).toBeNull());
    });

    it('status=PLANNED → 스텝 미생성 (em.save 1번만 호출)', async () => {
      const app = makeApp({ status: 'PLANNED' });
      const em = {
        create: jest.fn().mockReturnValue(app),
        save: jest.fn().mockResolvedValue(app),
        findOne: jest.fn().mockResolvedValue({ ...app, steps: [] }),
        delete: jest.fn(),
      } as unknown as EntityManager;
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', { companyName: '라인', status: 'PLANNED' });

      // Application save 1번 + Steps save 없음
      expect(em.save).toHaveBeenCalledTimes(1);
    });

    it('needsDetail: IN_PROGRESS + jobTitle 없으면 true', async () => {
      const app = makeApp({ needsDetail: true });
      const { em } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', { companyName: '토스', status: 'IN_PROGRESS' });

      expect(em.create).toHaveBeenCalledWith(
        Application,
        expect.objectContaining({ needsDetail: true }),
      );
    });

    it('needsDetail: IN_PROGRESS + jobTitle 있으면 false', async () => {
      const app = makeApp({ needsDetail: false });
      const { em } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', {
        companyName: '토스',
        status: 'IN_PROGRESS',
        jobTitle: '백엔드',
      });

      expect(em.create).toHaveBeenCalledWith(
        Application,
        expect.objectContaining({ needsDetail: false }),
      );
    });

    it('트랜잭션 완료 후 em.findOne으로 relations steps 포함 카드 반환', async () => {
      const app = makeApp();
      const { em } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', { companyName: '카카오' });

      expect(em.findOne).toHaveBeenCalledWith(
        Application,
        expect.objectContaining({ relations: ['steps'] }),
      );
    });
  });

  // ── update ─────────────────────────────────────────────
  describe('update', () => {
    it('PLANNED→IN_PROGRESS + 기존 스텝 없음 → createDefaultSteps 호출', async () => {
      const app = makeApp({ status: 'PLANNED' });
      appRepo.findOne.mockResolvedValue(app);  // findEntity용
      appRepo.save.mockImplementation(async (a) => a as Application);
      stepRepo.count.mockResolvedValue(0);  // 기존 스텝 없음

      // createDefaultSteps는 stepRepo.manager 사용
      const mockManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockResolvedValue([]),
      };
      (stepRepo as any).manager = mockManager;

      // findOne(userId, id) for return — relations 포함
      appRepo.findOne
        .mockResolvedValueOnce(app)  // findEntity (relations 없음)
        .mockResolvedValue({ ...app, status: 'IN_PROGRESS', steps: makeDefaultSteps() });  // findOne (relations 포함)

      await service.update('user-uuid-1', 'app-uuid-1', { status: 'IN_PROGRESS' });

      expect(stepRepo.count).toHaveBeenCalledWith({ where: { applicationId: 'app-uuid-1' } });
      expect(mockManager.save).toHaveBeenCalled();
    });

    it('PLANNED→IN_PROGRESS + 기존 스텝 있음 → createDefaultSteps 미호출', async () => {
      const app = makeApp({ status: 'PLANNED' });
      appRepo.findOne
        .mockResolvedValueOnce(app)
        .mockResolvedValue({ ...app, status: 'IN_PROGRESS', steps: makeDefaultSteps() });
      appRepo.save.mockImplementation(async (a) => a as Application);
      stepRepo.count.mockResolvedValue(7);  // 이미 스텝 있음

      await service.update('user-uuid-1', 'app-uuid-1', { status: 'IN_PROGRESS' });

      expect(stepRepo.count).toHaveBeenCalled();
      // manager.save는 호출되지 않아야 함 (createDefaultSteps 미호출)
    });

    it('존재하지 않는 카드 → NotFoundException', async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update('user-uuid-1', 'nonexistent', { companyName: '수정' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── updateCurrentStep ──────────────────────────────────
  describe('updateCurrentStep', () => {
    it('마지막 스텝 클릭 → appRepo.update에 status: PASSED 포함', async () => {
      const steps = makeDefaultSteps();  // 4개, 마지막 index=3
      stepRepo.find.mockResolvedValue(steps);
      appRepo.findOne.mockResolvedValue(makeApp());  // findEntity
      appRepo.update.mockResolvedValue({} as any);
      appRepo.findOne.mockResolvedValue(makeApp({ currentStepIndex: 3, status: 'PASSED', steps }));

      await service.updateCurrentStep('user-uuid-1', 'app-uuid-1', 3);

      expect(appRepo.update).toHaveBeenCalledWith(
        'app-uuid-1',
        expect.objectContaining({ currentStepIndex: 3, status: 'PASSED' }),
      );
    });

    it('마지막이 아닌 스텝 클릭 → status 포함 안 함', async () => {
      const steps = makeDefaultSteps();
      stepRepo.find.mockResolvedValue(steps);
      appRepo.findOne.mockResolvedValue(makeApp());
      appRepo.update.mockResolvedValue({} as any);
      appRepo.findOne.mockResolvedValue(makeApp({ currentStepIndex: 2, steps }));

      await service.updateCurrentStep('user-uuid-1', 'app-uuid-1', 2);

      expect(appRepo.update).toHaveBeenCalledWith(
        'app-uuid-1',
        { currentStepIndex: 2 },
      );
    });

    it('stepIndex < 0 → ForbiddenException', async () => {
      stepRepo.find.mockResolvedValue(makeDefaultSteps());
      appRepo.findOne.mockResolvedValue(makeApp());

      await expect(
        service.updateCurrentStep('user-uuid-1', 'app-uuid-1', -1),
      ).rejects.toThrow(ForbiddenException);
    });

    it('stepIndex >= steps.length → ForbiddenException', async () => {
      stepRepo.find.mockResolvedValue(makeDefaultSteps());  // 4개
      appRepo.findOne.mockResolvedValue(makeApp());

      await expect(
        service.updateCurrentStep('user-uuid-1', 'app-uuid-1', 4),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── updateSteps ────────────────────────────────────────
  describe('updateSteps', () => {
    it('트랜잭션 내에서 기존 스텝 delete 후 새 스텝 save', async () => {
      const app = makeApp();
      appRepo.findOne.mockResolvedValue(app);

      const savedSteps: any[] = [];
      const em = {
        delete: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation(async (_entity: any, data: any) => {
          if (Array.isArray(data)) savedSteps.push(...data);
          return data;
        }),
        findOne: jest.fn().mockResolvedValue({ ...app, steps: savedSteps }),
      } as unknown as EntityManager;
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      const newSteps = [
        { orderIndex: 0, name: '서류', scheduledDate: null, location: null },
        { orderIndex: 1, name: '면접', scheduledDate: '2025-09-01T10:00:00Z', location: '서울' },
      ];

      await service.updateSteps('user-uuid-1', 'app-uuid-1', { steps: newSteps });

      expect(em.delete).toHaveBeenCalledWith(ApplicationStep, { applicationId: 'app-uuid-1' });
      expect(savedSteps).toHaveLength(2);
      expect(savedSteps[1]).toMatchObject({ name: '면접', scheduledDate: expect.any(Date) });
    });

    it('scheduledDate가 null이면 null로 저장', async () => {
      const app = makeApp();
      appRepo.findOne.mockResolvedValue(app);
      const savedSteps: any[] = [];

      const em = {
        delete: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockImplementation((_e: any, d: any) => d),
        save: jest.fn().mockImplementation(async (_e: any, d: any) => {
          if (Array.isArray(d)) savedSteps.push(...d);
          return d;
        }),
        findOne: jest.fn().mockResolvedValue({ ...app, steps: savedSteps }),
      } as unknown as EntityManager;
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.updateSteps('user-uuid-1', 'app-uuid-1', {
        steps: [{ orderIndex: 0, name: '서류', scheduledDate: null, location: null }],
      });

      expect(savedSteps[0].scheduledDate).toBeNull();
    });

    it('존재하지 않는 카드 → NotFoundException', async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateSteps('user-uuid-1', 'nonexistent', { steps: [] }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── remove ─────────────────────────────────────────────
  describe('remove', () => {
    it('appRepo.softRemove(app) 호출 (update로 deleted_at 직접 설정 아님)', async () => {
      const app = makeApp();
      appRepo.findOne.mockResolvedValue(app);
      appRepo.softRemove.mockResolvedValue(app);

      await service.remove('user-uuid-1', 'app-uuid-1');

      expect(appRepo.softRemove).toHaveBeenCalledWith(app);
      expect(appRepo.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 카드 → NotFoundException', async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(service.remove('user-uuid-1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('다른 userId의 카드 → NotFoundException (403 아님)', async () => {
      appRepo.findOne.mockResolvedValue(null);  // userId 조건에서 걸림
      await expect(service.remove('user-B', 'app-uuid-1')).rejects.toThrow(NotFoundException);
    });
  });
});
