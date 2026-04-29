import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { DashboardService } from './dashboard.service';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: getRepositoryToken(Application), useValue: mock<Repository<Application>>() },
        { provide: getRepositoryToken(ApplicationStep), useValue: mock<Repository<ApplicationStep>>() },
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
  });
});
