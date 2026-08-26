import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock, MockProxy } from 'jest-mock-extended';
import {
  CompanyResearchStatusService,
  RESEARCH_EXPORT_MAX,
} from './company-research-status.service';
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
  /** 지원 예정(PLANNED) 분 — 안 주면 0 (= 전부 진행 중) */
  plannedApplicants?: string | number;
  plannedCards?: string | number;
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
    // 실존 판정 소스 — 개별 테스트에서 필요하면 덮어쓴다
    companies.getAllNames.mockReturnValue([]);

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
        plannedApplicants: 0,
        plannedCards: 0,
        demandStage: 'applied',
        hitCount: 0,
        updatedAt: null,
        expiresAt: null,
        inferredCount: null,
        optOut: false,
        knownCompany: false,
        similarTo: null,
      });
      // 조사만 — 지원 카드 0
      expect(byName['네이버']).toMatchObject({
        researched: true,
        applicants: 0,
        cards: 0,
        // 🔴 카드 0장은 「예정」이 아니라 **판정 대상 아님**이다.
        //    `plannedCards === cards` 를 그대로 쓰면 0 === 0 이라 전부 예정이 된다.
        demandStage: null,
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
      // 🔴 `PLANNED` 는 2026-08-26 에 **의도적으로 추가**됐다. 그전에는 지원 예정만 있는
      //    회사가 조사 목록에 아예 안 떠서, 아직 지원 안 한 회사를 조사 대상으로 올릴
      //    방법이 없었다. 이 단언은 화이트리스트를 **정확히** 못 박아, 상태가 조용히
      //    늘거나 줄면 실패하게 만든다 (예전엔 `not.toContain('PLANNED')` 로 막고 있었다).
      expect(appQb.where).toHaveBeenCalledWith('a.status IN (:...statuses)', {
        statuses: ['PLANNED', 'IN_PROGRESS', 'PASSED', 'FAILED'],
      });
      expect(appQb.andWhere).toHaveBeenCalledWith('a.is_sample = FALSE');
      const statusesArg = appQb.where.mock.calls[0][1] as {
        statuses: string[];
      };
      // 온보딩 샘플과 함께 **정의된 4개 외의 값이 새는지**를 계속 지킨다
      expect(statusesArg.statuses).toHaveLength(4);
    });

    // ── 지원 예정(PLANNED) 포함 · demandStage 판정 (2026-08-26) ──
    describe('demandStage — 「지원 예정만 있는 회사」를 가른다', () => {
      it('🔴 예정만 있으면 planned — 진행 중 카드가 0장인 경우', async () => {
        wire(
          [
            {
              norm: '한빛',
              companyName: '한빛',
              applicants: '2',
              cards: '3',
              plannedApplicants: '2',
              plannedCards: '3',
            },
          ],
          [],
        );
        const r = await service.getUnified({});
        expect(r.items[0]).toMatchObject({
          applicants: 2,
          cards: 3,
          plannedApplicants: 2,
          plannedCards: 3,
          demandStage: 'planned',
        });
      });

      it('🔴 진행 중이 섞여 있으면 applied — 예정이 있어도 등급을 내리지 않는다', async () => {
        // 이미 실제 지원이 시작된 회사다. 「예정 카드가 하나라도 있으면 예정」으로
        // 만들면 조사 우선순위가 거꾸로 뒤집힌다.
        wire(
          [
            {
              norm: '토스',
              companyName: '토스',
              applicants: '5',
              cards: '7',
              plannedApplicants: '2',
              plannedCards: '2',
            },
          ],
          [],
        );
        const r = await service.getUnified({});
        expect(r.items[0]).toMatchObject({
          cards: 7,
          plannedCards: 2,
          demandStage: 'applied',
        });
      });

      it('예정이 0장이면 applied', async () => {
        wire(
          [
            {
              norm: '네이버',
              companyName: '네이버',
              applicants: '3',
              cards: '4',
              plannedApplicants: '0',
              plannedCards: '0',
            },
          ],
          [],
        );
        expect((await service.getUnified({})).items[0]).toMatchObject({
          demandStage: 'applied',
        });
      });

      it('🔴 카드 0장(조사 캐시 전용 행) → null · 「예정」이 아니다', async () => {
        wire([], [base({ norm: '카카오' })]);
        expect((await service.getUnified({})).items[0]).toMatchObject({
          cards: 0,
          plannedCards: 0,
          demandStage: null,
        });
      });

      it('🔴 예정 컬럼이 안 오면 NaN 이 아니라 0 — 오분류로 이어지는 조용한 결함', async () => {
        // raw 쿼리 결과는 신뢰 경계 밖이다. `Number(undefined)` = NaN 이고
        // `NaN === NaN` 은 false 라, 방어가 없으면 예정만 있는 회사가 「지원 중」이 된다.
        wire(
          [{ norm: '대성', companyName: '대성', applicants: '1', cards: '1' }],
          [],
        );
        expect((await service.getUnified({})).items[0]).toMatchObject({
          plannedApplicants: 0,
          plannedCards: 0,
          demandStage: 'applied',
        });
      });
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
        'demandStage',
        'expiresAt',
        'hitCount',
        'inferredCount',
        'knownCompany',
        'optOut',
        'plannedApplicants',
        'plannedCards',
        'researched',
        'seedVersion',
        'similarTo',
        'updatedAt',
      ]);
    });

    it('빈 결과 → items [] · total 0', async () => {
      wire([], []);
      const r = await service.getUnified({ search: '없는회사' });
      expect(r.items).toEqual([]);
      expect(r.total).toBe(0);
    });

    // ── 실존 여부 배지 + 유사명 제안 ──
    describe('실존 판정 (knownCompany · similarTo)', () => {
      const DART = ['카카오', '네이버', '삼성전자', '한국가스공사'];
      const card = (name: string): CardRaw => ({
        norm: name.toLowerCase(),
        companyName: name,
        applicants: '1',
        cards: '1',
      });

      it('companies.json 에 있는 이름 → knownCompany true · 유사명 계산 안 함', async () => {
        companies.getAllNames.mockReturnValue(DART);
        wire([card('카카오')], []);
        const r = await service.getUnified({});
        expect(r.items[0]).toMatchObject({
          knownCompany: true,
          similarTo: null,
        });
      });

      it('대소문자·공백만 다른 표기도 실존으로 본다 (병합 키와 같은 정규화)', async () => {
        companies.getAllNames.mockReturnValue(['LG에너지솔루션']);
        wire([card('  lg에너지솔루션 ')], []);
        const r = await service.getUnified({});
        expect(r.items[0].knownCompany).toBe(true);
      });

      it('🔴 목록 밖 + 오타 → knownCompany false · 가까운 이름 제안', async () => {
        companies.getAllNames.mockReturnValue(DART);
        wire([card('까까오')], []);
        const r = await service.getUnified({});
        expect(r.items[0]).toMatchObject({
          knownCompany: false,
          similarTo: '카카오',
        });
      });

      it('🔴 목록 밖 + 먼 이름 → 제안 없음 (비상장 실존 회사를 오타로 몰지 않는다)', async () => {
        companies.getAllNames.mockReturnValue(DART);
        wire([card('한솔로지스틱스')], []);
        const r = await service.getUnified({});
        expect(r.items[0]).toMatchObject({
          knownCompany: false,
          similarTo: null,
        });
      });

      it('companies.json 미로딩(빈 목록) → 전부 목록 밖 · 제안 없음 (크래시 X)', async () => {
        companies.getAllNames.mockReturnValue([]);
        wire([card('카카오')], []);
        const r = await service.getUnified({});
        expect(r.items[0]).toMatchObject({
          knownCompany: false,
          similarTo: null,
        });
      });

      // 🔴 성능 — 인덱스를 행마다 만들면 한 페이지에 3,798개 × 20행을 훑는다
      it('인덱스는 요청당 1회만 만든다 (getAllNames 1회)', async () => {
        companies.getAllNames.mockReturnValue(DART);
        wire(
          Array.from({ length: 25 }, (_, i) => card(`회사${i}`)),
          [],
        );
        await service.getUnified({ page: 1, limit: 20 });
        expect(companies.getAllNames).toHaveBeenCalledTimes(1);
      });

      // 🔴 판정 대상은 **현재 페이지 행만**. 전 범위(25행)에 돌리면 안 된다
      it('판정은 현재 페이지 행에만 붙는다 (25행 중 2페이지 5행)', async () => {
        companies.getAllNames.mockReturnValue(DART);
        wire(
          Array.from({ length: 25 }, (_, i) =>
            card(`회사${String(i).padStart(2, '0')}`),
          ),
          [],
        );
        const r = await service.getUnified({
          page: 3,
          limit: 10,
          sort: 'name',
          order: 'asc',
        });
        expect(r.total).toBe(25);
        expect(r.items).toHaveLength(5);
        expect(r.items.every((i) => 'knownCompany' in i)).toBe(true);
      });

      it('빈 페이지면 인덱스를 아예 만들지 않는다 (getAllNames 0회)', async () => {
        companies.getAllNames.mockReturnValue(DART);
        wire([card('카카오')], []);
        const r = await service.getUnified({ page: 50, limit: 20 });
        expect(r.items).toEqual([]);
        expect(companies.getAllNames).not.toHaveBeenCalled();
      });
    });
  });

  // ── 전체 내보내기 ──
  describe('getExport', () => {
    function wire(appRows: CardRaw[], cacheRows: CacheRaw[]) {
      const appQb = makeQb<Application>();
      appQb.getRawMany.mockResolvedValue(appRows);
      appRepo.createQueryBuilder.mockReturnValue(appQb);
      const cacheQb = makeQb();
      cacheQb.getRawMany.mockResolvedValue(cacheRows);
      cacheRepo.createQueryBuilder.mockReturnValue(cacheQb);
    }

    const cards = (
      n: number,
      over: (i: number) => Partial<CardRaw> = () => ({}),
    ) =>
      Array.from({ length: n }, (_, i) => ({
        norm: `c${String(i).padStart(3, '0')}`,
        companyName: `회사${String(i).padStart(3, '0')}`,
        applicants: '1',
        cards: '1',
        ...over(i),
      }));

    // 🔴 이 기능의 존재 이유 — 지금까지는 현재 페이지 행만 담겼다
    it('🔴 현재 페이지가 아니라 전 범위를 담는다 (25행 · limit 20 무시)', async () => {
      wire(cards(25), []);
      const r = await service.getExport({ page: 1, limit: 20 });
      expect(r.items).toHaveLength(25);
      expect(r.total).toBe(25);
      expect(r.truncated).toBe(false);
    });

    it('필터가 반영된다 — unresearched 는 조사 없는 행만', async () => {
      wire(
        [
          { norm: 'toss', companyName: 'Toss', applicants: '1', cards: '1' },
          { norm: 'kakao', companyName: 'Kakao', applicants: '1', cards: '1' },
        ],
        [
          {
            norm: 'kakao',
            companyName: 'Kakao',
            seedVersion: '2026-07.4',
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 86400000),
            hitCount: '1',
            optOut: false,
            researched: true,
            inferredCount: '0',
          },
        ],
      );
      const r = await service.getExport({ filter: 'unresearched' });
      expect(r.items.map((i) => i.companyName)).toEqual(['Toss']);
      expect(r.total).toBe(1);
    });

    it('정렬이 반영된다 — 지원자 내림차순', async () => {
      wire(
        [
          { norm: 'a', companyName: 'A', applicants: '1', cards: '1' },
          { norm: 'b', companyName: 'B', applicants: '9', cards: '1' },
          { norm: 'c', companyName: 'C', applicants: '5', cards: '1' },
        ],
        [],
      );
      const r = await service.getExport({ sort: 'applicants', order: 'desc' });
      expect(r.items.map((i) => i.companyName)).toEqual(['B', 'C', 'A']);
    });

    it('검색이 반영된다', async () => {
      wire(
        [
          { norm: 'kakao', companyName: 'Kakao', applicants: '1', cards: '1' },
          { norm: 'naver', companyName: 'Naver', applicants: '1', cards: '1' },
        ],
        [],
      );
      const r = await service.getExport({ search: 'KAK' });
      expect(r.items.map((i) => i.companyName)).toEqual(['Kakao']);
    });

    // 🔴 조용한 절단이 최악 — 조사 대상을 놓치고도 모른다
    it('🔴 상한 초과 → 정렬 순 상위만 담고 total·truncated 로 알린다', async () => {
      wire(
        cards(600, (i) => ({ applicants: String(600 - i) })),
        [],
      );
      const r = await service.getExport({ sort: 'applicants', order: 'desc' });
      expect(r.items).toHaveLength(RESEARCH_EXPORT_MAX);
      expect(r.total).toBe(600);
      expect(r.truncated).toBe(true);
      expect(r.limit).toBe(RESEARCH_EXPORT_MAX);
      // 잘린 건 하위 100개 — 상위(지원자 많은 쪽)는 남아 있어야 한다
      expect(r.items[0].applicants).toBe(600);
    });

    it('상한 경계 — 정확히 상한이면 truncated false', async () => {
      wire(cards(RESEARCH_EXPORT_MAX), []);
      const r = await service.getExport({});
      expect(r.items).toHaveLength(RESEARCH_EXPORT_MAX);
      expect(r.truncated).toBe(false);
    });

    it('빈 목록 → items [] · total 0 · truncated false', async () => {
      wire([], []);
      const r = await service.getExport({ filter: 'unresearched' });
      expect(r.items).toEqual([]);
      expect(r.total).toBe(0);
      expect(r.truncated).toBe(false);
    });

    // 응답 안전 — 내보내기는 파일로 나가므로 노출 범위를 더 좁게 잡는다
    it('회사명·지원자·카드 3열만 — 조사 원문·user_id·조사 메타 미노출', async () => {
      wire([{ norm: 'a', companyName: 'A', applicants: '2', cards: '3' }], []);
      const r = await service.getExport({});
      expect(Object.keys(r.items[0]).sort()).toEqual([
        'applicants',
        'cards',
        'companyName',
      ]);
    });

    it('내보내기에는 유사명 계산을 하지 않는다 (전 범위 500행에 돌리면 비싸다)', async () => {
      companies.getAllNames.mockReturnValue(['카카오']);
      wire(cards(30), []);
      await service.getExport({});
      expect(companies.getAllNames).not.toHaveBeenCalled();
    });
  });
});
