/**
 * W2 — CompaniesService 자동완성 spec.
 *
 * cover: prefix vs contains / 가나다 정렬 / 조사 시드 소스 / 소스 우선순위 dedupe (dart>research,
 *        research>user_added) / 정규화 키 dedupe (대소문자 표기 차) / 조사 제외 조건
 *        (별칭·opt-out·빈 조사) / 빈 q → [] / boost 제거 회귀 / limit cap / LIKE escape 2소스 /
 *        한글+영문 mixed / source 필드 / 사용자 누적
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { Application } from '../applications/application.entity';
import { CompanyResearchCache } from '../interview-prep/entities/company-research-cache.entity';
import { CompaniesService } from './companies.service';

/** 두 DB 소스가 쓰는 QueryBuilder 메서드를 전부 chainable 로 흉내낸 mock */
function makeQb(rows: unknown[]) {
  const qb = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  for (const chainable of [
    qb.select,
    qb.addSelect,
    qb.where,
    qb.andWhere,
    qb.groupBy,
    qb.orderBy,
    qb.limit,
  ]) {
    chainable.mockReturnValue(qb);
  }
  return qb;
}

type QbMock = ReturnType<typeof makeQb>;

/** 부분 구현 mock 을 QueryBuilder 자리에 꽂기 위한 **단일** 캐스트 지점 */
function asQueryBuilder<T extends ObjectLiteral>(
  qb: QbMock,
): SelectQueryBuilder<T> {
  return qb as unknown as SelectQueryBuilder<T>;
}

/** where·andWhere 로 넘어간 조건 문자열 전부 (조사 필터 검증용) */
function conditionsOf(qb: QbMock): string[] {
  return [...qb.where.mock.calls, ...qb.andWhere.mock.calls].map((c) =>
    String(c[0]),
  );
}

describe('CompaniesService', () => {
  let service: CompaniesService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let researchRepo: jest.Mocked<Repository<CompanyResearchCache>>;
  let researchQb: QbMock;
  let appQb: QbMock;

  /** 두 DB 소스의 반환 행을 한 번에 세팅 */
  function setSources(opts: {
    research?: { name: string }[];
    userAdded?: { name: string; count: number }[];
  }) {
    researchQb = makeQb(opts.research ?? []);
    appQb = makeQb(opts.userAdded ?? []);
    researchRepo.createQueryBuilder.mockReturnValue(
      asQueryBuilder<CompanyResearchCache>(researchQb),
    );
    appRepo.createQueryBuilder.mockReturnValue(
      asQueryBuilder<Application>(appQb),
    );
  }

  beforeEach(async () => {
    appRepo = mock<Repository<Application>>();
    researchRepo = mock<Repository<CompanyResearchCache>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompaniesService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        {
          provide: getRepositoryToken(CompanyResearchCache),
          useValue: researchRepo,
        },
      ],
    }).compile();

    service = module.get<CompaniesService>(CompaniesService);

    // spec — 생성자가 실제 companies.json(수천 건)을 읽어버리므로 고정 목록으로 교체한다
    (service as unknown as { companies: unknown[] }).companies = [
      {
        name: '네이버',
        domain: 'naver.com',
        industry: 'IT 서비스',
        market: 'KOSPI',
      },
      {
        name: '네이처바이오',
        domain: undefined,
        industry: '제약·바이오',
        market: 'KOSDAQ',
      },
      {
        name: '카카오',
        domain: 'kakao.com',
        industry: '인터넷',
        market: 'KOSPI',
      },
      // '카' 가 **가운데** 들어간 회사 — prefix > contains 정렬 검증용
      {
        name: '롯데카드',
        domain: undefined,
        industry: '금융',
        market: undefined,
      },
      {
        name: 'LG에너지솔루션',
        domain: 'lgensol.com',
        industry: '화학',
        market: 'KOSPI',
      },
      {
        name: '한국가스공사',
        domain: 'kogas.or.kr',
        industry: '공공기관',
        market: undefined,
      },
      {
        name: '한진해운',
        domain: undefined,
        industry: '운송',
        market: undefined,
      },
      {
        name: '한화생명',
        domain: undefined,
        industry: '보험',
        market: undefined,
      },
      {
        name: '한미약품',
        domain: undefined,
        industry: '제약',
        market: 'KOSPI',
      },
      {
        name: '한국조폐공사',
        domain: undefined,
        industry: '공공기관',
        market: undefined,
      },
      {
        name: '한국전력공사',
        domain: undefined,
        industry: '공공기관',
        market: undefined,
      },
      {
        name: '한국타이어',
        domain: undefined,
        industry: '제조',
        market: 'KOSPI',
      },
      {
        name: '하나금융지주',
        domain: undefined,
        industry: '금융',
        market: 'KOSPI',
      },
    ];

    setSources({});
  });

  describe('autocomplete', () => {
    it('정상 prefix match → "네이버" 가 "네이" 검색의 첫 결과 (prefix > contains)', async () => {
      const result = await service.autocomplete('네이');

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].name).toBe('네이버');
      expect(result[0].source).toBe('dart');
      expect(result[0].domain).toBe('naver.com');
    });

    it('contains match — q="카오" 가 "카카오" 매칭', async () => {
      const result = await service.autocomplete('카오');

      expect(result.some((r) => r.name === '카카오')).toBe(true);
    });

    it('prefix 가 contains 보다 위 — q="카" → 카카오(prefix) > 롯데카드(contains)', async () => {
      const result = await service.autocomplete('카');

      const names = result.map((r) => r.name);
      expect(names.indexOf('카카오')).toBeLessThan(names.indexOf('롯데카드'));
    });

    it('같은 급이면 회사명 가나다 — q="한국" → 한국가스공사 가 먼저', async () => {
      const result = await service.autocomplete('한국');

      expect(result[0].name).toBe('한국가스공사');
      expect(result.map((r) => r.name)).toEqual(
        [...result.map((r) => r.name)].sort((a, b) => a.localeCompare(b, 'ko')),
      );
    });

    /**
     * 🔴 조사 시드 소스 — 이 소스가 붙는 이유는 「조사가 준비된 회사」를 먼저 고르게 해서
     * 타이핑을 줄이고 `로쏘(성심당` 류 오염 표기를 애초에 덜 만들게 하기 위함이다.
     */
    it('조사 시드 — DART 에 없는 회사가 검색에 잡힌다 (source=research)', async () => {
      setSources({ research: [{ name: '대전성모병원' }] });

      const result = await service.autocomplete('대전');

      const found = result.find((r) => r.name === '대전성모병원');
      expect(found).toBeDefined();
      expect(found?.source).toBe('research');
    });

    it('조사 쿼리 — 별칭 행·opt-out·빈 조사는 제외한다 (골라도 보여줄 알맹이가 없다)', async () => {
      await service.autocomplete('대전');

      const conditions = conditionsOf(researchQb).join(' | ');
      expect(conditions).toContain('c.is_alias = false');
      expect(conditions).toContain('c.opt_out = false');
      expect(conditions).toContain('c.ai_research IS NOT NULL');
      expect(conditions).toContain("c.ai_research <> '{}'::jsonb");
    });

    it('dedupe 우선순위 — 같은 이름이 dart·research 둘 다면 dart 가 이긴다', async () => {
      setSources({ research: [{ name: '네이버' }] });

      const result = await service.autocomplete('네이버');

      expect(result.filter((r) => r.name === '네이버')).toHaveLength(1);
      expect(result.find((r) => r.name === '네이버')?.source).toBe('dart');
    });

    it('dedupe 우선순위 — 같은 이름이 research·user_added 둘 다면 research 가 이긴다', async () => {
      setSources({
        research: [{ name: '대전성모병원' }],
        userAdded: [{ name: '대전성모병원', count: 7 }],
      });

      const result = await service.autocomplete('대전');

      expect(result.filter((r) => r.name === '대전성모병원')).toHaveLength(1);
      expect(result.find((r) => r.name === '대전성모병원')?.source).toBe(
        'research',
      );
    });

    /**
     * 조사 캐시는 회사명을 정규화(lowercase)해 저장한다. 정규화 키 dedupe 가 없으면
     * `LG에너지솔루션` 과 `lg에너지솔루션` 이 두 줄로 보이고, 사용자가 소문자 쪽을 고르면
     * 카드 회사명이 소문자로 박힌다.
     */
    it('dedupe 는 정규화 키(trim+lowercase) — 표기만 다른 같은 회사는 한 줄, DART 표기가 남는다', async () => {
      setSources({
        research: [{ name: 'lg에너지솔루션' }],
        userAdded: [{ name: '  LG에너지솔루션  ', count: 3 }],
      });

      const result = await service.autocomplete('lg');

      const lg = result.filter((r) =>
        r.name.toLowerCase().trim().includes('lg'),
      );
      expect(lg).toHaveLength(1);
      expect(lg[0].name).toBe('LG에너지솔루션');
      expect(lg[0].source).toBe('dart');
    });

    /**
     * 🔴 빈 검색어는 `[]`. 예전 boost 경로는 `industry` 가 0% 라 항상 0개를 돌려주던
     * 죽은 코드였고, boost 를 걷어낸 뒤엔 「아무 기준 없이 아무거나」밖에 남지 않는다.
     */
    it('빈 q → [] (DB 조회조차 안 한다)', async () => {
      const result = await service.autocomplete('');

      expect(result).toEqual([]);
      expect(researchRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(appRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('공백만 있는 q → [] (trim 후 빈 문자열)', async () => {
      const result = await service.autocomplete('   ');

      expect(result).toEqual([]);
    });

    it('q 미전송(undefined) → []', async () => {
      const result = await service.autocomplete(undefined);

      expect(result).toEqual([]);
    });

    it('boost 회귀 — 세 소스 어디에도 boost 필드가 없다 (죽은 랭킹 신호 제거)', async () => {
      setSources({
        research: [{ name: '한국조사기관' }],
        userAdded: [{ name: '한국커스텀스타트업', count: 2 }],
      });

      const result = await service.autocomplete('한국');

      expect(new Set(result.map((r) => r.source))).toEqual(
        new Set(['dart', 'research', 'user_added']),
      );
      expect(result.every((r) => !('boost' in r))).toBe(true);
    });

    it('사용자 누적 — DART·조사에 없는 회사가 결과 포함 (userCount 유지)', async () => {
      setSources({ userAdded: [{ name: '스타트업X', count: 5 }] });

      const result = await service.autocomplete('스타트업');

      const userAdded = result.find((r) => r.source === 'user_added');
      expect(userAdded?.name).toBe('스타트업X');
      expect(userAdded?.userCount).toBe(5);
    });

    it('limit cap — limit=20 → 10 max', async () => {
      const result = await service.autocomplete('한', 20);

      expect(result.length).toBeLessThanOrEqual(10);
    });

    it('cap 은 세 소스 합계 기준 — 앞 소스가 자리를 채우면 뒤 소스가 잘린다', async () => {
      setSources({
        research: Array.from({ length: 5 }, (_, i) => ({
          name: `조사회사${i}`,
        })),
        userAdded: Array.from({ length: 5 }, (_, i) => ({
          name: `누적회사${i}`,
          count: i,
        })),
      });

      // q="한" → dart 7건 + research 5건 + user_added 5건 = 17건 후보, cap 10
      const result = await service.autocomplete('한', 10);

      expect(result).toHaveLength(10);
      expect(result.filter((r) => r.source === 'dart')).toHaveLength(7);
      expect(result.filter((r) => r.source === 'research')).toHaveLength(3);
      expect(result.some((r) => r.source === 'user_added')).toBe(false);
    });

    it('한글+영문 mixed — q="LG" → "LG에너지솔루션" 매칭', async () => {
      const result = await service.autocomplete('LG');

      expect(result.some((r) => r.name === 'LG에너지솔루션')).toBe(true);
    });

    it('LIKE wildcard escape — q="50%할인" → 두 DB 소스 모두 escape 된 값 전달', async () => {
      await service.autocomplete('50%할인');

      for (const qb of [researchQb, appQb]) {
        const ilikeCall = qb.andWhere.mock.calls.find((c) =>
          String(c[0]).includes('ILIKE'),
        );
        expect(ilikeCall).toBeDefined();
        expect(ilikeCall?.[1]).toEqual({ q: String.raw`%50\%할인%` });
      }
    });

    it('source 필드 3종 — dart / research / user_added 가 각각 정확히 표기된다', async () => {
      setSources({
        research: [{ name: '한국조사기관' }],
        userAdded: [{ name: '한국커스텀스타트업', count: 3 }],
      });

      const result = await service.autocomplete('한국');

      expect(result.find((r) => r.name === '한국가스공사')?.source).toBe(
        'dart',
      );
      expect(result.find((r) => r.name === '한국조사기관')?.source).toBe(
        'research',
      );
      expect(result.find((r) => r.name === '한국커스텀스타트업')?.source).toBe(
        'user_added',
      );
    });
  });

  describe('getDetailsByName / getDetailsByCorpCode (DART 회사 정보)', () => {
    const ORIG_KEY = process.env.DART_API_KEY;
    const ORIG_FETCH = global.fetch;

    beforeEach(() => {
      // corpCode 매핑 직접 주입 (load 시 build 되는 Map 우회)
      (
        service as unknown as { corpCodeByName: Map<string, string> }
      ).corpCodeByName = new Map([
        ['네이버', '00266961'],
        ['카카오', '00540538'],
      ]);
      // cache 비움
      (
        service as unknown as { detailsCache: Map<string, unknown> }
      ).detailsCache = new Map();
      process.env.DART_API_KEY = 'test-key';
    });

    afterEach(() => {
      process.env.DART_API_KEY = ORIG_KEY;
      global.fetch = ORIG_FETCH;
    });

    function mockFetchOnce(responses: Array<{ ok: boolean; json: unknown }>) {
      let i = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        const r = responses[i++] ?? responses[responses.length - 1];
        return Promise.resolve({
          ok: r.ok,
          status: r.ok ? 200 : 500,
          json: () => Promise.resolve(r.json),
        });
      });
    }

    it('매핑되지 않은 회사명 → NotFoundException', async () => {
      await expect(service.getDetailsByName('알수없는회사')).rejects.toThrow(
        /corp_code/,
      );
    });

    it('DART_API_KEY 미설정 → ServiceUnavailableException (일반화 메시지)', async () => {
      delete process.env.DART_API_KEY;
      await expect(service.getDetailsByName('네이버')).rejects.toThrow(
        /잠시 후 다시 시도/,
      );
    });

    it('정상 호출 — profile + financials + disclosures 통합 반환 + fetchedAt 포함', async () => {
      mockFetchOnce([
        {
          ok: true,
          json: {
            status: '000',
            corp_name: 'NAVER',
            ceo_nm: '최수연',
            est_dt: '19990602',
            adres: '경기 성남시',
            hm_url: 'www.navercorp.com',
            induty: '포털 및 기타 인터넷 정보매개 서비스업',
            induty_code: '63112',
            phn_no: '1588-3820',
          },
        },
        {
          ok: true,
          json: {
            status: '000',
            list: [
              { rcept_no: 'A1', report_nm: '분기보고서', rcept_dt: '20251114' },
              {
                rcept_no: 'A2',
                report_nm: '주요사항보고서',
                rcept_dt: '20251101',
              },
            ],
          },
        },
        {
          ok: true,
          json: {
            status: '000',
            list: [
              {
                sj_nm: '손익계산서',
                account_nm: '매출액',
                thstrm_amount: '2500000000000',
              },
              {
                sj_nm: '손익계산서',
                account_nm: '영업이익',
                thstrm_amount: '400000000000',
              },
            ],
          },
        },
      ]);

      const result = await service.getDetailsByName('네이버');

      expect(result.corpCode).toBe('00266961');
      expect(result.profile.ceoName).toBe('최수연');
      expect(result.financials).not.toBeNull();
      expect(result.financials!.items[0].accountNm).toBe('매출액');
      expect(typeof result.fetchedAt).toBe('number');
      expect(result.isStale).toBe(false);
    });

    it('재무 status=013 (조회결과 없음) → financials=null (정상)', async () => {
      mockFetchOnce([
        { ok: true, json: { status: '000', corp_name: 'NAVER' } },
        { ok: true, json: { status: '000', list: [] } },
        {
          ok: true,
          json: { status: '013', message: '조회된 데이타가 없습니다.' },
        },
      ]);

      const result = await service.getDetailsByName('네이버');
      expect(result.financials).toBeNull();
    });

    it('재무 빈 list → financials=null (단일 호출, fallback 안 함)', async () => {
      mockFetchOnce([
        { ok: true, json: { status: '000', corp_name: 'NAVER' } },
        { ok: true, json: { status: '000', list: [] } },
        { ok: true, json: { status: '000', list: [] } },
      ]);
      const result = await service.getDetailsByName('네이버');
      expect(result.financials).toBeNull();
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(3);
    });

    it('캐시 — 같은 corp_code 두 번째 호출 시 fetch 미발생', async () => {
      mockFetchOnce([
        { ok: true, json: { status: '000', corp_name: 'NAVER' } },
        { ok: true, json: { status: '000', list: [] } },
        { ok: true, json: { status: '000', list: [] } },
      ]);

      await service.getDetailsByName('네이버');
      const callCount1 = (global.fetch as jest.Mock).mock.calls.length;
      await service.getDetailsByName('네이버');
      const callCount2 = (global.fetch as jest.Mock).mock.calls.length;
      expect(callCount2).toBe(callCount1);
    });

    it('disclosures 11+ 건 → 10건 cap', async () => {
      const many = Array.from({ length: 15 }, (_, i) => ({
        rcept_no: `R${i}`,
        report_nm: `보고서${i}`,
        rcept_dt: '20251101',
      }));
      mockFetchOnce([
        { ok: true, json: { status: '000', corp_name: 'NAVER' } },
        { ok: true, json: { status: '000', list: many } },
        { ok: true, json: { status: '000', list: [] } },
      ]);

      const result = await service.getDetailsByName('네이버');
      expect(result.disclosures.length).toBeLessThanOrEqual(10);
    });

    it('company.json HTTP 500 → ServiceUnavailableException', async () => {
      mockFetchOnce([{ ok: false, json: {} }]);
      await expect(service.getDetailsByName('네이버')).rejects.toThrow(
        /잠시 후 다시 시도/,
      );
    });

    it('DART status="020" (한도초과) → ServiceUnavailableException (일반화), 빈 캐시 안 저장', async () => {
      mockFetchOnce([
        {
          ok: true,
          json: { status: '020', message: '사용한도를 초과하였습니다.' },
        },
      ]);
      await expect(service.getDetailsByName('네이버')).rejects.toThrow(
        /잠시 후 다시 시도/,
      );
      // 캐시 안 저장 확인
      const cache = (
        service as unknown as { detailsCache: Map<string, unknown> }
      ).detailsCache;
      expect(cache.has('00266961')).toBe(false);
    });

    it('한도초과 후 negative cache — 5분 안 재호출 시 즉시 503', async () => {
      mockFetchOnce([{ ok: true, json: { status: '020', message: '한도' } }]);
      await expect(service.getDetailsByName('네이버')).rejects.toThrow();
      const callsAfter1 = (global.fetch as jest.Mock).mock.calls.length;

      await expect(service.getDetailsByName('네이버')).rejects.toThrow(
        /잠시 후 다시 시도/,
      );
      const callsAfter2 = (global.fetch as jest.Mock).mock.calls.length;
      expect(callsAfter2).toBe(callsAfter1); // 추가 fetch 없음
    });

    it('stale-while-error — 첫 호출 성공 후 (캐시 fetchedAt 강제 expire) 재호출 한도초과 시 stale 반환', async () => {
      // 1차: 성공
      mockFetchOnce([
        {
          ok: true,
          json: { status: '000', corp_name: 'NAVER', ceo_nm: '최수연' },
        },
        { ok: true, json: { status: '000', list: [] } },
        { ok: true, json: { status: '000', list: [] } },
      ]);
      const first = await service.getDetailsByName('네이버');
      expect(first.isStale).toBe(false);

      // 캐시 fetchedAt 을 SOFT_TTL 넘기게 강제 expire (25h 전으로 backdate)
      const cache = (
        service as unknown as {
          detailsCache: Map<string, { data: unknown; fetchedAt: number }>;
        }
      ).detailsCache;
      const entry = cache.get('00266961');
      cache.set('00266961', {
        data: entry!.data,
        fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
      });

      // 2차: 한도초과
      mockFetchOnce([{ ok: true, json: { status: '020', message: '한도' } }]);
      const second = await service.getDetailsByName('네이버');
      expect(second.isStale).toBe(true);
      expect(second.profile.ceoName).toBe('최수연');
    });
  });
});
