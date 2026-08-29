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
import { CompanyResearchCache } from '../interview-prep/entities/company-research-cache.entity';

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
  source: 'dart' | 'research' | 'user_added';
  /** 해당 회사를 추가한 다른 사용자 수 (user_added 만) */
  userCount?: number;
}

/**
 * W2 — 회사명 자동완성.
 *
 * data source (노출·dedupe 우선순위 순):
 *   1. DART JSON (`src/data/companies.json`) — 메모리 in-memory (앱 시작 시 1회 load)
 *   2. `company_research_cache` — 회사 조사가 실제로 준비된 회사 (별칭·opt-out·빈 조사 제외)
 *   3. applications.company_name DISTINCT — 다른 사용자가 직접 추가한 회사 (count DESC 로 선별)
 *
 * 검색 우선순위 (소스 블록 안에서):
 *   1. prefix match (회사명 시작이 q 와 일치) > contains match
 *   2. 회사명 ko-locale alphabetical
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
    // 🔴 엔티티만 주입한다 — InterviewPrepModule 을 import 하면 모듈 순환에 걸린다
    @InjectRepository(CompanyResearchCache)
    private readonly researchRepo: Repository<CompanyResearchCache>,
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

  /**
   * companies.json 원본 이름 목록 (admin 실존 판정·유사명 제안용).
   * 호출부가 요청당 1회만 인덱싱하도록 raw 배열만 넘긴다 — 여기서 캐시하면
   * spec 이 `companies` 를 직접 주입할 때 인덱스가 낡는다.
   */
  getAllNames(): string[] {
    return this.companies.map((c) => c.name);
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

  /**
   * prefix match 를 contains 보다 위로, 같은 급이면 회사명 가나다순.
   * 소스 블록마다 각자 정렬한 뒤 소스 순서대로 이어붙는다 (소스 간 재정렬 없음).
   */
  private sortByPrefixThenName<T extends { name: string }>(
    entries: T[],
    lowerQ: string,
  ): T[] {
    return entries.sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(lowerQ);
      const bPrefix = b.name.toLowerCase().startsWith(lowerQ);
      if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
      return a.name.localeCompare(b.name, 'ko');
    });
  }

  /**
   * 회사명 자동완성 — 세 소스를 합쳐 최대 `cap` 개.
   *
   * 소스 우선순위 `dart > research > user_added` 는 **두 가지를 동시에 뜻한다**:
   *   - **dedupe** — 같은 회사가 여러 소스에 걸리면 앞 소스가 이기고 뒤는 버린다.
   *     키는 `trim().toLowerCase()`. 조사 캐시는 회사명을 정규화(소문자)해서 저장하므로
   *     `LG에너지솔루션` 과 `lg에너지솔루션` 이 두 줄로 보이던 문제가 이 키로 막힌다
   *     (그리고 DART 가 이겨서 **표기가 온전한 쪽**이 남는다)
   *   - **노출 순서** — 큐레이션된 목록(DART·조사 시드)이 사용자 누적보다 위에 온다.
   *     사용자 누적은 `로쏘(성심당` 같은 오염된 표기가 섞이는 소스라 위로 올리지 않는다
   *
   * 🔴 **빈 검색어는 `[]` 를 돌려준다.** 예전엔 signup 직군 boost 로 회사를 추천했지만
   * 그 boost 는 `companies.json` 의 `industry` 가 0% 라 **한 번도 값이 나온 적이 없었고**,
   * 빈 검색어 경로가 `.filter(boost > 0)` 이라 결과는 **항상 0개**였다. boost 를 걷어낸 지금
   * 남는 선택지는 「아무 기준 없이 회사를 아무거나 보여주기」뿐이라 차라리 안 보여준다 —
   * 프론트도 타이핑 전엔 드롭다운을 열지 않으므로 체감 동작은 종전과 같다.
   */
  async autocomplete(
    q: string | undefined,
    limit = 10,
  ): Promise<AutocompleteResult[]> {
    const cap = Math.min(Math.max(limit, 1), 10);
    const trimmedQ = (q ?? '').trim();
    if (trimmedQ.length === 0) return [];

    const lowerQ = trimmedQ.toLowerCase();
    // PostgreSQL ILIKE + LIKE escape — wildcard 의미 차단 (DB 두 소스가 공유)
    const likeQ = `%${this.escapeLike(trimmedQ)}%`;

    // 1. DART JSON (메모리) — prefix > contains
    const dartMatched = this.sortByPrefixThenName(
      this.companies
        .filter((c) => c.name.toLowerCase().includes(lowerQ))
        .map((c) => ({
          name: c.name,
          domain: c.domain,
          industry: c.industry,
          market: c.market,
          source: 'dart' as const,
        })),
      lowerQ,
    );

    // 2·3. DB 두 소스는 서로 독립이라 **동시에** 친다. 타이핑 한 글자마다 도는 경로라
    //      순차로 두면 왕복이 그대로 두 배가 된다.
    const [researchRows, userRows] = await Promise.all([
      // 회사 조사 시드 — **조사가 실제로 준비된 회사만.** 별칭 행(is_alias)·opt-out 회사·
      // 빈 조사(`{}`)를 거르는 이유는 같다: 골라도 보여줄 알맹이가 없으면 헛걸음이다.
      this.researchRepo
        .createQueryBuilder('c')
        .select('c.company_name', 'name')
        .where('c.is_alias = false')
        .andWhere('c.opt_out = false')
        .andWhere("c.ai_research IS NOT NULL AND c.ai_research <> '{}'::jsonb")
        .andWhere("c.company_name ILIKE :q ESCAPE '\\'", { q: likeQ })
        // 같은 회사가 직군별로 여러 행이라 회사명 단위로 접는다
        .groupBy('c.company_name')
        .limit(cap)
        .getRawMany<{ name: string }>(),
      // 사용자 누적 (applications.company_name DISTINCT). count DESC + limit 은
      // **어느 후보가 cap 안에 드느냐**(인기순 선별)를 정하고, 그 안에서의 노출 순서는
      // 다른 소스와 똑같이 prefix → 가나다로 통일한다.
      this.appRepo
        .createQueryBuilder('a')
        .select('a.company_name', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .where('a.deleted_at IS NULL')
        .andWhere("a.company_name ILIKE :q ESCAPE '\\'", { q: likeQ })
        .groupBy('a.company_name')
        .orderBy('count', 'DESC')
        .limit(cap)
        .getRawMany<{ name: string; count: number }>(),
    ]);

    const researchMatched = this.sortByPrefixThenName(
      researchRows.map((r) => ({ name: r.name, source: 'research' as const })),
      lowerQ,
    );
    const userAdded = this.sortByPrefixThenName(
      userRows.map((r) => ({
        name: r.name,
        source: 'user_added' as const,
        userCount: r.count,
      })),
      lowerQ,
    );

    // 4. 정규화 키로 dedupe 하면서 cap 까지만 채운다
    const seen = new Set<string>();
    const merged: AutocompleteResult[] = [];
    for (const entry of [...dartMatched, ...researchMatched, ...userAdded]) {
      const key = entry.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
      if (merged.length >= cap) break;
    }
    return merged;
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
