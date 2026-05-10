import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { DashboardService } from './dashboard.service';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';

/** QueryBuilder mock 생성 헬퍼 */
const makeQb = (returnValue: any) => ({
  innerJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  getCount: jest.fn().mockResolvedValue(returnValue),
  getMany: jest.fn().mockResolvedValue(returnValue),
});

describe('DashboardService', () => {
  let service: DashboardService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;

  const USER_ID = 'user-uuid-1';

  beforeEach(async () => {
    const mockExamRepo = mock<Repository<ExamSchedule>>();
    // 시험 일정 조회는 기본으로 빈 배열 — 기존 테스트가 dday 결과에 시험을 가정하지 않으므로 디폴트 처리
    (mockExamRepo.createQueryBuilder as jest.Mock).mockReturnValue(makeQb([]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: getRepositoryToken(Application), useValue: mock<Repository<Application>>() },
        { provide: getRepositoryToken(ApplicationStep), useValue: mock<Repository<ApplicationStep>>() },
        { provide: getRepositoryToken(ExamSchedule), useValue: mockExamRepo },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    appRepo = module.get(getRepositoryToken(Application));
    stepRepo = module.get(getRepositoryToken(ApplicationStep));
  });

  afterEach(() => jest.clearAllMocks());

  // ── getStats ───────────────────────────────────────────
  describe('getStats', () => {
    it('IN_PROGRESS / PASSED / FAILED 상태 각각 count 호출', async () => {
      appRepo.count
        .mockResolvedValueOnce(5)   // IN_PROGRESS
        .mockResolvedValueOnce(2)   // PASSED
        .mockResolvedValueOnce(1);  // FAILED

      const qb = makeQb(3);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.getStats(USER_ID);

      expect(appRepo.count).toHaveBeenCalledTimes(3);
      // 전체 = IN_PROGRESS + PASSED + FAILED (PLANNED 제외)
      expect(result.total).toBe(8);
      expect(result.passed).toBe(2);
    });

    it('면접 카운트는 QueryBuilder로 조회 (스텝명에 "면접" 포함)', async () => {
      appRepo.count
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      const qb = makeQb(2);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.getStats(USER_ID);

      expect(appRepo.createQueryBuilder).toHaveBeenCalled();
      expect(qb.getCount).toHaveBeenCalled();
      expect(result.interviews).toBe(2);
    });

    it('통계가 모두 0인 경우 → { total: 0, interviews: 0, passed: 0 }', async () => {
      appRepo.count.mockResolvedValue(0);
      const qb = makeQb(0);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.getStats(USER_ID);

      expect(result).toEqual({ total: 0, interviews: 0, passed: 0 });
    });
  });

  // ── getDdayList ────────────────────────────────────────
  describe('getDdayList', () => {
    const today = new Date().toISOString().split('T')[0];
    const todayMs = new Date(today).getTime();

    const makeDeadlineApp = (id: string, companyName: string, daysFromNow: number): Application => {
      const date = new Date(todayMs + daysFromNow * 86400000);
      const deadline = date.toISOString().split('T')[0];
      return { id, companyName, deadline } as Application;
    };

    const makeStepWithDate = (id: string, name: string, appId: string, daysFromNow: number): ApplicationStep => {
      const date = new Date(todayMs + daysFromNow * 86400000);
      return {
        id,
        name,
        applicationId: appId,
        scheduledDate: date,
        application: { id: appId, companyName: '카카오' } as Application,
      } as ApplicationStep;
    };

    it('최대 5개로 제한 (6개 항목 있어도 5개만 반환)', async () => {
      const apps = [0, 1, 2, 3, 4, 5].map((d) => makeDeadlineApp(`app-${d}`, `회사${d}`, d));

      const appQb = makeQb(apps);
      const stepQb = makeQb([]);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result.length).toBeLessThanOrEqual(5);
      expect(result).toHaveLength(5);
    });

    it('D-day 오름차순 정렬 (임박한 순서로)', async () => {
      const apps = [
        makeDeadlineApp('a3', '회사C', 3),
        makeDeadlineApp('a1', '회사A', 1),
        makeDeadlineApp('a2', '회사B', 2),
      ];

      const appQb = makeQb(apps);
      const stepQb = makeQb([]);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result[0].dday).toBe(1);
      expect(result[1].dday).toBe(2);
      expect(result[2].dday).toBe(3);
    });

    it('서류 마감 항목은 type="deadline"으로 반환', async () => {
      const apps = [makeDeadlineApp('app-1', '네이버', 3)];

      const appQb = makeQb(apps);
      const stepQb = makeQb([]);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result[0].type).toBe('deadline');
      expect(result[0].companyName).toBe('네이버');
      expect(result[0].dday).toBe(3);
    });

    it('면접 일정 항목은 type="interview"로 반환', async () => {
      const appQb = makeQb([]);
      const steps = [makeStepWithDate('step-1', '1차 면접', 'app-1', 5)];
      const stepQb = makeQb(steps);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result[0].type).toBe('interview');
      expect(result[0].stepName).toBe('1차 면접');
      expect(result[0].dday).toBe(5);
    });

    it('아무 항목도 없으면 빈 배열 반환', async () => {
      const appQb = makeQb([]);
      const stepQb = makeQb([]);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result).toEqual([]);
    });

    it('dday=0 (오늘 마감) 항목 포함, dday 값이 0', async () => {
      const apps = [makeDeadlineApp('app-today', '오늘마감회사', 0)];

      const appQb = makeQb(apps);
      const stepQb = makeQb([]);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].dday).toBe(0);
      expect(result[0].type).toBe('deadline');
    });

    it('서류 마감과 면접 일정이 섞여 있으면 dday 기준으로 함께 정렬', async () => {
      const apps = [makeDeadlineApp('app-1', '서류회사', 4)];
      const steps = [makeStepWithDate('step-1', '1차 면접', 'app-2', 2)];

      const appQb = makeQb(apps);
      const stepQb = makeQb(steps);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('interview');  // dday=2가 먼저
      expect(result[0].dday).toBe(2);
      expect(result[1].type).toBe('deadline');   // dday=4가 나중
      expect(result[1].dday).toBe(4);
    });

    it('6개 항목 중 dday 오름차순 상위 5개만 반환 (deadline+interview 혼합)', async () => {
      const apps = [0, 2, 4].map((d) => makeDeadlineApp(`app-${d}`, `서류${d}`, d));
      const steps = [1, 3, 5].map((d) => makeStepWithDate(`step-${d}`, '면접', `app-s${d}`, d));

      const appQb = makeQb(apps);
      const stepQb = makeQb(steps);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result).toHaveLength(5);
      // 상위 5개: dday 0,1,2,3,4 (dday=5인 면접 제외)
      expect(result.map((r) => r.dday)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  // ── getYesterdayInterviews ────────────────────────────
  describe('getYesterdayInterviews', () => {
    const makeYesterdayStep = (id: string, name: string, appId: string): ApplicationStep => {
      const kst = 9 * 60 * 60 * 1000;
      const todayKst = new Date(Date.now() + kst);
      const todayStr = todayKst.toISOString().split('T')[0];
      const yesterday = new Date(new Date(todayStr).getTime() - 86400000);
      return {
        id,
        name,
        applicationId: appId,
        scheduledDate: yesterday,
        application: { id: appId, companyName: '카카오' } as Application,
      } as ApplicationStep;
    };

    it('어제 면접 일정이 있으면 stepId·stepName·applicationId·companyName 반환', async () => {
      const steps = [makeYesterdayStep('step-1', '1차 면접', 'app-1')];
      const qb = makeQb(steps);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.getYesterdayInterviews(USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].stepId).toBe('step-1');
      expect(result[0].stepName).toBe('1차 면접');
      expect(result[0].applicationId).toBe('app-1');
    });

    it('어제 면접이 없으면 빈 배열 반환', async () => {
      const qb = makeQb([]);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.getYesterdayInterviews(USER_ID);

      expect(result).toEqual([]);
    });

    it('쿼리에 userId 필터 포함 — 다른 유저 데이터 혼입 방지', async () => {
      const qb = makeQb([]);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      await service.getYesterdayInterviews(USER_ID);

      const whereCall = qb.where.mock.calls[0];
      expect(whereCall[1]).toMatchObject({ userId: USER_ID });
    });

    it('여러 면접이 있으면 모두 반환', async () => {
      const steps = [
        makeYesterdayStep('step-1', '1차 면접', 'app-1'),
        makeYesterdayStep('step-2', '임원 면접', 'app-2'),
      ];
      const qb = makeQb(steps);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.getYesterdayInterviews(USER_ID);

      expect(result).toHaveLength(2);
    });
  });
});
