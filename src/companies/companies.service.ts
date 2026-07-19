import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Repository } from 'typeorm';
import { Application } from '../applications/application.entity';
import { User } from '../users/user.entity';
import { calculateIndustryBoost } from './industry-job-category-map';

export interface Company {
  name: string;
  /** DART corp_code — 8자리. 회사 정보 lookup 에 사용 */
  corpCode?: string;
  domain?: string;
  industry?: string;
  market?: 'KOSPI' | 'KOSDAQ' | 'KONEX' | 'OTC';
}

/** W2 — DART 기반 회사 정보 (BoardDetail "회사 정보" 섹션) */
export interface CompanyDetails {
  corpCode: string;
  /** epoch ms — 마지막 DART fetch 성공 시각. 프론트가 "N시간 전" 표시에 사용 */
  fetchedAt: number;
  /** true 면 SOFT_TTL 초과 후 refresh 실패해서 stale 반환 (UI 경고 표시용) */
  isStale?: boolean;
  /** company.json — CEO, 본점, 설립일, 홈페이지, 업종 */
  profile: {
    corpName: string;
    ceoName?: string;
    estDate?: string;
    address?: string;
    homepage?: string;
    induty?: string;
    indutyCode?: string;
    phone?: string;
  };
  /** 최근 공시 (list.json — 3개월, 최대 10건) */
  disclosures: Array<{
    receiptNo: string;
    reportName: string;
    receiptDate: string;
  }>;
  /** 최근 재무 (fnlttSinglAcnt.json — 직전 연도 사업보고서 1회) */
  financials: {
    bsnsYear: string;
    reportName: string;
    items: Array<{ sjNm: string; accountNm: string; thstrmAmount: string }>;
  } | null;
}

export interface AutocompleteResult {
  name: string;
  domain?: string;
  industry?: string;
  market?: string;
  source: 'dart' | 'user_added';
  /** 해당 회사를 추가한 다른 사용자 수 (user_added 만) */
  userCount?: number;
  /** signup 직군 매칭 점수 — frontend 가 시각화 가능 (현재는 정렬에만 사용) */
  boost?: number;
}

/**
 * W2 — 회사명 자동완성.
 *
 * data source:
 *   1. DART JSON (`src/data/companies.json`) — 메모리 in-memory (앱 시작 시 1회 load, ~211개)
 *   2. applications.company_name DISTINCT — 다른 사용자가 직접 추가한 회사 (count DESC)
 *
 * 검색 우선순위 (DESC):
 *   1. signup 직군 매칭 boost (industry-job-category-map)
 *   2. prefix match (회사명 시작이 q 와 일치) > contains match
 *   3. 사용자 누적 count
 *   4. 회사명 ko-locale alphabetical
 *
 * 보안:
 *   - q 는 DTO 에서 trim + MaxLength(100). SQL 직접 노출 X (TypeORM parameterized)
 *   - LIKE wildcard escape (`%` `_`) — escapeLike()
 */
@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);
  /** 운영 응답 메시지 — 모든 DART 실패에 동일 (내부 상태 비노출) */
  private readonly DART_FAILURE_MESSAGE =
    'DART 서비스를 잠시 후 다시 시도해주세요.';
  private companies: Company[] = [];
  /** W2 — 회사명 → domain Map (O(1) lookup). ApplicationsService 가 응답에 domain inject 시 사용 */
  private domainByName = new Map<string, string>();
  /** W2 — 회사명 → corp_code Map. /companies/details lookup 시 사용 */
  private corpCodeByName = new Map<string, string>();
  /**
   * W2 — DART details 메모리 캐시 (stale-while-error 패턴).
   *
   * - SOFT_TTL_MS (24h): fresh 기간. 이 안엔 DART 호출 X
   * - HARD_TTL_MS (7d): hard expiry. 이 넘으면 진짜로 삭제·throw
   * - 만료 후 DART 재호출 실패 시 stale 반환 + fetchedAt 으로 "N시간 전" UI 표시
   *
   * negative cache: DART 한도 초과 등 503 받으면 NEGATIVE_TTL_MS (5분) 동안 재호출 차단.
   */
  private detailsCache = new Map<
    string,
    { data: CompanyDetails; fetchedAt: number }
  >();
  /** 한도 초과 등 일시 실패 — 5분간 재호출 차단 (도미노 회피) */
  private negativeCache = new Map<string, number>();
  private readonly SOFT_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  private readonly NEGATIVE_TTL_MS = 5 * 60 * 1000;

  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    this.loadCompanies();
  }

  private loadCompanies() {
    // 환경별 path 시도 (dev ts-node / dist runtime / nest-cli assets / cwd fallback)
    const candidates = [
      path.join(__dirname, '..', 'data', 'companies.json'),
      path.join(process.cwd(), 'src', 'data', 'companies.json'),
      path.join(process.cwd(), 'dist', 'src', 'data', 'companies.json'),
    ];
    let loaded = false;
    for (const jsonPath of candidates) {
      if (fs.existsSync(jsonPath)) {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        this.companies = JSON.parse(raw) as Company[];
        loaded = true;

        this.logger.log(
          `Loaded ${this.companies.length} companies from ${jsonPath}`,
        );
        break;
      }
    }
    if (!loaded) {
      this.logger.warn(
        `companies.json 못 찾음. 시도한 경로: ${candidates.join(', ')}. 사용자 누적만 동작`,
      );
      this.companies = [];
    }

    // 회사명 → domain / corpCode Map 구축
    this.domainByName.clear();
    this.corpCodeByName.clear();
    for (const c of this.companies) {
      if (c.domain) this.domainByName.set(c.name, c.domain);
      if (c.corpCode) this.corpCodeByName.set(c.name, c.corpCode);
    }
  }

  /** companies.json 로 로드된 전체 회사 수 (admin 조사 커버리지 분모) */
  getTotalCount(): number {
    return this.companies.length;
  }

  /** 회사명으로 domain 조회 (응답 inject 용). 없으면 undefined */
  getDomainByName(name: string | null | undefined): string | undefined {
    if (!name) return undefined;
    return this.domainByName.get(name);
  }

  /** LIKE 검색 시 % _ \ escape — SQL injection 별개 (이건 wildcard 의미 차단) */
  private escapeLike(input: string): string {
    return input.replace(/[\\%_]/g, (m) => `\\${m}`);
  }

  async autocomplete(
    userId: string,
    q: string | undefined,
    limit = 10,
  ): Promise<AutocompleteResult[]> {
    const cap = Math.min(Math.max(limit, 1), 10);
    const trimmedQ = (q ?? '').trim();
    const lowerQ = trimmedQ.toLowerCase();

    // user 의 signup 직군 (boost 용)
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'signupJobCategories'],
    });
    const userCategories = user?.signupJobCategories ?? null;

    // 1. DART JSON 에서 매칭 — prefix > contains, boost 계산
    let dartMatched: AutocompleteResult[] = [];
    if (trimmedQ.length === 0) {
      // 빈 q — signup 직군 매칭 회사 boost 위주
      dartMatched = this.companies
        .map((c) => ({
          name: c.name,
          domain: c.domain,
          industry: c.industry,
          market: c.market,
          source: 'dart' as const,
          boost: calculateIndustryBoost(c.industry, userCategories),
        }))
        .filter((c) => c.boost > 0)
        .sort((a, b) => b.boost - a.boost)
        .slice(0, cap);
    } else {
      dartMatched = this.companies
        .filter((c) => c.name.toLowerCase().includes(lowerQ))
        .map((c) => ({
          name: c.name,
          domain: c.domain,
          industry: c.industry,
          market: c.market,
          source: 'dart' as const,
          boost: calculateIndustryBoost(c.industry, userCategories),
          _prefix: c.name.toLowerCase().startsWith(lowerQ),
        }))
        .sort((a, b) => {
          if (a._prefix !== b._prefix) return a._prefix ? -1 : 1;
          if (b.boost !== a.boost) return b.boost - a.boost;
          return a.name.localeCompare(b.name, 'ko');
        })
        .map((entry) => {
          const { _prefix, ...rest } = entry;
          void _prefix;
          return rest;
        });
    }

    // 2. 사용자 누적 (applications.company_name DISTINCT) — DART 에 없는 회사
    const dartNameSet = new Set(this.companies.map((c) => c.name));
    let userAdded: AutocompleteResult[] = [];
    if (trimmedQ.length > 0) {
      // PostgreSQL ILIKE + LIKE escape — wildcard 의미 차단
      const escaped = this.escapeLike(trimmedQ);
      const rows = await this.appRepo
        .createQueryBuilder('a')
        .select('a.company_name', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .where('a.deleted_at IS NULL')
        .andWhere("a.company_name ILIKE :q ESCAPE '\\'", {
          q: `%${escaped}%`,
        })
        .groupBy('a.company_name')
        .orderBy('count', 'DESC')
        .limit(cap)
        .getRawMany<{ name: string; count: number }>();
      userAdded = rows
        .filter((r) => !dartNameSet.has(r.name))
        .map((r) => ({
          name: r.name,
          source: 'user_added' as const,
          userCount: r.count,
        }));
    }

    // 3. 합치고 cap. DART 우선, user_added 뒤
    const combined = [...dartMatched, ...userAdded].slice(0, cap);
    return combined;
  }

  /** 회사명 → corp_code. 비상장사·도메인-only entry 는 undefined */
  getCorpCodeByName(name: string | null | undefined): string | undefined {
    if (!name) return undefined;
    return this.corpCodeByName.get(name);
  }

  /**
   * 회사명으로 DART details 조회. corp_code 없으면 NotFoundException.
   * 메모리 90일 TTL 캐시.
   */
  async getDetailsByName(name: string): Promise<CompanyDetails> {
    const corpCode = this.getCorpCodeByName(name);
    if (!corpCode) {
      throw new NotFoundException(
        '해당 회사의 DART corp_code 가 없습니다 (비상장사이거나 매핑되지 않음).',
      );
    }
    return this.getDetailsByCorpCode(corpCode);
  }

  async getDetailsByCorpCode(corpCode: string): Promise<CompanyDetails> {
    const now = Date.now();
    const cached = this.detailsCache.get(corpCode);

    // 1. SOFT TTL 안이면 즉시 fresh hit (가장 흔한 경로)
    if (cached && now - cached.fetchedAt < this.SOFT_TTL_MS) {
      return { ...cached.data, fetchedAt: cached.fetchedAt, isStale: false };
    }

    // 2. HARD TTL 초과 시 캐시 폐기 (너무 묵은 정보 노출 차단)
    if (cached && now - cached.fetchedAt >= this.HARD_TTL_MS) {
      this.detailsCache.delete(corpCode);
    }

    // 3. negative cache — 최근 한도 초과 등 503 → 5분간 재호출 차단
    const negativeUntil = this.negativeCache.get(corpCode);
    if (negativeUntil && negativeUntil > now) {
      // stale 있으면 stale 반환, 없으면 throw
      const stillCached = this.detailsCache.get(corpCode);
      if (stillCached) {
        return {
          ...stillCached.data,
          fetchedAt: stillCached.fetchedAt,
          isStale: true,
        };
      }
      throw new ServiceUnavailableException(this.DART_FAILURE_MESSAGE);
    }

    const apiKey = process.env.DART_API_KEY;
    if (!apiKey) {
      this.logger.warn('DART_API_KEY 미설정 — details 호출 차단');
      throw new ServiceUnavailableException(this.DART_FAILURE_MESSAGE);
    }

    // 4. fresh fetch 시도
    try {
      const [profileRaw, disclosuresRaw, financialsRaw] = await Promise.all([
        this.fetchDartCompany(corpCode, apiKey),
        this.fetchDartDisclosures(corpCode, apiKey),
        this.fetchDartFinancials(corpCode, apiKey),
      ]);

      const data: CompanyDetails = {
        corpCode,
        fetchedAt: now,
        isStale: false,
        profile: {
          corpName: profileRaw.corp_name ?? '',
          ceoName: profileRaw.ceo_nm,
          estDate: profileRaw.est_dt,
          address: profileRaw.adres,
          homepage: profileRaw.hm_url,
          induty: profileRaw.induty,
          indutyCode: profileRaw.induty_code,
          phone: profileRaw.phn_no,
        },
        disclosures: (disclosuresRaw.list ?? []).slice(0, 10).map((d) => ({
          receiptNo: d.rcept_no,
          reportName: d.report_nm,
          receiptDate: d.rcept_dt,
        })),
        financials: financialsRaw
          ? {
              bsnsYear: financialsRaw.bsnsYear,
              reportName: financialsRaw.reportName,
              items: financialsRaw.list.map((f) => ({
                sjNm: f.sj_nm,
                accountNm: f.account_nm,
                thstrmAmount: f.thstrm_amount,
              })),
            }
          : null,
      };

      this.detailsCache.set(corpCode, { data, fetchedAt: now });
      this.negativeCache.delete(corpCode);
      return data;
    } catch (err) {
      // 5. fetch 실패 — stale-while-error: HARD TTL 안에 옛 데이터 있으면 반환
      this.negativeCache.set(corpCode, now + this.NEGATIVE_TTL_MS);
      if (cached) {
        return { ...cached.data, fetchedAt: cached.fetchedAt, isStale: true };
      }
      throw err;
    }
  }

  /**
   * DART body 의 status 코드 검증. "000" = 정상, "013" = 조회결과 없음 (정상).
   * 그 외(특히 "020" 한도초과)는 throw — DART 는 HTTP 200 으로 답하면서 body 안에 에러 코드 넣는 스타일.
   */
  private assertDartStatus(
    body: { status?: string; message?: string },
    where: string,
  ): void {
    const s = body.status;
    if (!s || s === '000' || s === '013') return;
    this.logger.warn(
      `DART ${where} status=${s} message=${body.message ?? ''}`.trim(),
    );
    throw new ServiceUnavailableException(this.DART_FAILURE_MESSAGE);
  }

  private async fetchDartCompany(
    corpCode: string,
    apiKey: string,
  ): Promise<DartCompanyRaw> {
    const url = `https://opendart.fss.or.kr/api/company.json?crtfc_key=${apiKey}&corp_code=${corpCode}`;
    const res = await fetch(url);
    if (!res.ok) {
      this.logger.warn(`DART company.json HTTP ${res.status}`);
      throw new ServiceUnavailableException(this.DART_FAILURE_MESSAGE);
    }
    const body = (await res.json()) as DartCompanyRaw;
    this.assertDartStatus(body, 'company.json');
    return body;
  }

  private async fetchDartDisclosures(
    corpCode: string,
    apiKey: string,
  ): Promise<{ list?: DartDisclosureRaw[] }> {
    const today = new Date();
    const bgn = new Date(today);
    bgn.setMonth(bgn.getMonth() - 3);
    const fmt = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bgn_de=${fmt(bgn)}&end_de=${fmt(today)}&page_count=10`;
    const res = await fetch(url);
    if (!res.ok) {
      this.logger.warn(`DART list.json HTTP ${res.status}`);
      throw new ServiceUnavailableException(this.DART_FAILURE_MESSAGE);
    }
    const body = (await res.json()) as {
      list?: DartDisclosureRaw[];
      status?: string;
      message?: string;
    };
    this.assertDartStatus(body, 'list.json');
    return body;
  }

  /**
   * 재무 — 직전 연도 사업보고서(11011) 1회만 호출.
   * 베타에선 회사당 DART 호출량 폭증 방지를 위해 5단계 fallback 제거.
   * 사업보고서 없으면 financials=null (UI 가 알아서 안 보여줌).
   */
  private async fetchDartFinancials(
    corpCode: string,
    apiKey: string,
  ): Promise<{
    bsnsYear: string;
    reportName: string;
    list: DartFinancialRaw[];
  } | null> {
    const year = new Date().getFullYear() - 1;
    const url = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011`;
    const res = await fetch(url);
    if (!res.ok) {
      this.logger.warn(`DART fnlttSinglAcnt HTTP ${res.status}`);
      throw new ServiceUnavailableException(this.DART_FAILURE_MESSAGE);
    }
    const body = (await res.json()) as {
      list?: DartFinancialRaw[];
      status?: string;
      message?: string;
    };
    this.assertDartStatus(body, 'fnlttSinglAcnt.json');
    if (!Array.isArray(body.list) || body.list.length === 0) return null;
    return {
      bsnsYear: String(year),
      reportName: `${year} 사업보고서`,
      list: body.list,
    };
  }
}

interface DartCompanyRaw {
  status: string;
  corp_name?: string;
  ceo_nm?: string;
  est_dt?: string;
  adres?: string;
  hm_url?: string;
  induty?: string;
  induty_code?: string;
  phn_no?: string;
}

interface DartDisclosureRaw {
  rcept_no: string;
  report_nm: string;
  rcept_dt: string;
}

interface DartFinancialRaw {
  sj_nm: string;
  account_nm: string;
  thstrm_amount: string;
}
