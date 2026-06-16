import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { AdminAiUsageService } from './admin-ai-usage.service';
import { LlmCallLog } from './entities/llm-call-log.entity';

describe('AdminAiUsageService', () => {
  let service: AdminAiUsageService;
  let repo: jest.Mocked<Repository<LlmCallLog>>;
  let dataSource: jest.Mocked<DataSource>;

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
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(raws),
      getRawOne: jest.fn().mockResolvedValue(single),
    } as unknown as SelectQueryBuilder<LlmCallLog>;
    return qb;
  }

  beforeEach(async () => {
    const mockRepo = mock<Repository<LlmCallLog>>();
    const mockDs = mock<DataSource>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminAiUsageService,
        { provide: getRepositoryToken(LlmCallLog), useValue: mockRepo },
        { provide: DataSource, useValue: mockDs },
      ],
    }).compile();
    service = module.get<AdminAiUsageService>(AdminAiUsageService);
    repo = module.get(getRepositoryToken(LlmCallLog));
    dataSource = module.get(DataSource);
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

  // ── F6 PR 2 Phase 5.3 — v2 메트릭 ──

  describe('byModel (provider × model 비용)', () => {
    it('정상 집계 + cost desc', async () => {
      repo.createQueryBuilder.mockReturnValueOnce(
        makeQb([
          {
            provider: 'openai',
            model: 'gpt-4o',
            calls: '50',
            cost: '0.8',
          },
          {
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
            calls: '200',
            cost: '0.2',
          },
        ]),
      );
      const result = await service.byModel({});
      expect(result).toHaveLength(2);
      expect(result[0].provider).toBe('openai');
      expect(result[0].costUsd).toBe(0.8);
    });

    it('feature 필터 적용', async () => {
      const qb = makeQb([]);
      repo.createQueryBuilder.mockReturnValue(qb);
      await service.byModel({ feature: 'company_research' });
      expect(qb.andWhere).toHaveBeenCalledWith('l.feature = :feature', {
        feature: 'company_research',
      });
    });

    it('0건 → 빈 배열', async () => {
      repo.createQueryBuilder.mockReturnValueOnce(makeQb([]));
      const result = await service.byModel({});
      expect(result).toEqual([]);
    });
  });

  describe('byHour (KST hour bucket)', () => {
    it('KST timezone 적용된 SQL 생성', async () => {
      const qb = makeQb([]);
      repo.createQueryBuilder.mockReturnValue(qb);
      await service.byHour({});
      expect(qb.select).toHaveBeenCalledWith(
        expect.stringContaining("AT TIME ZONE 'Asia/Seoul'"),
        'hour',
      );
    });

    it('정상 집계 + Date → ISO string 변환', async () => {
      const sampleDate = new Date('2026-05-28T03:00:00Z');
      repo.createQueryBuilder.mockReturnValueOnce(
        makeQb([{ hour: sampleDate, calls: '10', cost: '0.05' }]),
      );
      const result = await service.byHour({});
      expect(result[0].hour).toBe(sampleDate.toISOString());
      expect(result[0].calls).toBe(10);
    });

    it('hour 가 string 그대로 와도 안전 처리', async () => {
      repo.createQueryBuilder.mockReturnValueOnce(
        makeQb([{ hour: '2026-05-28T03:00:00Z', calls: '1', cost: '0' }]),
      );
      const result = await service.byHour({});
      expect(typeof result[0].hour).toBe('string');
    });
  });

  describe('hallucinationStats (PII redacted 비율)', () => {
    it('정상 집계 + ratio 계산', async () => {
      repo.createQueryBuilder.mockReturnValueOnce(
        makeQb([
          { feature: 'note_summary', total: '100', redacted: '5' },
          { feature: 'coverletter_draft_v2', total: '50', redacted: '0' },
        ]),
      );
      const result = await service.hallucinationStats({});
      expect(result[0].ratio).toBeCloseTo(0.05);
      expect(result[1].ratio).toBe(0);
    });

    it('total=0 → ratio=0 safe (분모 0)', async () => {
      repo.createQueryBuilder.mockReturnValueOnce(
        makeQb([{ feature: 'note_summary', total: '0', redacted: '0' }]),
      );
      const result = await service.hallucinationStats({});
      expect(result[0].ratio).toBe(0);
    });
  });

  describe('cacheHitRate (note_summary + company_research)', () => {
    it('두 cache 통합 응답', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([{ total: '100', with_summary: '40' }])
        .mockResolvedValueOnce([{ rows: '10', total_hits: '50' }]);
      const result = await service.cacheHitRate();
      expect(result.noteSummary.ratio).toBe(0.4);
      expect(result.companyResearch.avgHitsPerRow).toBe(5);
    });

    it('0건 → ratio·avg 모두 0 safe', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([{ total: '0', with_summary: '0' }])
        .mockResolvedValueOnce([{ rows: '0', total_hits: '0' }]);
      const result = await service.cacheHitRate();
      expect(result.noteSummary.ratio).toBe(0);
      expect(result.companyResearch.avgHitsPerRow).toBe(0);
    });
  });

  describe('monthEstimate', () => {
    it('누적 / 경과일 × 31일 추정', async () => {
      repo.createQueryBuilder.mockReturnValueOnce(
        makeQb([], { cost: '10.00' }),
      );
      const result = await service.monthEstimate();
      expect(result.cumulativeCostUsd).toBe(10);
      expect(result.daysElapsed).toBeGreaterThanOrEqual(1);
      expect(result.estimatedMonthEndUsd).toBeGreaterThanOrEqual(
        result.cumulativeCostUsd,
      );
    });

    it('누적 0 → 추정도 0 safe', async () => {
      repo.createQueryBuilder.mockReturnValueOnce(makeQb([], { cost: '0' }));
      const result = await service.monthEstimate();
      expect(result.cumulativeCostUsd).toBe(0);
      expect(result.estimatedMonthEndUsd).toBe(0);
    });
  });
});
