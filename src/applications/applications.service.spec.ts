import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DiscordNotifier } from '../common/discord-notifier';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { LlmService } from '../ai/llm.service';
import { CompaniesService } from '../companies/companies.service';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepChecklistItem } from './step-checklist-item.entity';
import { ApplicationsService } from './applications.service';

const DEFAULT_STEP_NAMES = ['서류 제출', '1차 면접', '2차 면접', '최종 합격'];

describe('ApplicationsService', () => {
  let service: ApplicationsService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let checklistRepo: jest.Mocked<Repository<StepChecklistItem>>;
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
  const makeEntityManager = (app: Application) => {
    const savedSteps: ApplicationStep[] = [];

    const em: Partial<EntityManager> = {
      create: jest.fn().mockImplementation((_entity, data) => ({ ...data })),
      save: jest
        .fn()
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

  const mockDiscord = { notify: jest.fn().mockResolvedValue('sent') };
  let mockLlmService: { auditCacheHitCharge: jest.Mock };
  let mockAppRepo: jest.Mocked<Repository<Application>>;

  beforeEach(async () => {
    mockDiscord.notify.mockClear();
    mockAppRepo = mock<Repository<Application>>();
    const mockStepRepo = mock<Repository<ApplicationStep>>();
    const mockDataSource = {
      transaction: jest.fn(),
      query: jest.fn(),
    };

    // PR_B1c — CoinService + CompanyResearchService mock
    // cost hardening 🟡7 — cache-hit audit mock
    mockLlmService = {
      auditCacheHitCharge: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: DiscordNotifier, useValue: mockDiscord },
        ApplicationsService,
        { provide: getRepositoryToken(Application), useValue: mockAppRepo },
        {
          provide: getRepositoryToken(ApplicationStep),
          useValue: mockStepRepo,
        },
        {
          provide: getRepositoryToken(StepChecklistItem),
          useValue: mock<Repository<StepChecklistItem>>(),
        },
        // checklistRepo는 module.get로 따로 받지 않고 위 inline mock 그대로 사용
        { provide: DataSource, useValue: mockDataSource },
        { provide: LlmService, useValue: mockLlmService },
        // W2 — CompaniesService.getDomainByName (응답 inject). spec 은 undefined 반환 mock
        {
          provide: CompaniesService,
          useValue: { getDomainByName: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
    appRepo = module.get(getRepositoryToken(Application));
    stepRepo = module.get(getRepositoryToken(ApplicationStep));
    checklistRepo = module.get(getRepositoryToken(StepChecklistItem));
    dataSource = module.get(DataSource);
  });

  afterEach(() => jest.clearAllMocks());

  // ── findAll ────────────────────────────────────────────
  describe('findAll', () => {
    it('userId 조건으로 find 호출, relations steps, createdAt 내림차순 정렬', async () => {
      appRepo.find.mockResolvedValue([makeApp()]);
      const result = await service.findAll('user-uuid-1');

      expect(appRepo.find).toHaveBeenCalledWith({
        where: { userId: 'user-uuid-1' },
        relations: ['steps'],
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(1);
    });

    it('soft delete된 카드는 TypeORM @DeleteDateColumn으로 자동 제외', async () => {
      // TypeORM이 deletedAt IS NULL을 자동 처리함 — find 쿼리 확인으로 검증
      appRepo.find.mockResolvedValue([]);
      await service.findAll('user-uuid-1');
      // deletedAt 조건이 where에 명시되지 않아도 TypeORM이 자동 처리
      expect(appRepo.find).toHaveBeenCalledWith(
        expect.not.objectContaining({
          where: expect.objectContaining({ deletedAt: expect.anything() }),
        }),
      );
    });
  });

  // ── findOne ────────────────────────────────────────────
  describe('findOne', () => {
    it('(userId, id) 조합 성공 → steps가 orderIndex ASC로 정렬된 카드 반환', async () => {
      const steps = [
        makeStep(2, '1차 면접'),
        makeStep(0, '서류 제출'),
        makeStep(1, '서류 발표'),
      ];
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
      await expect(
        service.findOne('user-uuid-1', 'app-uuid-1'),
      ).rejects.toThrow(new NotFoundException('카드를 찾을 수 없습니다.'));
    });

    it('다른 userId의 카드 → findOne이 null 반환 → NotFoundException (ForbiddenException 아님)', async () => {
      appRepo.findOne.mockResolvedValue(null); // userId가 where 조건에 포함되어 not found
      await expect(service.findOne('user-B', 'app-uuid-1')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne('user-B', 'app-uuid-1')).rejects.not.toThrow(
        ForbiddenException,
      );
    });

    // jobposting-parse — 파싱 lock stale(2분) 읽기 판정
    it("jobPostingStatus='parsing' + started_at 2분 이내 → 그대로 'parsing' 노출", async () => {
      appRepo.findOne.mockResolvedValue(
        makeApp({
          jobPostingStatus: 'parsing',
          jobPostingStartedAt: new Date(Date.now() - 10 * 1000), // 10초 전
        }),
      );
      const result = await service.findOne('user-uuid-1', 'app-uuid-1');
      expect(result.jobPostingStatus).toBe('parsing');
    });

    it("jobPostingStatus='parsing' + started_at 2분 초과(stale) → null 노출 (DB 미변경)", async () => {
      appRepo.findOne.mockResolvedValue(
        makeApp({
          jobPostingStatus: 'parsing',
          jobPostingStartedAt: new Date(Date.now() - 5 * 60 * 1000), // 5분 전
        }),
      );
      const result = await service.findOne('user-uuid-1', 'app-uuid-1');
      expect(result.jobPostingStatus).toBeNull();
      // 응답만 보정, DB 회수 UPDATE 는 다음 parse 의 atomic 이 담당 (여기선 update 미호출)
      expect(appRepo.update).not.toHaveBeenCalled();
    });

    it("jobPostingStatus='parsing' + started_at null(방어) → stale 간주 null", async () => {
      appRepo.findOne.mockResolvedValue(
        makeApp({ jobPostingStatus: 'parsing', jobPostingStartedAt: null }),
      );
      const result = await service.findOne('user-uuid-1', 'app-uuid-1');
      expect(result.jobPostingStatus).toBeNull();
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

    // aha moment — 첫 실 카드 growth 알림 (샘플 제외)
    describe('aha moment 알림', () => {
      it('실 카드 count=1 → growth 알림 · count 는 is_sample=false + withDeleted 로 조회', async () => {
        const app = makeApp({ status: 'IN_PROGRESS' });
        const { em } = makeEntityManager(app);
        dataSource.transaction.mockImplementation((cb: any) => cb(em));
        mockAppRepo.count.mockResolvedValue(1);

        await service.create('user-uuid-1', { companyName: '카카오' });
        await new Promise((r) => setImmediate(r));

        // 샘플 카드 카운팅 제외 검증 (사용자 명시 요구)
        expect(mockAppRepo.count).toHaveBeenCalledWith({
          where: { userId: 'user-uuid-1', isSample: false },
          withDeleted: true,
        });
        expect(mockDiscord.notify).toHaveBeenCalledWith(
          expect.objectContaining({
            title: expect.stringContaining('첫 지원 카드'),
          }),
          'growth',
        );
      });

      it('실 카드 count=2 (이미 있음) → 알림 없음', async () => {
        const app = makeApp({ status: 'IN_PROGRESS' });
        const { em } = makeEntityManager(app);
        dataSource.transaction.mockImplementation((cb: any) => cb(em));
        mockAppRepo.count.mockResolvedValue(2);

        await service.create('user-uuid-1', { companyName: '네이버' });
        await new Promise((r) => setImmediate(r));

        expect(mockDiscord.notify).not.toHaveBeenCalled();
      });

      it('count 집계 실패해도 카드 생성은 정상 반환', async () => {
        const app = makeApp({ status: 'IN_PROGRESS' });
        const { em } = makeEntityManager(app);
        dataSource.transaction.mockImplementation((cb: any) => cb(em));
        mockAppRepo.count.mockRejectedValue(new Error('db'));

        await expect(
          service.create('user-uuid-1', { companyName: '토스' }),
        ).resolves.toBeDefined();
      });
    });

    it('status=IN_PROGRESS → 기본 4스텝 생성 (이름, orderIndex 0~3)', async () => {
      const app = makeApp({ status: 'IN_PROGRESS' });
      const { em, savedSteps } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', {
        companyName: '카카오',
        status: 'IN_PROGRESS',
      });

      expect(savedSteps).toHaveLength(4);
      expect(savedSteps[0]).toMatchObject({ name: '서류 제출', orderIndex: 0 });
      expect(savedSteps[3]).toMatchObject({ name: '최종 합격', orderIndex: 3 });

      DEFAULT_STEP_NAMES.forEach((name, i) => {
        expect(savedSteps[i]).toMatchObject({ name, orderIndex: i });
      });
    });

    it('templateId=it_dev → IT 개발 전형 스텝 생성', async () => {
      const app = makeApp({ status: 'IN_PROGRESS' });
      const { em, savedSteps } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', {
        companyName: '네이버',
        status: 'IN_PROGRESS',
        templateId: 'it_dev',
      });

      expect(savedSteps.map((s: { name: string }) => s.name)).toEqual([
        '서류 제출',
        '코딩테스트·과제',
        '1차 기술면접',
        '2차 컬처핏',
        '최종 합격',
      ]);
      expect(savedSteps[0]).toMatchObject({ orderIndex: 0 });
      expect(savedSteps[4]).toMatchObject({ name: '최종 합격', orderIndex: 4 });
    });

    it('templateId 미지정 → general(기본 4스텝)', async () => {
      const app = makeApp({ status: 'IN_PROGRESS' });
      const { em, savedSteps } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', {
        companyName: '쿠팡',
        status: 'IN_PROGRESS',
      });

      expect(savedSteps.map((s: { name: string }) => s.name)).toEqual(
        DEFAULT_STEP_NAMES,
      );
    });

    it('deadline 전달 시 첫 스텝(서류 제출) scheduledDate에 자동 설정', async () => {
      const app = makeApp({ status: 'IN_PROGRESS' });
      const { em, savedSteps } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', {
        companyName: '네카라',
        status: 'IN_PROGRESS',
        deadline: '2025-12-31',
      });

      expect(savedSteps[0]).toMatchObject({ name: '서류 제출', orderIndex: 0 });
      expect(savedSteps[0].scheduledDate).toEqual(new Date('2025-12-31'));
      expect(savedSteps[1].scheduledDate).toBeNull();
    });

    it('deadline 미전달 시 모든 스텝 scheduledDate null', async () => {
      const app = makeApp({ status: 'IN_PROGRESS' });
      const { em, savedSteps } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', {
        companyName: '쿠팡',
        status: 'IN_PROGRESS',
      });

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

      await service.create('user-uuid-1', {
        companyName: '라인',
        status: 'PLANNED',
      });

      // Application save 1번 + Steps save 없음
      expect(em.save).toHaveBeenCalledTimes(1);
    });

    it('needsDetail: IN_PROGRESS + jobTitle 없으면 true', async () => {
      const app = makeApp({ needsDetail: true });
      const { em } = makeEntityManager(app);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.create('user-uuid-1', {
        companyName: '토스',
        status: 'IN_PROGRESS',
      });

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
    // update 가 dataSource.transaction wrap (트랜잭션 audit) — em 으로 save·count·findOne·create 통일
    let em: {
      save: jest.Mock;
      count: jest.Mock;
      findOne: jest.Mock;
      create: jest.Mock;
    };

    beforeEach(() => {
      em = {
        save: jest.fn().mockImplementation(async (a: unknown) => a),
        count: jest.fn().mockResolvedValue(0),
        findOne: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation((_entity: unknown, data: unknown) => data),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(em));
    });

    /**
     * A9 — failedTakeaway 시나리오:
     * 1. 입력 → trim 저장 + failedTakeawayAt 세팅
     * 2. 수정 → 값·시각 갱신
     * 3. 빈 문자열 → null 삭제 + 시각 null
     * 4. 미전송(undefined) → 기존 값 불변
     * 5. FAILED → IN_PROGRESS 롤백 전이 허용 (결과 되돌리기)
     */
    it('A9-1) failedTakeaway 입력 → trim 저장 + at 세팅', async () => {
      const app = makeApp({ status: 'FAILED' });
      appRepo.findOne.mockResolvedValueOnce(app).mockResolvedValue(app);

      await service.update('user-uuid-1', 'app-uuid-1', {
        failedTakeaway: '  코테는 통과했다  ',
      });

      const saved = em.save.mock.calls[0][0];
      expect(saved.failedTakeaway).toBe('코테는 통과했다');
      expect(saved.failedTakeawayAt).toBeInstanceOf(Date);
    });

    it('A9-2) 빈 문자열 → null 삭제 + at null', async () => {
      const app = makeApp({
        status: 'FAILED',
        failedTakeaway: '기존 회고',
        failedTakeawayAt: new Date(),
      });
      appRepo.findOne.mockResolvedValueOnce(app).mockResolvedValue(app);

      await service.update('user-uuid-1', 'app-uuid-1', {
        failedTakeaway: '   ',
      });

      const saved = em.save.mock.calls[0][0];
      expect(saved.failedTakeaway).toBeNull();
      expect(saved.failedTakeawayAt).toBeNull();
    });

    it('A9-3) 미전송 → 기존 회고 불변', async () => {
      const at = new Date('2026-07-01T00:00:00Z');
      const app = makeApp({
        status: 'FAILED',
        failedTakeaway: '기존 회고',
        failedTakeawayAt: at,
      });
      appRepo.findOne.mockResolvedValueOnce(app).mockResolvedValue(app);

      await service.update('user-uuid-1', 'app-uuid-1', { memo: '메모만' });

      const saved = em.save.mock.calls[0][0];
      expect(saved.failedTakeaway).toBe('기존 회고');
      expect(saved.failedTakeawayAt).toBe(at);
    });

    it('A9-4) FAILED → IN_PROGRESS 롤백 전이 허용', async () => {
      const app = makeApp({ status: 'FAILED' });
      appRepo.findOne.mockResolvedValueOnce(app).mockResolvedValue({
        ...app,
        status: 'IN_PROGRESS',
      });

      await service.update('user-uuid-1', 'app-uuid-1', {
        status: 'IN_PROGRESS',
      });

      const saved = em.save.mock.calls[0][0];
      expect(saved.status).toBe('IN_PROGRESS');
    });

    it('PLANNED→IN_PROGRESS + 기존 스텝 없음 → createDefaultSteps 호출', async () => {
      const app = makeApp({ status: 'PLANNED' });
      appRepo.findOne
        .mockResolvedValueOnce(app) // findEntity
        .mockResolvedValue({
          ...app,
          status: 'IN_PROGRESS',
          steps: makeDefaultSteps(),
        }); // findOne return
      em.count.mockResolvedValue(0); // 기존 스텝 없음

      await service.update('user-uuid-1', 'app-uuid-1', {
        status: 'IN_PROGRESS',
      });

      expect(em.count).toHaveBeenCalledWith(ApplicationStep, {
        where: { applicationId: 'app-uuid-1' },
      });
      // em.save 가 최소 2번 (app + steps array)
      expect(em.save.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('PLANNED→IN_PROGRESS + 기존 스텝 있음 → createDefaultSteps 미호출', async () => {
      const app = makeApp({ status: 'PLANNED' });
      appRepo.findOne.mockResolvedValueOnce(app).mockResolvedValue({
        ...app,
        status: 'IN_PROGRESS',
        steps: makeDefaultSteps(),
      });
      em.count.mockResolvedValue(7); // 이미 스텝 있음

      await service.update('user-uuid-1', 'app-uuid-1', {
        status: 'IN_PROGRESS',
      });

      expect(em.count).toHaveBeenCalled();
      // em.save 는 app 1번만 (steps 미생성)
      expect(em.save).toHaveBeenCalledTimes(1);
    });

    it('존재하지 않는 카드 → NotFoundException', async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update('user-uuid-1', 'nonexistent', { companyName: '수정' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('직무명을 채우면 needsDetail이 false로 재계산됨 ("상세 입력 필요" 배지 해제)', async () => {
      const app = makeApp({
        status: 'IN_PROGRESS',
        jobTitle: null,
        needsDetail: true,
      });
      appRepo.findOne
        .mockResolvedValueOnce(app)
        .mockResolvedValue({ ...app, jobTitle: '백엔드 개발자', steps: [] });

      await service.update('user-uuid-1', 'app-uuid-1', {
        jobTitle: '백엔드 개발자',
      });

      // em.save 첫 호출 = app 객체
      expect(em.save.mock.calls[0][0]).toMatchObject({
        jobTitle: '백엔드 개발자',
        needsDetail: false,
      });
    });

    // ── 트랜잭션 rollback (memory feedback_transaction_wrap) ──
    it('app.save 성공 후 em.save(steps) 실패 → 트랜잭션 전체 reject (rollback)', async () => {
      const app = makeApp({ status: 'PLANNED' });
      appRepo.findOne.mockResolvedValueOnce(app);
      em.count.mockResolvedValue(0); // createDefaultSteps 분기 진입
      let saveCallNo = 0;
      em.save.mockImplementation(async (data) => {
        saveCallNo++;
        if (saveCallNo === 1) return data; // app.save 성공
        throw new Error('FK violation on steps insert'); // steps.save 실패
      });
      await expect(
        service.update('user-uuid-1', 'app-uuid-1', { status: 'IN_PROGRESS' }),
      ).rejects.toThrow('FK violation on steps insert');
    });

    it('IN_PROGRESS인데 직무명이 여전히 없으면 needsDetail은 true 유지', async () => {
      const app = makeApp({
        status: 'IN_PROGRESS',
        jobTitle: null,
        needsDetail: true,
      });
      appRepo.findOne
        .mockResolvedValueOnce(app)
        .mockResolvedValue({ ...app, steps: [] });

      await service.update('user-uuid-1', 'app-uuid-1', {
        memo: '메모만 수정',
      });

      expect(em.save.mock.calls[0][0]).toMatchObject({ needsDetail: true });
    });
  });

  // ── updateCurrentStep ──────────────────────────────────
  describe('updateCurrentStep', () => {
    it('마지막 스텝 클릭 → appRepo.update에 status: PASSED 포함', async () => {
      const steps = makeDefaultSteps(); // 4개, 마지막 index=3
      stepRepo.find.mockResolvedValue(steps);
      appRepo.findOne.mockResolvedValue(makeApp()); // findEntity
      appRepo.update.mockResolvedValue({} as any);
      appRepo.findOne.mockResolvedValue(
        makeApp({ currentStepIndex: 3, status: 'PASSED', steps }),
      );

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
      appRepo.findOne.mockResolvedValue(
        makeApp({ currentStepIndex: 2, steps }),
      );

      await service.updateCurrentStep('user-uuid-1', 'app-uuid-1', 2);

      expect(appRepo.update).toHaveBeenCalledWith('app-uuid-1', {
        currentStepIndex: 2,
      });
    });

    it('stepIndex < 0 → ForbiddenException', async () => {
      stepRepo.find.mockResolvedValue(makeDefaultSteps());
      appRepo.findOne.mockResolvedValue(makeApp());

      await expect(
        service.updateCurrentStep('user-uuid-1', 'app-uuid-1', -1),
      ).rejects.toThrow(ForbiddenException);
    });

    it('stepIndex >= steps.length → ForbiddenException', async () => {
      stepRepo.find.mockResolvedValue(makeDefaultSteps()); // 4개
      appRepo.findOne.mockResolvedValue(makeApp());

      await expect(
        service.updateCurrentStep('user-uuid-1', 'app-uuid-1', 4),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── updateSteps (LRR P2T2 PR α — CRT-1 fix: checklist 보존) ─────
  describe('updateSteps', () => {
    type RecordedCall =
      | { op: 'update'; id: string; patch: Record<string, unknown> }
      | { op: 'insert'; data: Record<string, unknown> }
      | { op: 'delete'; ids: string[] };

    const makeEm = (
      existing: Array<{ id: string; orderIndex: number; name: string }>,
    ): { em: EntityManager; calls: RecordedCall[] } => {
      const calls: RecordedCall[] = [];
      const em = {
        find: jest.fn().mockResolvedValue(existing),
        update: jest
          .fn()
          .mockImplementation(
            async (
              _entity: unknown,
              id: string,
              patch: Record<string, unknown>,
            ) => {
              calls.push({ op: 'update', id, patch });
              return { affected: 1 };
            },
          ),
        create: jest
          .fn()
          .mockImplementation((_e: unknown, d: Record<string, unknown>) => d),
        save: jest
          .fn()
          .mockImplementation(
            async (_e: unknown, d: Record<string, unknown>) => {
              calls.push({ op: 'insert', data: d });
              return d;
            },
          ),
        delete: jest
          .fn()
          .mockImplementation(async (_e: unknown, ids: string[]) => {
            calls.push({ op: 'delete', ids });
            return { affected: ids.length };
          }),
        findOne: jest.fn().mockResolvedValue({ id: 'app-uuid-1' }),
      } as unknown as EntityManager;
      return { em, calls };
    };

    it('CRT-1 회귀: dto step.id 일치 → update만 (delete·cascade 없음 → checklist 보존)', async () => {
      const app = makeApp();
      appRepo.findOne.mockResolvedValue(app);
      const existing = [
        { id: 'step-1', orderIndex: 0, name: '서류' },
        { id: 'step-2', orderIndex: 1, name: '면접' },
      ];
      const { em, calls } = makeEm(existing);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.updateSteps('user-uuid-1', 'app-uuid-1', {
        steps: [
          { id: 'step-1', orderIndex: 0, name: '서류 (수정)' },
          { id: 'step-2', orderIndex: 1, name: '면접' },
        ],
      });

      const deletes = calls.filter((c) => c.op === 'delete');
      const inserts = calls.filter((c) => c.op === 'insert');
      const updates = calls.filter((c) => c.op === 'update');
      expect(deletes).toHaveLength(0);
      expect(inserts).toHaveLength(0);
      expect(updates).toHaveLength(2);
      expect(updates[0]).toMatchObject({
        op: 'update',
        id: 'step-1',
        patch: { name: '서류 (수정)' },
      });
    });

    it('dto에 없는 기존 step만 삭제 (해당 step의 체크리스트만 cascade 삭제)', async () => {
      const app = makeApp();
      appRepo.findOne.mockResolvedValue(app);
      const existing = [
        { id: 'step-1', orderIndex: 0, name: '서류' },
        { id: 'step-2', orderIndex: 1, name: '면접' },
        { id: 'step-3', orderIndex: 2, name: '결과' },
      ];
      const { em, calls } = makeEm(existing);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      // step-3 제거
      await service.updateSteps('user-uuid-1', 'app-uuid-1', {
        steps: [
          { id: 'step-1', orderIndex: 0, name: '서류' },
          { id: 'step-2', orderIndex: 1, name: '면접' },
        ],
      });

      const deletes = calls.filter((c) => c.op === 'delete');
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toMatchObject({ op: 'delete', ids: ['step-3'] });
    });

    it('dto에 id 없는 step → 신규 INSERT', async () => {
      const app = makeApp();
      appRepo.findOne.mockResolvedValue(app);
      const existing = [{ id: 'step-1', orderIndex: 0, name: '서류' }];
      const { em, calls } = makeEm(existing);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.updateSteps('user-uuid-1', 'app-uuid-1', {
        steps: [
          { id: 'step-1', orderIndex: 0, name: '서류' },
          { orderIndex: 1, name: '새 면접' },
        ],
      });

      const inserts = calls.filter((c) => c.op === 'insert');
      expect(inserts).toHaveLength(1);
      expect(inserts[0]).toMatchObject({
        op: 'insert',
        data: { name: '새 면접', applicationId: 'app-uuid-1' },
      });
    });

    it('scheduledDate 문자열 → Date 변환 / null이면 null', async () => {
      const app = makeApp();
      appRepo.findOne.mockResolvedValue(app);
      const existing = [{ id: 'step-1', orderIndex: 0, name: '서류' }];
      const { em, calls } = makeEm(existing);
      dataSource.transaction.mockImplementation((cb: any) => cb(em));

      await service.updateSteps('user-uuid-1', 'app-uuid-1', {
        steps: [
          {
            id: 'step-1',
            orderIndex: 0,
            name: '서류',
            scheduledDate: '2025-09-01T10:00:00Z',
          },
          { orderIndex: 1, name: '면접' },
        ],
      });

      const updates = calls.filter((c) => c.op === 'update');
      const inserts = calls.filter((c) => c.op === 'insert');
      expect(updates[0].patch.scheduledDate).toBeInstanceOf(Date);
      expect(inserts[0].data.scheduledDate).toBeNull();
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
      await expect(
        service.remove('user-uuid-1', 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('다른 userId의 카드 → NotFoundException (403 아님)', async () => {
      appRepo.findOne.mockResolvedValue(null); // userId 조건에서 걸림
      await expect(service.remove('user-B', 'app-uuid-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── W1: dismissSample (개별 sample 카드 숨김) ────────────
  describe('dismissSample (W1)', () => {
    it('정상 sample 카드 → softRemove 호출', async () => {
      const app = makeApp({ isSample: true });
      appRepo.findOne.mockResolvedValue(app);
      appRepo.softRemove.mockResolvedValue(app);

      await service.dismissSample('user-uuid-1', 'app-uuid-1');

      expect(appRepo.softRemove).toHaveBeenCalledWith(app);
    });

    it('진짜 카드 (isSample=false) → 400 BadRequest', async () => {
      const app = makeApp({ isSample: false });
      appRepo.findOne.mockResolvedValue(app);

      await expect(
        service.dismissSample('user-uuid-1', 'app-uuid-1'),
      ).rejects.toThrow(BadRequestException);
      expect(appRepo.softRemove).not.toHaveBeenCalled();
    });

    it('다른 userId 카드 (IDOR) → NotFoundException (findEntity 가 userId 조건)', async () => {
      appRepo.findOne.mockResolvedValue(null);

      await expect(
        service.dismissSample('user-B', 'app-uuid-1'),
      ).rejects.toThrow(NotFoundException);
      expect(appRepo.softRemove).not.toHaveBeenCalled();
    });

    it('존재하지 않는 application → NotFoundException', async () => {
      appRepo.findOne.mockResolvedValue(null);

      await expect(
        service.dismissSample('user-uuid-1', 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── HI-1 회귀: checklist update/delete stepId-appId 매칭 ─────
  describe('updateChecklistItem · deleteChecklistItem (HI-1)', () => {
    it('updateChecklistItem: 본인 app + 본인 step·item → 200', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      stepRepo.findOne.mockResolvedValue(makeStep(0, '서류'));
      const existingItem = { id: 'item-1', stepId: 'step-0', content: '기존' };
      checklistRepo.findOne.mockResolvedValue(existingItem as never);
      checklistRepo.save.mockImplementation(async (item) => item as never);

      await service.updateChecklistItem(
        'user-uuid-1',
        'app-uuid-1',
        'step-0',
        'item-1',
        { content: '갱신' },
      );

      expect(stepRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'step-0', applicationId: 'app-uuid-1' },
      });
    });

    it('updateChecklistItem: 본인 app + 타인 stepId → NotFoundException (stepRepo.findOne null)', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      stepRepo.findOne.mockResolvedValue(null); // 타인 step
      await expect(
        service.updateChecklistItem(
          'user-uuid-1',
          'app-uuid-1',
          'foreign-step',
          'item-1',
          { content: 'x' },
        ),
      ).rejects.toThrow(NotFoundException);
      // checklistRepo는 호출되지 않아야 함 (step 검증에서 차단)
      expect(checklistRepo.findOne).not.toHaveBeenCalled();
    });

    it('deleteChecklistItem: 본인 app + 본인 step·item → ok', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      stepRepo.findOne.mockResolvedValue(makeStep(0, '서류'));
      const existingItem = { id: 'item-1', stepId: 'step-0' };
      checklistRepo.findOne.mockResolvedValue(existingItem as never);
      checklistRepo.remove.mockResolvedValue(existingItem as never);

      await service.deleteChecklistItem(
        'user-uuid-1',
        'app-uuid-1',
        'step-0',
        'item-1',
      );

      expect(checklistRepo.remove).toHaveBeenCalledWith(existingItem);
    });

    it('deleteChecklistItem: 본인 app + 타인 stepId → NotFoundException', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      stepRepo.findOne.mockResolvedValue(null);
      await expect(
        service.deleteChecklistItem(
          'user-uuid-1',
          'app-uuid-1',
          'foreign-step',
          'item-1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(checklistRepo.findOne).not.toHaveBeenCalled();
      expect(checklistRepo.remove).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // PR_B1c — generateCoverletter (자소서 생성 시 회사조사 atomic + 50 코인 차감)
  // ────────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────────
  // PR_B1c Phase D — update endpoint 의 outdated 감지 (Medium 5)
  // ────────────────────────────────────────────────────────────────────

  describe('update — outdated 감지 (PR_B1c Phase D)', () => {
    /** save 가 받은 entity 캡처용 helper */
    let savedEntity: Application | undefined;

    beforeEach(() => {
      savedEntity = undefined;
      dataSource.transaction = jest.fn().mockImplementation(async (cb) => {
        const em = {
          save: jest.fn().mockImplementation(async (entity: Application) => {
            savedEntity = entity;
            return entity;
          }),
          count: jest.fn().mockResolvedValue(1),
          findOne: jest.fn().mockResolvedValue(null),
          delete: jest.fn(),
          create: jest.fn(),
        };
        await cb(em);
      });
      appRepo.findOne.mockResolvedValue(
        makeApp({
          companyName: '카카오',
          jobTitle: '백엔드',
          jobCategory: 'IT개발',
          coverletterGenerationStatus: 'completed',
        }),
      );
    });

    it("D1) status='completed' + companyName 변경 → outdated_at = NOW()", async () => {
      await service.update('user-uuid-1', 'app-uuid-1', {
        companyName: '네이버',
      });
      expect(savedEntity?.coverletterResearchOutdatedAt).toBeInstanceOf(Date);
    });

    it("D2) status='completed' + jobTitle 변경 → outdated_at = NOW()", async () => {
      await service.update('user-uuid-1', 'app-uuid-1', {
        jobTitle: '프론트엔드',
      });
      expect(savedEntity?.coverletterResearchOutdatedAt).toBeInstanceOf(Date);
    });

    it("D3) status='completed' + jobCategory 변경 → outdated_at = NOW()", async () => {
      await service.update('user-uuid-1', 'app-uuid-1', {
        jobCategory: '디자인',
      });
      expect(savedEntity?.coverletterResearchOutdatedAt).toBeInstanceOf(Date);
    });

    it("D4) status='completed' + memo 만 변경 → outdated_at 그대로 NULL", async () => {
      await service.update('user-uuid-1', 'app-uuid-1', {
        memo: '면접 메모',
      });
      expect(savedEntity?.coverletterResearchOutdatedAt).toBeUndefined();
    });

    it("D5) status='completed' + status 변경 (PASSED) → outdated_at 무관 NULL", async () => {
      await service.update('user-uuid-1', 'app-uuid-1', {
        status: 'PASSED',
      });
      expect(savedEntity?.coverletterResearchOutdatedAt).toBeUndefined();
    });

    it("D6) status='completed' + 동일 회사명 patch → outdated_at 그대로 (diff 없음)", async () => {
      await service.update('user-uuid-1', 'app-uuid-1', {
        companyName: '카카오', // 기존 값 그대로
      });
      expect(savedEntity?.coverletterResearchOutdatedAt).toBeUndefined();
    });

    it("D7) status='idle' + companyName 변경 → outdated_at 무관 (재조사 자유)", async () => {
      appRepo.findOne.mockResolvedValueOnce(
        makeApp({
          companyName: '카카오',
          coverletterGenerationStatus: 'idle',
        }),
      );
      await service.update('user-uuid-1', 'app-uuid-1', {
        companyName: '네이버',
      });
      expect(savedEntity?.coverletterResearchOutdatedAt).toBeUndefined();
    });

    it("D8) status='failed' + companyName 변경 → outdated_at 무관 (이미 미완료)", async () => {
      appRepo.findOne.mockResolvedValueOnce(
        makeApp({
          companyName: '카카오',
          coverletterGenerationStatus: 'failed',
        }),
      );
      await service.update('user-uuid-1', 'app-uuid-1', {
        companyName: '네이버',
      });
      expect(savedEntity?.coverletterResearchOutdatedAt).toBeUndefined();
    });

    it("D9) status='completed' + 회사 + 직무 동시 변경 → outdated_at = NOW() (한 번만)", async () => {
      await service.update('user-uuid-1', 'app-uuid-1', {
        companyName: '네이버',
        jobTitle: '프론트엔드',
      });
      expect(savedEntity?.coverletterResearchOutdatedAt).toBeInstanceOf(Date);
    });
  });
});
