import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { DashboardService, computeNextAction } from './dashboard.service';
import { Application } from '../applications/application.entity';
import { ApplicationCoverletter } from '../applications/application-coverletter.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { CompaniesService } from '../companies/companies.service';

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
  let coverletterRepo: jest.Mocked<Repository<ApplicationCoverletter>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let examRepo: jest.Mocked<Repository<ExamSchedule>>;

  const USER_ID = 'user-uuid-1';

  beforeEach(async () => {
    const mockExamRepo = mock<Repository<ExamSchedule>>();
    // 시험 일정 조회는 기본으로 빈 배열 — 개별 테스트에서 override 가능
    (mockExamRepo.createQueryBuilder as jest.Mock).mockReturnValue(makeQb([]));

    const mockAppRepo = mock<Repository<Application>>();
    mockAppRepo.find.mockResolvedValue([]);
    const mockCoverletterRepo = mock<Repository<ApplicationCoverletter>>();
    mockCoverletterRepo.find.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        {
          provide: getRepositoryToken(Application),
          useValue: mockAppRepo,
        },
        {
          provide: getRepositoryToken(ApplicationCoverletter),
          useValue: mockCoverletterRepo,
        },
        {
          provide: getRepositoryToken(ApplicationStep),
          useValue: mock<Repository<ApplicationStep>>(),
        },
        { provide: getRepositoryToken(ExamSchedule), useValue: mockExamRepo },
        {
          provide: CompaniesService,
          useValue: { getDomainByName: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    appRepo = module.get(getRepositoryToken(Application));
    coverletterRepo = module.get(getRepositoryToken(ApplicationCoverletter));
    stepRepo = module.get(getRepositoryToken(ApplicationStep));
    examRepo = module.get(getRepositoryToken(ExamSchedule));
  });

  afterEach(() => jest.clearAllMocks());

  // ── getStats ───────────────────────────────────────────
  describe('getStats', () => {
    it('IN_PROGRESS / PASSED / FAILED 각각 count → total·inProgress·passed', async () => {
      appRepo.count
        .mockResolvedValueOnce(5) // IN_PROGRESS
        .mockResolvedValueOnce(2) // PASSED
        .mockResolvedValueOnce(1); // FAILED
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb(0));

      const result = await service.getStats(USER_ID);

      expect(appRepo.count).toHaveBeenCalledTimes(3);
      // 전체(지원한 회사) = IN_PROGRESS + PASSED + FAILED (PLANNED 제외)
      expect(result.total).toBe(8);
      expect(result.inProgress).toBe(5);
      expect(result.passed).toBe(2);
    });

    it('"면접 본 횟수"는 stepRepo QueryBuilder로 조회 (스텝명 "면접" + 과거 날짜)', async () => {
      appRepo.count
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);
      const stepQb = makeQb(3);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getStats(USER_ID);

      expect(stepRepo.createQueryBuilder).toHaveBeenCalled();
      expect(stepQb.getCount).toHaveBeenCalled();
      expect(result.interviewsAttended).toBe(3);
    });

    it('통계가 모두 0 → { total: 0, inProgress: 0, interviewsAttended: 0, passed: 0 }', async () => {
      appRepo.count.mockResolvedValue(0);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb(0));

      const result = await service.getStats(USER_ID);

      expect(result).toEqual({
        total: 0,
        inProgress: 0,
        interviewsAttended: 0,
        passed: 0,
      });
    });
  });

  // ── getDdayList ────────────────────────────────────────
  describe('getDdayList', () => {
    // KST 기준 today — service 코드가 Asia/Seoul timezone으로 dday 계산하므로 동일하게 맞춰야 timezone-edge에서 1차이 안 남
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Seoul',
    });
    const todayMs = new Date(today).getTime();

    const makeStepWithDate = (
      id: string,
      name: string,
      appId: string,
      daysFromNow: number,
    ): ApplicationStep => {
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
      const steps = [0, 1, 2, 3, 4, 5].map((d) =>
        makeStepWithDate(`step-${d}`, `면접${d}`, `app-${d}`, d),
      );

      const appQb = makeQb([]);
      const stepQb = makeQb(steps);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result.length).toBeLessThanOrEqual(5);
      expect(result).toHaveLength(5);
    });

    it('D-day 오름차순 정렬 (임박한 순서로)', async () => {
      const steps = [
        makeStepWithDate('s3', '회사C', 'a3', 3),
        makeStepWithDate('s1', '회사A', 'a1', 1),
        makeStepWithDate('s2', '회사B', 'a2', 2),
      ];

      const appQb = makeQb([]);
      const stepQb = makeQb(steps);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result[0].dday).toBe(1);
      expect(result[1].dday).toBe(2);
      expect(result[2].dday).toBe(3);
    });

    it('스텝 일정 항목은 type="step"으로 반환', async () => {
      const appQb = makeQb([]);
      const steps = [makeStepWithDate('step-1', '1차 면접', 'app-1', 5)];
      const stepQb = makeQb(steps);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result[0].type).toBe('step');
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

    it('dday=0 (오늘 일정) 항목 포함, dday 값이 0', async () => {
      const steps = [makeStepWithDate('step-today', '오늘 일정', 'app-1', 0)];

      const appQb = makeQb([]);
      const stepQb = makeQb(steps);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].dday).toBe(0);
      expect(result[0].type).toBe('step');
    });

    it('6개 step 중 dday 오름차순 상위 5개만 반환', async () => {
      const steps = [0, 1, 2, 3, 4, 5].map((d) =>
        makeStepWithDate(`step-${d}`, '면접', `app-${d}`, d),
      );

      const appQb = makeQb([]);
      const stepQb = makeQb(steps);
      appRepo.createQueryBuilder = jest.fn().mockReturnValue(appQb);
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(stepQb);

      const result = await service.getDdayList(USER_ID);

      expect(result).toHaveLength(5);
      // 상위 5개: dday 0,1,2,3,4 (dday=5 제외)
      expect(result.map((r) => r.dday)).toEqual([0, 1, 2, 3, 4]);
    });

    it('시험 일정 항목은 type="exam"으로 반환되며 examId 매핑', async () => {
      const date = new Date(todayMs + 7 * 86400000);
      const exams = [
        {
          id: 'exam-1',
          user_id: USER_ID,
          exam_type: 'language',
          cert_type: 'TOEIC',
          name: 'TOEIC',
          exam_date: date,
        } as any,
      ];

      appRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb([]));
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb([]));
      examRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb(exams));

      const result = await service.getDdayList(USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('exam');
      expect(result[0].examId).toBe('exam-1');
      expect(result[0].companyName).toBe('TOEIC');
      expect(result[0].applicationId).toBeUndefined();
    });

    it('step·exam 혼합 시 dday 오름차순 + 5개 제한', async () => {
      const steps = [makeStepWithDate('s1', '1차 면접', 'app-1', 2)];
      const exam = {
        id: 'exam-1',
        user_id: USER_ID,
        exam_type: 'cert',
        name: '정보처리기사',
        exam_date: new Date(todayMs + 3 * 86400000),
      } as any;

      appRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb([]));
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb(steps));
      examRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb([exam]));

      const result = await service.getDdayList(USER_ID);

      expect(result.map((r) => r.type)).toEqual(['step', 'exam']);
      expect(result.map((r) => r.dday)).toEqual([2, 3]);
    });
  });

  // ── getYesterdayInterviews ────────────────────────────
  describe('getYesterdayInterviews', () => {
    const makeYesterdayStep = (
      id: string,
      name: string,
      appId: string,
    ): ApplicationStep => {
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

  // ── 캘린더 UX 재구성: computeNextAction helper (Hero CTA 산출) ─────────────
  describe('computeNextAction', () => {
    const makeCoverletter = (answer: string | null): ApplicationCoverletter =>
      ({
        id: 'c-' + Math.random().toString(36).slice(2, 6),
        applicationId: 'app-1',
        question: '지원 동기',
        answer,
      }) as ApplicationCoverletter;

    it('서류 계열 step 아님 → no_action, progress undefined', () => {
      const result = computeNextAction(
        '1차 면접',
        [makeCoverletter('답변')],
        false,
      );
      expect(result.nextAction).toBe('no_action');
      expect(result.progress).toBeUndefined();
    });

    it('서류 step 이지만 자소서 문항 0개 → no_action', () => {
      const result = computeNextAction('서류 마감', [], false);
      expect(result.nextAction).toBe('no_action');
      expect(result.progress).toBeUndefined();
    });

    it('answer 하나도 없음 → start_coverletter, progress { current:0, total:3 }', () => {
      const result = computeNextAction(
        '서류 마감',
        [makeCoverletter(null), makeCoverletter(''), makeCoverletter('   ')],
        false,
      );
      expect(result.nextAction).toBe('start_coverletter');
      expect(result.progress).toEqual({ current: 0, total: 3 });
    });

    it('일부만 answer → writing_coverletter, progress current<total', () => {
      const result = computeNextAction(
        '서류 마감',
        [
          makeCoverletter('답변 있음'),
          makeCoverletter('두 번째 답변'),
          makeCoverletter(null),
        ],
        false,
      );
      expect(result.nextAction).toBe('writing_coverletter');
      expect(result.progress).toEqual({ current: 2, total: 3 });
    });

    it('모두 answer + research outdated → review_company', () => {
      const result = computeNextAction(
        '서류 마감',
        [makeCoverletter('a'), makeCoverletter('b')],
        true,
      );
      expect(result.nextAction).toBe('review_company');
      expect(result.progress).toEqual({ current: 2, total: 2 });
    });

    it('모두 answer + research 최신 → confirm_submit', () => {
      const result = computeNextAction(
        '서류 마감',
        [makeCoverletter('a'), makeCoverletter('b')],
        false,
      );
      expect(result.nextAction).toBe('confirm_submit');
      expect(result.progress).toEqual({ current: 2, total: 2 });
    });

    it('공채·자소서·지원 키워드 step 도 서류 계열로 인식', () => {
      const testCases = ['공채 마감', '자소서 마감', '지원서 제출'];
      for (const stepName of testCases) {
        const result = computeNextAction(
          stepName,
          [makeCoverletter(null)],
          false,
        );
        expect(result.nextAction).toBe('start_coverletter');
      }
    });
  });

  // ── 캘린더 UX 재구성: getDdayList 응답에 nextAction/progress 포함 ─────────────
  describe('getDdayList 응답 확장', () => {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Seoul',
    });
    const todayMs = new Date(today).getTime();

    const makeStep = (
      id: string,
      name: string,
      appId: string,
      daysFromNow: number,
    ): ApplicationStep => {
      const date = new Date(todayMs + daysFromNow * 86400000);
      return {
        id,
        name,
        applicationId: appId,
        scheduledDate: date,
        application: { id: appId, companyName: '카카오' } as Application,
      } as ApplicationStep;
    };

    it('step 응답에 nextAction 포함 (자소서 있음 → writing_coverletter)', async () => {
      const steps = [makeStep('s1', '서류 마감', 'app-1', 2)];
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb(steps));
      coverletterRepo.find.mockResolvedValue([
        { applicationId: 'app-1', answer: '답변' },
        { applicationId: 'app-1', answer: null },
      ] as ApplicationCoverletter[]);
      appRepo.find.mockResolvedValue([
        { id: 'app-1', coverletterResearchOutdatedAt: null },
      ] as Application[]);

      const result = await service.getDdayList(USER_ID);

      expect(result[0].nextAction).toBe('writing_coverletter');
      expect(result[0].progress).toEqual({ current: 1, total: 2 });
    });

    it('exam 응답은 nextAction=no_action, progress 없음', async () => {
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb([]));
      const examDate = new Date(todayMs + 5 * 86400000);
      const exams = [
        {
          id: 'exam-1',
          name: 'TOEIC',
          exam_date: examDate,
        },
      ];
      (examRepo.createQueryBuilder as jest.Mock).mockReturnValue(makeQb(exams));

      const result = await service.getDdayList(USER_ID);

      expect(result[0].type).toBe('exam');
      expect(result[0].nextAction).toBe('no_action');
      expect(result[0].progress).toBeUndefined();
    });

    it('자소서 관련 조회는 applicationIds 비어있으면 skip (성능)', async () => {
      stepRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQb([]));

      await service.getDdayList(USER_ID);

      // application 이 하나도 없으므로 coverletter/app find 호출 X
      expect(coverletterRepo.find).not.toHaveBeenCalled();
      expect(appRepo.find).not.toHaveBeenCalled();
    });
  });
});
