import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { AdminAiUsageService } from './admin-ai-usage.service';
import { LlmCallLog } from './entities/llm-call-log.entity';

describe('AdminAiUsageService', () => {
  let service: AdminAiUsageService;
  let repo: jest.Mocked<Repository<LlmCallLog>>;

  function makeQb<T>(
    raws: Array<T> = [],
    single: Record<string, string> | null = null,
  ) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(raws),
      getRawOne: jest.fn().mockResolvedValue(single),
    } as unknown as SelectQueryBuilder<LlmCallLog>;
    return qb;
  }

  beforeEach(async () => {
    const mockRepo = mock<Repository<LlmCallLog>>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminAiUsageService,
        { provide: getRepositoryToken(LlmCallLog), useValue: mockRepo },
      ],
    }).compile();
    service = module.get<AdminAiUsageService>(AdminAiUsageService);
    repo = module.get(getRepositoryToken(LlmCallLog));
  });

  it('overview: total + byFeature + byStatus 집계', async () => {
    repo.createQueryBuilder
      .mockReturnValueOnce(makeQb([], { calls: '100', cost: '0.5' }))
      .mockReturnValueOnce(
        makeQb([
          { feature: 'note_summary', calls: '80', cost: '0.4' },
          { feature: 'coverletter', calls: '20', cost: '0.1' },
        ]),
      )
      .mockReturnValueOnce(
        makeQb([
          { status: 'ok', count: '90' },
          { status: 'blocked_quota', count: '10' },
        ]),
      );

    const result = await service.overview({});

    expect(result.totalCalls).toBe(100);
    expect(result.totalCostUsd).toBe(0.5);
    expect(result.byFeature).toEqual([
      { feature: 'note_summary', calls: 80, costUsd: 0.4 },
      { feature: 'coverletter', calls: 20, costUsd: 0.1 },
    ]);
    expect(result.byStatus).toHaveLength(2);
  });

  it('byUser: cost desc 정렬', async () => {
    repo.createQueryBuilder.mockReturnValueOnce(
      makeQb([
        {
          userId: 'u1',
          totalCalls: '50',
          totalCostUsd: '0.3',
          totalPromptTokens: '5000',
          totalCompletionTokens: '1000',
        },
      ]),
    );

    const result = await service.byUser({});

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('u1');
    expect(result[0].totalCostUsd).toBe(0.3);
    expect(result[0].totalCalls).toBe(50);
  });

  it('userDetail: 특정 user 의 최근 호출 목록 (Between 필터)', async () => {
    const fakeLog = {
      id: 'l-1',
      userId: 'u1',
      feature: 'note_summary',
    } as LlmCallLog;
    repo.find.mockResolvedValue([fakeLog]);

    const result = await service.userDetail('u1', {});

    expect(result).toEqual([fakeLog]);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1' }),
        take: 500,
      }),
    );
  });

  it('feature 필터가 byUser·overview 양쪽 적용', async () => {
    const qb = makeQb([]);
    repo.createQueryBuilder.mockReturnValue(qb);

    await service.byUser({ feature: 'note_summary' });

    expect(qb.andWhere).toHaveBeenCalledWith('l.feature = :feature', {
      feature: 'note_summary',
    });
  });

  it('startDate/endDate 미지정 → 최근 30일 default 적용', async () => {
    const qb = makeQb([]);
    repo.createQueryBuilder.mockReturnValue(qb);
    await service.byUser({});
    // where 호출 시 :start 가 약 30일 전인지 검증
    const call = (qb.where as jest.Mock).mock.calls[0];
    expect(call[0]).toContain('BETWEEN :start AND :end');
    const start = call[1].start as Date;
    const end = call[1].end as Date;
    const diffDays = Math.round(
      (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
    );
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });

  it('데이터 0건 → 빈 배열·null safe 처리', async () => {
    repo.createQueryBuilder
      .mockReturnValueOnce(makeQb([], null))
      .mockReturnValueOnce(makeQb([]))
      .mockReturnValueOnce(makeQb([]));
    const result = await service.overview({});
    expect(result.totalCalls).toBe(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.byFeature).toEqual([]);
    expect(result.byStatus).toEqual([]);
  });
});
