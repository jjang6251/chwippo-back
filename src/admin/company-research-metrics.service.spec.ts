import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { CompanyResearchMetricsService } from './company-research-metrics.service';
import { CompanyResearchCache } from '../interview-prep/entities/company-research-cache.entity';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';

describe('CompanyResearchMetricsService', () => {
  let service: CompanyResearchMetricsService;
  let cacheRepo: jest.Mocked<Repository<CompanyResearchCache>>;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;

  beforeEach(async () => {
    cacheRepo = mock<Repository<CompanyResearchCache>>();
    logRepo = mock<Repository<LlmCallLog>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompanyResearchMetricsService,
        {
          provide: getRepositoryToken(CompanyResearchCache),
          useValue: cacheRepo,
        },
        { provide: getRepositoryToken(LlmCallLog), useValue: logRepo },
      ],
    }).compile();
    service = module.get(CompanyResearchMetricsService);
  });

  // ── fill rate ──
  describe('getFillRate', () => {
    it('빈 cache → 11 항목 모두 0', async () => {
      cacheRepo.find.mockResolvedValue([]);
      const r = await service.getFillRate();
      expect(r).toHaveLength(11);
      expect(r.every((f) => f.total === 0 && f.rate === 0)).toBe(true);
    });

    it('mission 채워진 3 row + 1 row 빈 → mission rate = 3/4 = 0.75', async () => {
      cacheRepo.find.mockResolvedValue([
        { aiResearch: { mission: '미션1' } } as unknown as CompanyResearchCache,
        { aiResearch: { mission: '미션2' } } as unknown as CompanyResearchCache,
        { aiResearch: { mission: '미션3' } } as unknown as CompanyResearchCache,
        { aiResearch: {} } as unknown as CompanyResearchCache,
      ]);
      const r = await service.getFillRate();
      const mission = r.find((f) => f.field === 'mission')!;
      expect(mission.filled).toBe(3);
      expect(mission.total).toBe(4);
      expect(mission.rate).toBeCloseTo(0.75, 5);
    });

    it('빈 string / null / 빈 배열 / 빈 객체 → unfilled 처리', async () => {
      cacheRepo.find.mockResolvedValue([
        {
          aiResearch: {
            mission: '',
            products: null,
            culture: [],
            tech_stack: {},
          },
        } as unknown as CompanyResearchCache,
      ]);
      const r = await service.getFillRate();
      expect(r.find((f) => f.field === 'mission')!.filled).toBe(0);
      expect(r.find((f) => f.field === 'products')!.filled).toBe(0);
      expect(r.find((f) => f.field === 'culture')!.filled).toBe(0);
      expect(r.find((f) => f.field === 'tech_stack')!.filled).toBe(0);
    });

    it('11 필드 정확 — mission/vision/products/culture/recent_news/tech_stack/competitors/financials/hiring/reviews/media', async () => {
      cacheRepo.find.mockResolvedValue([]);
      const r = await service.getFillRate();
      const fields = r.map((f) => f.field);
      [
        'mission',
        'vision',
        'products',
        'culture',
        'recent_news',
        'tech_stack',
        'competitors',
        'financials',
        'hiring',
        'reviews',
        'media',
      ].forEach((f) => expect(fields).toContain(f));
    });
  });

  // ── cost trend ──
  describe('getCostTrend', () => {
    it('SQL — feature=company_research + group by day + order asc', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      logRepo.createQueryBuilder.mockReturnValue(qb as any);

      await service.getCostTrend();

      expect(qb.where).toHaveBeenCalledWith('l.feature = :feature', {
        feature: 'company_research',
      });
      expect(qb.groupBy).toHaveBeenCalledWith('date');
      expect(qb.orderBy).toHaveBeenCalledWith('date', 'ASC');
    });

    it('cost + calls parsing — string → number', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            date: new Date('2026-06-01T00:00:00Z'),
            cost: '1.2345',
            calls: '42',
          },
        ]),
      };

      logRepo.createQueryBuilder.mockReturnValue(qb as any);

      const r = await service.getCostTrend();
      expect(r[0].cost).toBeCloseTo(1.2345);
      expect(r[0].calls).toBe(42);
      expect(r[0].date).toBe('2026-06-01');
    });
  });

  // ── cache stats ──
  describe('getCacheStats', () => {
    it('total + active + expired + optOut 동시 조회', async () => {
      cacheRepo.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(80) // active
        .mockResolvedValueOnce(15) // expired
        .mockResolvedValueOnce(5); // optOut

      const r = await service.getCacheStats();
      expect(r).toEqual({ total: 100, active: 80, expired: 15, optOut: 5 });
    });
  });

  // ── top companies ──
  describe('getTopCompanies', () => {
    it('default limit 10 + hit_count desc', async () => {
      cacheRepo.find.mockResolvedValue([
        {
          companyName: '카카오',
          hitCount: 100,
          expiresAt: new Date('2026-09-01'),
        } as unknown as CompanyResearchCache,
      ]);

      await service.getTopCompanies();
      expect(cacheRepo.find).toHaveBeenCalledWith({
        order: { hitCount: 'DESC' },
        take: 10,
        select: ['companyName', 'hitCount', 'expiresAt'],
      });
    });

    it('limit 200 → 100 cap', async () => {
      cacheRepo.find.mockResolvedValue([]);
      await service.getTopCompanies(200);
      expect(cacheRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('limit 0 → 1 cap', async () => {
      cacheRepo.find.mockResolvedValue([]);
      await service.getTopCompanies(0);
      expect(cacheRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });
  });
});
