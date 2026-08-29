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
      // 호출당 평균 — 총액만으로는 「많이 쓰여서 비싼 기능」과 「한 번이 비싼 기능」이
      // 구분되지 않는다 (2026-08-29 · 공고 카드처럼 한도를 연 기능의 판정 근거)
      {
        feature: 'note_summary',
        calls: 80,
        costUsd: 0.4,
        avgCostPerCall: 0.005,
      },
      {
        feature: 'coverletter',
        calls: 20,
        costUsd: 0.1,
        avgCostPerCall: 0.005,
      },
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
    // half-open (`>= :start AND < :end`) — 이전 BETWEEN(양끝 inclusive) 이중 카운트 방지
    expect(call[0]).toContain('l.created_at >= :start AND l.created_at < :end');
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

    // TZ 경계 회귀 — 운영(Railway=UTC)에서 월초가 KST 기준인지.
    // 서버 로컬 new Date(year, month, 1) 이었다면 KST 월 경계 직후 UTC 로는 전월.
    it('monthStart 는 KST 월초의 UTC 시각 (UTC 서버 회귀)', async () => {
      jest.useFakeTimers();
      // UTC 2026-06-30 16:00 = KST 2026-07-01 01:00 (KST 7월 진입 직후)
      jest.setSystemTime(new Date('2026-06-30T16:00:00Z'));
      repo.createQueryBuilder.mockReturnValueOnce(makeQb([], { cost: '10' }));

      const result = await service.monthEstimate();

      // KST 07-01 00:00 = UTC 06-30 15:00 (naive UTC 구현이면 06-01 이 됐을 것)
      expect(result.monthStart).toBe('2026-06-30T15:00:00.000Z');
      expect(result.daysInMonth).toBe(31); // 7월
      expect(result.daysElapsed).toBe(1);

      jest.useRealTimers();
    });
  });
  /**
   * 기능별 월 비용 — 「이 기능을 한도 없이 열어도 되나」의 유일한 근거 (2026-08-29 · 대장 21).
   *
   * 🔴 전체 월 추정(`monthEstimate`)으로는 못 답한다. 공고 카드를 일 200(사실상 무제한)으로
   * 연 뒤 「그래서 얼마 나가는데」를 물으면, 전체 합계는 자소서·면접에 묻혀 안 보인다.
   */
  describe('featureMonthCosts (기능별 월 누적·추정)', () => {
    it('기능별 누적·추정·호출당 평균을 함께 준다', async () => {
      jest.useFakeTimers();
      // KST 2026-08-11 → 8월(31일) 중 11일 경과
      jest.setSystemTime(new Date('2026-08-11T03:00:00Z'));
      repo.createQueryBuilder.mockReturnValueOnce(
        makeQb([
          { feature: 'jobposting_card', calls: '100', cost: '0.5' },
          { feature: 'note_summary', calls: '10', cost: '0.1' },
        ]),
      );

      const r = await service.featureMonthCosts();

      expect(r.daysInMonth).toBe(31);
      expect(r.daysElapsed).toBe(11);
      expect(r.rows[0]).toMatchObject({
        feature: 'jobposting_card',
        calls: 100,
        monthToDateCost: 0.5,
        avgCostPerCall: 0.005,
      });
      // 누적 / 경과일 × 그달 총일수 — 전체 추정과 **같은 산식**이어야 합이 맞는다
      expect(r.rows[0].monthProjectedCost).toBeCloseTo((0.5 / 11) * 31, 10);
      jest.useRealTimers();
    });

    it('호출 0 인 기능의 평균은 null (0 으로 채우면 「공짜」로 보인다)', async () => {
      repo.createQueryBuilder.mockReturnValueOnce(
        makeQb([{ feature: 'note_ai_action', calls: '0', cost: '0' }]),
      );
      const r = await service.featureMonthCosts();
      expect(r.rows[0].avgCostPerCall).toBeNull();
      expect(r.rows[0].monthProjectedCost).toBe(0);
    });

    it('한 건도 없으면 빈 목록 (크래시 없음)', async () => {
      repo.createQueryBuilder.mockReturnValueOnce(makeQb([]));
      expect((await service.featureMonthCosts()).rows).toEqual([]);
    });

    it('🔴 월 경계는 KST — UTC 서버에서 매월 1일 0~9시에 전월로 새지 않는다', async () => {
      jest.useFakeTimers();
      // UTC 2026-07-31 16:00 = KST 2026-08-01 01:00
      jest.setSystemTime(new Date('2026-07-31T16:00:00Z'));
      repo.createQueryBuilder.mockReturnValueOnce(makeQb([]));

      const r = await service.featureMonthCosts();

      expect(r.monthStart).toBe('2026-07-31T15:00:00.000Z'); // KST 08-01 00:00
      expect(r.daysInMonth).toBe(31); // 8월
      expect(r.daysElapsed).toBe(1);
      jest.useRealTimers();
    });
  });
});
