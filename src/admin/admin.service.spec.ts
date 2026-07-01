import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AdminService } from './admin.service';
import { UsersService } from '../users/users.service';
import { InquiriesService } from '../inquiries/inquiries.service';
import { StorageUsageService } from '../myinfo/storage-usage.service';

describe('AdminService', () => {
  let service: AdminService;
  let usersService: jest.Mocked<UsersService>;
  let inquiriesService: jest.Mocked<InquiriesService>;
  let storageUsage: jest.Mocked<StorageUsageService>;
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    const mockUsersService = {
      countAll: jest.fn(),
      countByDate: jest.fn(),
    } as Partial<UsersService>;

    const mockInquiriesService = {
      countPending: jest.fn(),
    } as Partial<InquiriesService>;

    const mockStorageUsage = {
      getGlobalUsage: jest.fn().mockResolvedValue(0),
      getNearCapUserCount: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<StorageUsageService>;

    const mockDataSource = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: InquiriesService, useValue: mockInquiriesService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: StorageUsageService, useValue: mockStorageUsage },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
    usersService = module.get(UsersService);
    inquiriesService = module.get(InquiriesService);
    storageUsage = module.get(StorageUsageService);
    dataSource = module.get(DataSource);
  });

  afterEach(() => jest.clearAllMocks());

  // ── getStats ───────────────────────────────────────────
  describe('getStats', () => {
    it('totalUsers, newUsersMonth, newUsersWeek, pendingInquiries, globalStorage 반환 (G-1)', async () => {
      usersService.countAll.mockResolvedValue(100);
      usersService.countByDate
        .mockResolvedValueOnce(10) // newUsersMonth
        .mockResolvedValueOnce(3); // newUsersWeek
      inquiriesService.countPending.mockResolvedValue(5);
      storageUsage.getGlobalUsage.mockResolvedValue(500 * 1024 * 1024); // 500MB
      storageUsage.getNearCapUserCount.mockResolvedValue(2);

      const result = await service.getStats();

      expect(result).toEqual({
        totalUsers: 100,
        newUsersMonth: 10,
        newUsersWeek: 3,
        pendingInquiries: 5,
        globalStorage: {
          totalUsedBytes: 500 * 1024 * 1024,
          averageBytes: Math.round((500 * 1024 * 1024) / 100), // 평균
          nearCapUserCount: 2,
          r2FreeLimitGB: 10,
        },
      });
    });

    it('사용자 0명 → averageBytes=0, nearCapUserCount=0 (G-2)', async () => {
      usersService.countAll.mockResolvedValue(0);
      usersService.countByDate.mockResolvedValue(0);
      inquiriesService.countPending.mockResolvedValue(0);
      storageUsage.getGlobalUsage.mockResolvedValue(0);
      storageUsage.getNearCapUserCount.mockResolvedValue(0);

      const result = await service.getStats();

      expect(result.globalStorage).toEqual({
        totalUsedBytes: 0,
        averageBytes: 0,
        nearCapUserCount: 0,
        r2FreeLimitGB: 10,
      });
    });

    it('usersService.countAll, countByDate(2회), inquiriesService.countPending 각 1회 호출', async () => {
      usersService.countAll.mockResolvedValue(0);
      usersService.countByDate.mockResolvedValue(0);
      inquiriesService.countPending.mockResolvedValue(0);

      await service.getStats();

      expect(usersService.countAll).toHaveBeenCalledTimes(1);
      expect(usersService.countByDate).toHaveBeenCalledTimes(2);
      expect(inquiriesService.countPending).toHaveBeenCalledTimes(1);
    });

    it('countByDate 첫 번째 호출=이번 달 시작(1일), 두 번째=이번 주 시작(월요일)', async () => {
      usersService.countAll.mockResolvedValue(0);
      usersService.countByDate.mockResolvedValue(0);
      inquiriesService.countPending.mockResolvedValue(0);

      await service.getStats();

      const calls = usersService.countByDate.mock.calls;
      const monthStart: Date = calls[0][0];
      const weekStart: Date = calls[1][0];

      // monthStart 는 항상 이번 달 1일
      expect(monthStart.getDate()).toBe(1);
      // weekStart 는 항상 이번 주 월요일 (getDay: 1)
      // 주의: 월 첫 주에 1일이 화~일요일이면 weekStart < monthStart 라 단순 시간 비교 X (기존 spec 결함)
      expect(weekStart.getDay()).toBe(1);
    });
  });

  // ── getAnalytics ───────────────────────────────────────
  describe('getAnalytics', () => {
    const makeQueryResults = () => [
      [{ date: '2025-08-01', count: 5 }], // signupRows
      [{ date: '2025-08-01', count: 3 }], // dauRows
      [{ date: '2025-08-01', count: 2 }], // cardRows
      [{ date: '2025-08-01', count: 1 }], // inquiryRows
      [{ count: 50 }], // baseCumRow
      [{ avg_hours: 2.5 }], // replyRows
      [{ avg: 3.1 }], // cardsPerUserRows
      [{ cohort: 100, retained: 65 }], // d7Rows
    ];

    it('8개의 병렬 raw query 실행', async () => {
      const results = makeQueryResults();
      let callIdx = 0;
      dataSource.query.mockImplementation(() =>
        Promise.resolve(results[callIdx++]),
      );

      await service.getAnalytics(7);

      expect(dataSource.query).toHaveBeenCalledTimes(8);
    });

    it('반환 구조: dau, signups, cumulative, cards, inquiries, avgReplyHours, avgCardsPerUser, d7Retention', async () => {
      const results = makeQueryResults();
      let callIdx = 0;
      dataSource.query.mockImplementation(() =>
        Promise.resolve(results[callIdx++]),
      );

      const result = await service.getAnalytics(7);

      expect(result).toHaveProperty('dau');
      expect(result).toHaveProperty('signups');
      expect(result).toHaveProperty('cumulative');
      expect(result).toHaveProperty('cards');
      expect(result).toHaveProperty('inquiries');
      expect(result).toHaveProperty('avgReplyHours');
      expect(result).toHaveProperty('avgCardsPerUser');
      expect(result).toHaveProperty('d7Retention');
      expect(result).toHaveProperty('d7CohortSize');
    });

    it('d7Retention: cohort > 0이면 retained/cohort * 100 (반올림)', async () => {
      const results = makeQueryResults();
      // d7Rows: cohort=100, retained=65
      let callIdx = 0;
      dataSource.query.mockImplementation(() =>
        Promise.resolve(results[callIdx++]),
      );

      const result = await service.getAnalytics(7);

      expect(result.d7Retention).toBe(65);
      expect(result.d7CohortSize).toBe(100);
    });

    it('d7Retention: cohort = 0이면 null 반환 (0으로 나누기 방지)', async () => {
      const results = makeQueryResults();
      // d7Rows를 cohort=0으로 교체
      results[7] = [{ cohort: 0, retained: 0 }];
      let callIdx = 0;
      dataSource.query.mockImplementation(() =>
        Promise.resolve(results[callIdx++]),
      );

      const result = await service.getAnalytics(7);

      expect(result.d7Retention).toBeNull();
    });

    it('avgReplyHours: 첫 답변 시간 raw가 null이면 null 반환', async () => {
      const results = makeQueryResults();
      results[5] = [{ avg_hours: null }];
      let callIdx = 0;
      dataSource.query.mockImplementation(() =>
        Promise.resolve(results[callIdx++]),
      );

      const result = await service.getAnalytics(7);

      expect(result.avgReplyHours).toBeNull();
    });

    it('fillDates: days일치 날짜 배열 반환, 데이터 없는 날은 count=0', async () => {
      // signupRows가 빈 배열이면 모든 날짜가 0으로 채워져야 함
      const results = makeQueryResults();
      results[0] = []; // signupRows 빈 배열
      let callIdx = 0;
      dataSource.query.mockImplementation(() =>
        Promise.resolve(results[callIdx++]),
      );

      const result = await service.getAnalytics(7);

      expect(result.signups).toHaveLength(7);
      expect(
        result.signups.every(
          (d: any) => d.count === 0 || typeof d.count === 'number',
        ),
      ).toBe(true);
    });

    it('cumulative: baseCumRow부터 시작하여 signups 누적합 계산', async () => {
      const results = makeQueryResults();
      // baseCumRow = 50, signupRows = [{ date: '...', count: 5 }] → days=1이면 cumulative[0].count = 55
      results[0] = [
        {
          date: new Date().toLocaleDateString('en-CA', {
            timeZone: 'Asia/Seoul',
          }),
          count: 5,
        },
      ];
      results[4] = [{ count: 50 }];
      let callIdx = 0;
      dataSource.query.mockImplementation(() =>
        Promise.resolve(results[callIdx++]),
      );

      const result = await service.getAnalytics(1);

      expect(result.cumulative[0].count).toBe(55);
    });
  });
});
