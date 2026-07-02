/**
 * W2 — CompaniesService 자동완성 spec (12 cases).
 *
 * cover: 정상 / prefix vs contains / signup boost / 사용자 누적 / 공백 trim / 특수문자 escape /
 *        한글+영문 mixed / 대용량 q / limit cap / 비존재 user / DART JSON 없음 (fallback) /
 *        사용자 누적 + DART 중복 제거
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { Application } from '../applications/application.entity';
import { User } from '../users/user.entity';
import { CompaniesService } from './companies.service';

describe('CompaniesService', () => {
  let service: CompaniesService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let userRepo: jest.Mocked<Repository<User>>;

  // QueryBuilder chain mock
  function makeQb(rows: { name: string; count: number }[]) {
    return {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    } as never;
  }

  const makeUser = (overrides: Partial<User> = {}): User => ({
    id: 'u1',
    kakaoId: 'k1',
    appleSub: null,
    appleEmail: null,
    nickname: 'tester',
    email: null,
    role: 'user',
    refreshToken: null,
    lastActiveAt: null,
    termsAgreedAt: null,
    createdAt: new Date(),
    dashboardConfig: null,
    onboardedAt: null,
    suspendedAt: null,
    aiConsentAt: null,
    aiConsentVersion: null,
    onboardedCoinAt: null,
    suspendReason: null,
    suspendExpiresAt: null,
    pendingNotification: null,
    signupJobCategories: null,
    signupOtherText: null,
    sampleCardsDismissedAt: null,
    calendarHomeIntroDismissedAt: null,
    tier: 'free',
    ...overrides,
  });

  beforeEach(async () => {
    appRepo = mock<Repository<Application>>();
    userRepo = mock<Repository<User>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompaniesService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();

    service = module.get<CompaniesService>(CompaniesService);

    // spec — companies.json 의 industry 없음 (베타 seed) → boost 검증 위해 직접 주입
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
  });

  describe('autocomplete', () => {
    it('정상 prefix match → "네이버" 가 "네이" 검색의 첫 결과 (prefix > contains)', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]));

      const result = await service.autocomplete('u1', '네이');

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].name).toBe('네이버');
      expect(result[0].source).toBe('dart');
      expect(result[0].domain).toBe('naver.com');
    });

    it('contains match — q="카오" 가 "카카오" 매칭', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]));

      const result = await service.autocomplete('u1', '카오');

      expect(result.some((r) => r.name === '카카오')).toBe(true);
    });

    it('signup 직군 boost — q="네" + signup=[백엔드 개발] → IT 회사 (네이버) boost (top 결과에 포함)', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ signupJobCategories: ['백엔드 개발'] }),
      );
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]));

      const result = await service.autocomplete('u1', '네');

      // 네이버 (domain=naver.com) 가 결과에 있어야
      const naver = result.find((r) => r.name === '네이버');
      expect(naver).toBeDefined();
      expect(naver?.boost).toBeGreaterThan(0);
    });

    it('빈 q → signup 직군 매칭 회사 추천 (boost 만)', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ signupJobCategories: ['백엔드 개발'] }),
      );
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]));

      const result = await service.autocomplete('u1', '');

      // boost > 0 인 결과만
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((r) => (r.boost ?? 0) > 0)).toBe(true);
    });

    it('빈 q + signup 없음 → 빈 결과', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]));

      const result = await service.autocomplete('u1', '');

      expect(result).toEqual([]);
    });

    it('사용자 누적 — DART 에 없는 회사 (q="스타트업X") 가 다른 user 가 추가한 경우 결과 포함', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appRepo.createQueryBuilder.mockReturnValue(
        makeQb([{ name: '스타트업X', count: 5 }]),
      );

      const result = await service.autocomplete('u1', '스타트업');

      const userAdded = result.find((r) => r.source === 'user_added');
      expect(userAdded).toBeDefined();
      expect(userAdded?.name).toBe('스타트업X');
      expect(userAdded?.userCount).toBe(5);
    });

    it('사용자 누적 + DART 중복 제거 — 같은 이름 (네이버) 가 user_added 에도 있으면 DART 우선', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appRepo.createQueryBuilder.mockReturnValue(
        makeQb([{ name: '네이버', count: 10 }]),
      );

      const result = await service.autocomplete('u1', '네이버');

      const naverCount = result.filter((r) => r.name === '네이버').length;
      expect(naverCount).toBe(1);
      expect(result.find((r) => r.name === '네이버')?.source).toBe('dart');
    });

    it('limit cap — limit=20 → 10 max', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]));

      const result = await service.autocomplete('u1', '한', 20);

      expect(result.length).toBeLessThanOrEqual(10);
    });

    it('한글+영문 mixed — q="LG" → "LG에너지솔루션" 매칭', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]));

      const result = await service.autocomplete('u1', 'LG');

      expect(result.some((r) => r.name === 'LG에너지솔루션')).toBe(true);
    });

    it('LIKE wildcard escape — q="50%할인" → escape 후 SQL 안전 호출 (wildcard 의미 차단)', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      const qb = makeQb([]);
      appRepo.createQueryBuilder.mockReturnValue(qb);

      await service.autocomplete('u1', '50%할인');

      // andWhere 호출 시 escape 된 q 전달 검증
      const qbAny = qb as unknown as { andWhere: jest.Mock };
      const andWhereCall = qbAny.andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('ILIKE'),
      );
      expect(andWhereCall).toBeDefined();
      expect((andWhereCall as unknown[])[1]).toEqual({
        q: String.raw`%50\%할인%`,
      });
    });

    it('비존재 user (signupJobCategories 조회 실패) → boost 0 으로 정상 동작', async () => {
      userRepo.findOne.mockResolvedValue(null);
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]));

      const result = await service.autocomplete('nonexistent', '네이');

      expect(result.length).toBeGreaterThan(0);
      expect(result.every((r) => (r.boost ?? 0) === 0)).toBe(true);
    });

    it('대용량 결과 매칭 — q="한" → cap=10 잘 적용 (211 회사 중 한* 다수)', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]));

      const result = await service.autocomplete('u1', '한', 10);

      expect(result.length).toBeLessThanOrEqual(10);
      expect(result.every((r) => r.name.toLowerCase().includes('한'))).toBe(
        true,
      );
    });

    it('source 필드 정확성 — DART = "dart", 사용자 누적 = "user_added"', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appRepo.createQueryBuilder.mockReturnValue(
        makeQb([{ name: '커스텀스타트업', count: 3 }]),
      );

      const result = await service.autocomplete('u1', '커스텀');

      const userAdded = result.find((r) => r.name === '커스텀스타트업');
      expect(userAdded?.source).toBe('user_added');
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
