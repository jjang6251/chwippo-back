import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock, MockProxy } from 'jest-mock-extended';
import { CompanyResearchStatusService } from './company-research-status.service';
import { CompanyResearchCache } from '../interview-prep/entities/company-research-cache.entity';
import { Application } from '../applications/application.entity';
import { CompaniesService } from '../companies/companies.service';

/** 체이닝(select/where/…) 이 자기 자신을 반환하는 QueryBuilder 목. */
function makeQb<T extends object = CompanyResearchCache>(): MockProxy<
  SelectQueryBuilder<T>
> {
  const qb = mock<SelectQueryBuilder<T>>();
  qb.select.mockReturnValue(qb);
  qb.addSelect.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.groupBy.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  qb.addOrderBy.mockReturnValue(qb);
  qb.offset.mockReturnValue(qb);
  qb.limit.mockReturnValue(qb);
  return qb;
}

interface CardRaw {
  norm: string;
  companyName: string;
  applicants: string | number;
  cards: string | number;
}
interface CacheRaw {
  norm: string;
  companyName: string;
  seedVersion: string | null;
  updatedAt: Date;
  expiresAt: Date;
  hitCount: string | number;
  optOut: boolean;
  researched: boolean;
  inferredCount: string | number;
}

describe('CompanyResearchStatusService', () => {
  let service: CompanyResearchStatusService;
  let cacheRepo: MockProxy<Repository<CompanyResearchCache>>;
  let appRepo: MockProxy<Repository<Application>>;
  let companies: MockProxy<CompaniesService>;

  beforeEach(async () => {
    cacheRepo = mock<Repository<CompanyResearchCache>>();
    appRepo = mock<Repository<Application>>();
    companies = mock<CompaniesService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompanyResearchStatusService,
        {
          provide: getRepositoryToken(CompanyResearchCache),
          useValue: cacheRepo,
        },
        {
          provide: getRepositoryToken(Application),
          useValue: appRepo,
        },
        { provide: CompaniesService, useValue: companies },
      ],
    }).compile();
    service = module.get(CompanyResearchStatusService);
  });

  // ── summary ──
  describe('getSummary', () => {
    it('정상 집계 — coverageRate·버전 분포·TTL 카운트·avgFillRate', async () => {
      companies.getTotalCount.mockReturnValue(100);
      const researchedQb = makeQb();
      // companies = 별칭 제외 회사 수(커버리지 분자), names = 별칭 포함 전체 이름 수.
      researchedQb.getRawOne.mockResolvedValue({
        companies: '30',
        names: '34',
      });
      const versionQb = makeQb();
      versionQb.getRawMany.mockResolvedValue([
        { version: '2026-07.4', cnt: '25' },
        { version: '2026-07.3', cnt: '5' },
      ]);
      cacheRepo.createQueryBuilder
        .mockReturnValueOnce(researchedQb)
        .mockReturnValueOnce(versionQb);
      cacheRepo.count
        .mockResolvedValueOnce(3) // optOut
        .mockResolvedValueOnce(10) // expiringSoon
        .mockResolvedValueOnce(8); // expired
      // avgFillRate 소스 — 8 항목 중 businessSummary 만 채워진 2 row
      cacheRepo.find.mockResolvedValue([
        { aiResearch: { businessSummary: '요약1' } },
        { aiResearch: { businessSummary: '요약2' } },
      ] as Pick<
        CompanyResearchCache,
        'aiResearch'
      >[] as CompanyResearchCache[]);

      const r = await service.getSummary();

      expect(r.totalCompanies).toBe(100);
      expect(r.researchedCount).toBe(30);
      // 별칭 포함 전체 이름 수 (커버리지 분모에는 미사용, 표시용).
      expect(r.researchedNames).toBe(34);
      // 커버리지 분자 = 회사 수(30) — 별칭 제외.
      expect(r.coverageRate).toBeCloseTo(0.3, 5);
      expect(r.versionDistribution).toEqual([
        { version: '2026-07.4', count: 25 },
        { version: '2026-07.3', count: 5 },
      ]);
      expect(r.optOutCount).toBe(3);
      expect(r.expiringSoonCount).toBe(10);
      expect(r.expiredCount).toBe(8);
      // 8 항목 중 1 항목만 100% 채움 → 평균 1/8 = 0.125
      expect(r.avgFillRate).toBeCloseTo(0.125, 5);
    });

    it('캐시 0건 → researchedCount 0 · coverageRate 0 · avgFillRate 0', async () => {
      companies.getTotalCount.mockReturnValue(100);
      const researchedQb = makeQb();
      researchedQb.getRawOne.mockResolvedValue({ companies: '0', names: '0' });
      const versionQb = makeQb();
      versionQb.getRawMany.mockResolvedValue([]);
      cacheRepo.createQueryBuilder
        .mockReturnValueOnce(researchedQb)
        .mockReturnValueOnce(versionQb);
      cacheRepo.count.mockResolvedValue(0);
      cacheRepo.find.mockResolvedValue([]);

      const r = await service.getSummary();
      expect(r.researchedCount).toBe(0);
      expect(r.researchedNames).toBe(0);
      expect(r.coverageRate).toBe(0);
      expect(r.versionDistribution).toEqual([]);
      expect(r.avgFillRate).toBe(0);
    });

    it('totalCompanies 0 → 0 나눗셈 방어 (coverageRate 0)', async () => {
      companies.getTotalCount.mockReturnValue(0);
      const researchedQb = makeQb();
      researchedQb.getRawOne.mockResolvedValue({ companies: '5', names: '5' });
      const versionQb = makeQb();
      versionQb.getRawMany.mockResolvedValue([]);
      cacheRepo.createQueryBuilder
        .mockReturnValueOnce(researchedQb)
        .mockReturnValueOnce(versionQb);
      cacheRepo.count.mockResolvedValue(0);
      cacheRepo.find.mockResolvedValue([]);

      const r = await service.getSummary();
      expect(r.coverageRate).toBe(0);
    });

    it('avgFillRate — 항목별 채움율 평균 (빈 string·null·빈 배열·빈 객체는 unfilled)', async () => {
      companies.getTotalCount.mockReturnValue(10);
      const researchedQb = makeQb();
      researchedQb.getRawOne.mockResolvedValue({ companies: '0', names: '0' });
      const versionQb = makeQb();
      versionQb.getRawMany.mockResolvedValue([]);
      cacheRepo.createQueryBuilder
        .mockReturnValueOnce(researchedQb)
        .mockReturnValueOnce(versionQb);
      cacheRepo.count.mockResolvedValue(0);
      // 1 row: businessSummary 채움 / 나머지 7 항목 unfilled 형태
      cacheRepo.find.mockResolvedValue([
        {
          aiResearch: {
            businessSummary: '유효',
            coreValues: '',
            visionMission: null,
            interviewKeywords: [],
            competitors: {},
          },
        } as unknown as CompanyResearchCache,
      ]);

      const r = await service.getSummary();
      // 8 항목 중 businessSummary(1개)만 filled=1/1, 나머지 0 → 평균 (1)/8 = 0.125
      expect(r.avgFillRate).toBeCloseTo(0.125, 5);
    });

    it('버전 분포 — count DESC 정렬 SQL 지시', async () => {
      companies.getTotalCount.mockReturnValue(10);
      const researchedQb = makeQb();
      researchedQb.getRawOne.mockResolvedValue({ companies: '0', names: '0' });
      const versionQb = makeQb();
      versionQb.getRawMany.mockResolvedValue([]);
      cacheRepo.createQueryBuilder
        .mockReturnValueOnce(researchedQb)
        .mockReturnValueOnce(versionQb);
      cacheRepo.count.mockResolvedValue(0);
      cacheRepo.find.mockResolvedValue([]);

      await service.getSummary();
      expect(versionQb.groupBy).toHaveBeenCalledWith('c.seed_version');
      expect(versionQb.orderBy).toHaveBeenCalledWith('cnt', 'DESC');
    });

    it('응답 안전성 — ai_research 원문 키 미포함', async () => {
      companies.getTotalCount.mockReturnValue(1);
      const researchedQb = makeQb();
      researchedQb.getRawOne.mockResolvedValue({ companies: '1', names: '1' });
      const versionQb = makeQb();
      versionQb.getRawMany.mockResolvedValue([]);
      cacheRepo.createQueryBuilder
        .mockReturnValueOnce(researchedQb)
        .mockReturnValueOnce(versionQb);
      cacheRepo.count.mockResolvedValue(0);
      cacheRepo.find.mockResolvedValue([]);

      const r = await service.getSummary();
      expect(Object.keys(r)).not.toContain('aiResearch');
      expect(Object.keys(r)).not.toContain('ai_research');
    });
  });

  // ── unified (조사 캐시 ∪ 지원 카드 합집합) ──
  describe('getUnified', () => {
    /** app 집계 QB + cache 집계 QB 를 각각 주입하는 헬퍼. */
    function wire(appRows: CardRaw[], cacheRows: CacheRaw[]) {
      const appQb = makeQb<Application>();
      appQb.getRawMany.mockResolvedValue(appRows);
      appRepo.createQueryBuilder.mockReturnValue(appQb);

      const cacheQb = makeQb();
      cacheQb.getRawMany.mockResolvedValue(cacheRows);
      cacheRepo.createQueryBuilder.mockReturnValue(cacheQb);

      return { appQb, cacheQb };
    }

    const D1 = new Date('2026-07-01T00:00:00Z');
    const D2 = new Date('2026-07-05T00:00:00Z');
    /** 지금으로부터 n일 뒤 만료 Date. */
    const inDays = (n: number) => new Date(Date.now() + n * 86400000);

    it('병합 — 카드만 / 조사만 / 둘다 3유형 모두 노출', async () => {
      wire(
        [
          { norm: '토스', companyName: '토스', applicants: '3', cards: '5' }, // 카드만
          {
            norm: '카카오',
            companyName: '카카오',
            applicants: '2',
            cards: '4',
          }, // 둘다
        ],
        [
          {
            norm: '카카오',
            companyName: '카카오',
            seedVersion: '2026-07.4',
            updatedAt: D1,
            expiresAt: inDays(100),
            hitCount: '12',
            optOut: false,
            researched: true,
            inferredCount: '2',
          }, // 둘다
          {
            norm: '네이버',
            companyName: '네이버',
            seedVersion: '2026-07.4',
            updatedAt: D2,
            expiresAt: inDays(90),
            hitCount: '30',
            optOut: false,
            researched: true,
            inferredCount: '0',
          }, // 조사만
        ],
      );

      const r = await service.getUnified({ sort: 'name', order: 'asc' });
      const byName = Object.fromEntries(r.items.map((i) => [i.companyName, i]));

      expect(r.total).toBe(3);
      // 카드만 — 조사 메타 null/false
      expect(byName['토스']).toEqual({
        companyName: '토스',
        researched: false,
        seedVersion: null,
        applicants: 3,
        cards: 5,
        hitCount: 0,
        updatedAt: null,
        expiresAt: null,
        inferredCount: null,
        optOut: false,
      });
      // 조사만 — 지원 카드 0
      expect(byName['네이버']).toMatchObject({
        researched: true,
        applicants: 0,
        cards: 0,
        hitCount: 30,
        inferredCount: 0,
      });
      // 둘다 — 양쪽 값 병합
      expect(byName['카카오']).toMatchObject({
        researched: true,
        applicants: 2,
        cards: 4,
        hitCount: 12,
        inferredCount: 2,
      });
    });

    it('is_sample 제외 유지 + status 화이트리스트 (수요 쿼리 조건)', async () => {
      const { appQb } = wire([], []);
      await service.getUnified({});
      expect(appQb.where).toHaveBeenCalledWith('a.status IN (:...statuses)', {
        statuses: ['IN_PROGRESS', 'PASSED', 'FAILED'],
      });
      expect(appQb.andWhere).toHaveBeenCalledWith('a.is_sample = FALSE');
      const statusesArg = appQb.where.mock.calls[0][1] as {
        statuses: string[];
      };
      expect(statusesArg.statuses).not.toContain('PLANNED');
    });

    it('삭제 카드 제외 — withDeleted 미호출 (TypeORM 자동 deleted_at IS NULL)', async () => {
      const { appQb } = wire([], []);
      await service.getUnified({});
      expect(appQb.withDeleted).not.toHaveBeenCalled();
    });

    // ── 필터 5종 ──
    const base = (over: Partial<CacheRaw> & { norm: string }): CacheRaw => ({
      companyName: over.norm,
      seedVersion: null,
      updatedAt: D1,
      expiresAt: inDays(100),
      hitCount: '0',
      optOut: false,
      researched: true,
      inferredCount: '0',
      ...over,
    });

    it('필터 all — 전부', async () => {
      wire(
        [{ norm: 'x', companyName: 'X', applicants: '1', cards: '1' }],
        [base({ norm: 'y', researched: false })],
      );
      const r = await service.getUnified({ filter: 'all' });
      expect(r.total).toBe(2);
    });

    it('필터 unresearched — researched=false 만', async () => {
      wire(
        [{ norm: 'toss', companyName: 'Toss', applicants: '1', cards: '1' }], // 카드만 → 미조사
        [
          base({ norm: 'kakao', researched: true }),
          base({ norm: 'baemin', researched: false }),
        ],
      );
      const r = await service.getUnified({ filter: 'unresearched' });
      expect(r.items.map((i) => i.companyName).sort()).toEqual([
        'Toss',
        'baemin',
      ]);
    });

    it('필터 expiring — opt_out=false + 30일 내 만료', async () => {
      wire(
        [],
        [
          base({ norm: 'a', expiresAt: inDays(10) }), // 임박 → 포함
          base({ norm: 'b', expiresAt: inDays(200) }), // 여유 → 제외
          base({ norm: 'c', expiresAt: inDays(-3) }), // 만료 → 제외
          base({ norm: 'd', expiresAt: inDays(5), optOut: true }), // optout → 제외
        ],
      );
      const r = await service.getUnified({ filter: 'expiring' });
      expect(r.items.map((i) => i.companyName)).toEqual(['a']);
    });

    it('필터 expired — opt_out=false + 이미 만료', async () => {
      wire(
        [],
        [
          base({ norm: 'a', expiresAt: inDays(-1) }), // 만료 → 포함
          base({ norm: 'b', expiresAt: inDays(10) }), // 미만료 → 제외
          base({ norm: 'c', expiresAt: inDays(-1), optOut: true }), // optout → 제외
        ],
      );
      const r = await service.getUnified({ filter: 'expired' });
      expect(r.items.map((i) => i.companyName)).toEqual(['a']);
    });

    it('필터 optout — opt_out=true 만', async () => {
      wire(
        [{ norm: 'x', companyName: 'X', applicants: '1', cards: '1' }],
        [base({ norm: 'a', optOut: true }), base({ norm: 'b', optOut: false })],
      );
      const r = await service.getUnified({ filter: 'optout' });
      expect(r.items.map((i) => i.companyName)).toEqual(['a']);
    });

    // ── 정렬 6종 × asc/desc 대표 ──
    it('정렬 applicants asc / desc', async () => {
      const rows: CardRaw[] = [
        { norm: 'a', companyName: 'A', applicants: '1', cards: '1' },
        { norm: 'b', companyName: 'B', applicants: '3', cards: '1' },
        { norm: 'c', companyName: 'C', applicants: '2', cards: '1' },
      ];
      wire(rows, []);
      const asc = await service.getUnified({
        sort: 'applicants',
        order: 'asc',
      });
      expect(asc.items.map((i) => i.applicants)).toEqual([1, 2, 3]);
      wire(rows, []);
      const desc = await service.getUnified({
        sort: 'applicants',
        order: 'desc',
      });
      expect(desc.items.map((i) => i.applicants)).toEqual([3, 2, 1]);
    });

    it('정렬 cards desc', async () => {
      wire(
        [
          { norm: 'a', companyName: 'A', applicants: '1', cards: '5' },
          { norm: 'b', companyName: 'B', applicants: '1', cards: '9' },
        ],
        [],
      );
      const r = await service.getUnified({ sort: 'cards', order: 'desc' });
      expect(r.items.map((i) => i.cards)).toEqual([9, 5]);
    });

    it('정렬 hitCount asc', async () => {
      wire(
        [],
        [
          base({ norm: 'a', hitCount: '10' }),
          base({ norm: 'b', hitCount: '3' }),
        ],
      );
      const r = await service.getUnified({ sort: 'hitCount', order: 'asc' });
      expect(r.items.map((i) => i.hitCount)).toEqual([3, 10]);
    });

    it('정렬 updatedAt desc', async () => {
      wire(
        [],
        [
          base({ norm: 'a', updatedAt: D1 }),
          base({ norm: 'b', updatedAt: D2 }),
        ],
      );
      const r = await service.getUnified({ sort: 'updatedAt', order: 'desc' });
      expect(r.items.map((i) => i.companyName)).toEqual(['b', 'a']);
    });

    it('정렬 inferredCount desc', async () => {
      wire(
        [],
        [
          base({ norm: 'a', inferredCount: '1' }),
          base({ norm: 'b', inferredCount: '4' }),
        ],
      );
      const r = await service.getUnified({
        sort: 'inferredCount',
        order: 'desc',
      });
      expect(r.items.map((i) => i.inferredCount)).toEqual([4, 1]);
    });

    it('정렬 name asc — 정규화 소문자 기준', async () => {
      wire(
        [
          {
            norm: 'banana',
            companyName: 'Banana',
            applicants: '1',
            cards: '1',
          },
          { norm: 'apple', companyName: 'Apple', applicants: '1', cards: '1' },
        ],
        [],
      );
      const r = await service.getUnified({ sort: 'name', order: 'asc' });
      expect(r.items.map((i) => i.companyName)).toEqual(['Apple', 'Banana']);
    });

    it('NULLS LAST — null 정렬값은 order 무관 항상 뒤', async () => {
      // 카드만(hitCount 0 이지만 updatedAt null) vs 조사(updatedAt 있음)
      wire(
        [{ norm: 'card', companyName: 'Card', applicants: '9', cards: '9' }], // updatedAt null
        [base({ norm: 'res', updatedAt: D1 })],
      );
      const asc = await service.getUnified({ sort: 'updatedAt', order: 'asc' });
      expect(asc.items.map((i) => i.companyName)).toEqual(['res', 'Card']);
      wire(
        [{ norm: 'card', companyName: 'Card', applicants: '9', cards: '9' }],
        [base({ norm: 'res', updatedAt: D1 })],
      );
      const desc = await service.getUnified({
        sort: 'updatedAt',
        order: 'desc',
      });
      expect(desc.items.map((i) => i.companyName)).toEqual(['res', 'Card']);
    });

    it('검색 — 정규화 소문자 includes', async () => {
      wire(
        [
          { norm: 'kakao', companyName: 'Kakao', applicants: '1', cards: '1' },
          { norm: 'naver', companyName: 'Naver', applicants: '1', cards: '1' },
        ],
        [],
      );
      const r = await service.getUnified({ search: 'KAK' });
      expect(r.items.map((i) => i.companyName)).toEqual(['Kakao']);
      expect(r.total).toBe(1);
    });

    it('페이지 범위 초과 → 빈 items (total 유지)', async () => {
      const rows: CardRaw[] = Array.from({ length: 5 }, (_, i) => ({
        norm: `c${i}`,
        companyName: `회사${i}`,
        applicants: '1',
        cards: '1',
      }));
      wire(rows, []);
      const r = await service.getUnified({ page: 100, limit: 20 });
      expect(r.items).toEqual([]);
      expect(r.total).toBe(5);
      expect(r.page).toBe(100);
    });

    it('페이지네이션 — limit 슬라이스', async () => {
      const rows: CardRaw[] = Array.from({ length: 25 }, (_, i) => ({
        norm: `c${String(i).padStart(2, '0')}`,
        companyName: `회사${String(i).padStart(2, '0')}`,
        applicants: '1',
        cards: '1',
      }));
      wire(rows, []);
      const r = await service.getUnified({
        page: 2,
        limit: 10,
        sort: 'name',
        order: 'asc',
      });
      expect(r.items).toHaveLength(10);
      expect(r.total).toBe(25);
      expect(r.items[0].companyName).toBe('회사10');
    });

    it('응답 안전성 — ai_research 원문·user_id 미노출', async () => {
      const { appQb, cacheQb } = wire(
        [{ norm: 'a', companyName: 'A', applicants: '1', cards: '1' }],
        [base({ norm: 'a' })],
      );
      const r = await service.getUnified({});

      // ai_research 원문 컬럼(c.ai_research)·user_id 를 통째로 select 하지 않았는지
      const cacheSelected = [
        ...cacheQb.select.mock.calls.map((c) => String(c[0])),
        ...cacheQb.addSelect.mock.calls.map((c) => String(c[0])),
      ];
      expect(cacheSelected).not.toContain('c.ai_research');
      const appSelected = [
        ...appQb.select.mock.calls.map((c) => String(c[0])),
        ...appQb.addSelect.mock.calls.map((c) => String(c[0])),
      ];
      expect(appSelected).not.toContain('a.user_id');

      const keys = Object.keys(r.items[0]);
      expect(keys).not.toContain('aiResearch');
      expect(keys).not.toContain('ai_research');
      expect(keys).not.toContain('userId');
      expect(keys).not.toContain('user_id');
      expect(keys.sort()).toEqual([
        'applicants',
        'cards',
        'companyName',
        'expiresAt',
        'hitCount',
        'inferredCount',
        'optOut',
        'researched',
        'seedVersion',
        'updatedAt',
      ]);
    });

    it('빈 결과 → items [] · total 0', async () => {
      wire([], []);
      const r = await service.getUnified({ search: '없는회사' });
      expect(r.items).toEqual([]);
      expect(r.total).toBe(0);
    });
  });
});
