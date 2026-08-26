import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, Repository } from 'typeorm';
import { CompanyResearchCache } from '../interview-prep/entities/company-research-cache.entity';
import { Application } from '../applications/application.entity';
import { CompaniesService } from '../companies/companies.service';
import type {
  UnifiedCompanyResearchDto,
  UnifiedResearchFilter,
  UnifiedResearchSort,
  SortOrder,
} from './dto/unified-company-research.dto';
import {
  buildCompanyNameIndex,
  findSimilarCompanyName,
  hasCompanyName,
} from './utils/company-name-match';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 전체 내보내기 상한 (feature-research-moment, 2026-08-22).
 *
 * 근거: 내보내기의 용도는 ① 조사 프롬프트에 회사명 붙여넣기 ② 우선순위 보며 배치 분할.
 * 500개면 회사명 연결 문자열이 ~4KB 로 프롬프트에 그대로 들어가고, CSV 도 한 화면에서
 * 훑을 수 있는 규모다. 현재 병합 행 규모는 수백(조사 351 ∪ 카드) 이라 대부분 미만이며,
 * 상한에 걸리는 경우 **화면과 파일 양쪽에 「전체 N개 중 상위 M개」를 적는다** —
 * 조용히 잘리면 조사 대상을 놓치고도 모른다.
 */
export const RESEARCH_EXPORT_MAX = 500;

/** 병합 후 통합 행 — 조사 캐시(조사 메타) ∪ 지원 카드(수요 신호). */
/**
 * 수요 단계 — 이 회사에 **실제로 지원이 시작됐는가**.
 *
 * 🔴 `'planned'` 는 「지원 예정 카드가 **하나라도** 있다」가 아니라 **「지원 예정만 있다」**다.
 * 진행 중 카드가 섞여 있으면 이미 실제 지원이 시작된 회사이므로 등급을 내리면 안 된다.
 *
 * `null` = 카드가 0장인 행 (조사 캐시에만 존재). 「예정」이 아니라 **판정 대상이 아니다** —
 * `plannedCards === cards` 를 그대로 쓰면 `0 === 0` 이라 전부 「예정」으로 둔갑한다.
 */
export type DemandStage = 'applied' | 'planned';

/**
 * raw 쿼리의 개수 값 → 안전한 정수.
 *
 * 🔴 `Number(undefined)` 가 **NaN** 이라는 게 요점이다. `getRawMany` 결과는 우리가 선언한
 * 타입이 지켜준다는 보장이 없어(별칭 오타·select 누락) 신뢰 경계 밖 데이터로 다뤄야 한다.
 * NaN 은 던지지 않고 **조용히 퍼지며**, 비교(`===`)는 전부 false 가 되어 분류를 뒤집는다.
 */
function toCount(v: string | number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export interface UnifiedResearchRow {
  companyName: string;
  researched: boolean;
  seedVersion: string | null;
  /** 지원자 수 — **지원 예정 포함 합산** (아래 `plannedApplicants` 가 그중 예정분) */
  applicants: number;
  /** 카드 수 — **지원 예정 포함 합산** */
  cards: number;
  /** 위 `applicants` 중 지원 예정(PLANNED)만인 사람 */
  plannedApplicants: number;
  /** 위 `cards` 중 지원 예정(PLANNED) 카드 */
  plannedCards: number;
  /** 카드가 있을 때만 판정. 카드 0장(조사 캐시 전용 행)이면 `null` */
  demandStage: DemandStage | null;
  hitCount: number;
  updatedAt: Date | null;
  expiresAt: Date | null;
  inferredCount: number | null;
  optOut: boolean;
}

/**
 * 표 표시용 행 — 병합 행 + 실존 판정.
 * `knownCompany`·`similarTo` 는 **현재 페이지 행에만** 계산한다 (§getUnified 참조).
 */
export interface UnifiedResearchItem extends UnifiedResearchRow {
  /** companies.json(DART) 목록에 이 이름이 있는가 — 오타·가상 회사 판별 */
  knownCompany: boolean;
  /** 실존 목록에 없을 때만 계산한 가장 가까운 이름 1개. 멀면 null */
  similarTo: string | null;
}

/** 내보내기 행 — 회사명 + 우선순위 판단에 필요한 수요 수치만. */
export interface ResearchExportRow {
  companyName: string;
  applicants: number;
  cards: number;
}

/**
 * 회사 조사 현황 admin 조회 (feature-research-admin, 2026-07-12).
 *
 * 운영 DB 의 pre-seed 반영 상태를 admin 페이지에서 확인하기 위한 **읽기 전용** 집계.
 * 데이터 소스 = company_research_cache (seed 부팅 적재) + applications 집계 (수요).
 * mutation 0.
 *
 * ⚠️ 응답 안전: ai_research JSONB **원문은 절대 반환하지 않음**. 파생 지표
 * (inferredCount = 추정 항목 개수, avgFillRate = 항목 채움율) 와 메타 필드만 노출.
 */
@Injectable()
export class CompanyResearchStatusService {
  constructor(
    @InjectRepository(CompanyResearchCache)
    private readonly cacheRepo: Repository<CompanyResearchCache>,
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    private readonly companies: CompaniesService,
  ) {}

  /** ai_research 채움율 계산 기준 항목 (구 metrics fill-rate 로직 이주). */
  private readonly FILL_FIELDS = [
    'businessSummary',
    'coreValues',
    'visionMission',
    'recentTrends',
    'financials',
    'competitors',
    'jobInsights',
    'interviewKeywords',
  ];

  /** 회사명 정규화 키 (lowercase + trim) — 조사 캐시·지원 카드 병합 공통 키. */
  private norm(s: string): string {
    return s.trim().toLowerCase();
  }

  /**
   * 요약 카드 — 커버리지·버전 분포·TTL 상태·평균 채움율.
   * versionDistribution 이 "재시작 반영 확인"의 핵심 (최신 seed 버전이 다수면 반영 성공).
   * avgFillRate 는 구 회사조사 metrics fill-rate 를 단일 지표로 편입.
   */
  async getSummary(): Promise<{
    totalCompanies: number;
    researchedCount: number;
    researchedNames: number;
    coverageRate: number;
    versionDistribution: Array<{ version: string | null; count: number }>;
    optOutCount: number;
    expiringSoonCount: number;
    expiredCount: number;
    avgFillRate: number;
  }> {
    const totalCompanies = this.companies.getTotalCount();
    const now = new Date();
    const in30Days = new Date(now.getTime() + THIRTY_DAYS_MS);

    // 조사 데이터가 있는 서로 다른 이름 수 (opt_out 제외, ai_research 비어있지 않음).
    // - researchedCount = 회사 수 (커버리지 분자) — 별칭 행(is_alias) 제외.
    // - researchedNames = 별칭 포함 전체 이름 수.
    const researchedRow = await this.cacheRepo
      .createQueryBuilder('c')
      .select(
        'COUNT(DISTINCT c.company_name) FILTER (WHERE c.is_alias = false)',
        'companies',
      )
      .addSelect('COUNT(DISTINCT c.company_name)', 'names')
      .where('c.opt_out = false')
      .andWhere('c.ai_research IS NOT NULL')
      .andWhere("c.ai_research <> '{}'::jsonb")
      .getRawOne<{ companies: string; names: string }>();
    const researchedCount = parseInt(researchedRow?.companies ?? '0', 10);
    const researchedNames = parseInt(researchedRow?.names ?? '0', 10);

    const versionRows = await this.cacheRepo
      .createQueryBuilder('c')
      .select('c.seed_version', 'version')
      .addSelect('COUNT(*)', 'cnt')
      .groupBy('c.seed_version')
      .orderBy('cnt', 'DESC')
      .getRawMany<{ version: string | null; cnt: string }>();
    const versionDistribution = versionRows.map((r) => ({
      version: r.version,
      count: parseInt(r.cnt ?? '0', 10),
    }));

    const [optOutCount, expiringSoonCount, expiredCount] = await Promise.all([
      this.cacheRepo.count({ where: { optOut: true } }),
      this.cacheRepo.count({
        where: { optOut: false, expiresAt: Between(now, in30Days) },
      }),
      this.cacheRepo.count({
        where: { optOut: false, expiresAt: LessThan(now) },
      }),
    ]);

    return {
      totalCompanies,
      researchedCount,
      researchedNames,
      coverageRate: totalCompanies > 0 ? researchedCount / totalCompanies : 0,
      versionDistribution,
      optOutCount,
      expiringSoonCount,
      expiredCount,
      avgFillRate: await this.computeAvgFillRate(),
    };
  }

  /**
   * 평균 채움율 (0~1) — 전체 cache row 의 항목별 채움율 평균.
   * 빈 string·null·빈 배열·빈 객체는 unfilled. cache 0건이면 0.
   * (구 CompanyResearchMetricsService.getFillRate 로직 편입 — 단일 지표화.)
   */
  private async computeAvgFillRate(): Promise<number> {
    const rows = await this.cacheRepo.find({ select: ['aiResearch'] });
    const total = rows.length;
    if (total === 0) return 0;

    const rateSum = this.FILL_FIELDS.reduce((acc, field) => {
      const filled = rows.filter((r) => {
        const v = r.aiResearch?.[field];
        if (v === null || v === undefined || v === '') return false;
        if (Array.isArray(v) && v.length === 0) return false;
        if (typeof v === 'object' && Object.keys(v).length === 0) return false;
        return true;
      }).length;
      return acc + filled / total;
    }, 0);
    return rateSum / this.FILL_FIELDS.length;
  }

  /**
   * 통합 목록 한 페이지 — 병합 행(collectRows) 슬라이스 + 실존 판정.
   *
   * ⚠️ 응답 안전: ai_research 원문·user_id 미노출. 파생 필드만.
   */
  async getUnified(dto: UnifiedCompanyResearchDto): Promise<{
    items: UnifiedResearchItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = dto.page && dto.page > 0 ? dto.page : 1;
    const limit = dto.limit && dto.limit > 0 ? dto.limit : 20;

    const merged = await this.collectRows(dto);
    const total = merged.length;
    const start = (page - 1) * limit;
    const pageRows = merged.slice(start, start + limit);

    // 🔴 실존 판정·유사명은 **현재 페이지 행에만**. 인덱스는 요청당 1회 만들고
    //    행마다 재사용한다 (행마다 3,798개 전수 비교 금지).
    if (pageRows.length === 0) return { items: [], total, page, limit };
    const index = buildCompanyNameIndex(this.companies.getAllNames());
    const items = pageRows.map((row) => {
      const known = hasCompanyName(row.companyName, index);
      return {
        ...row,
        knownCompany: known,
        // 실존이면 제안이 필요 없다 — 계산 자체를 하지 않는다.
        similarTo: known
          ? null
          : findSimilarCompanyName(row.companyName, index),
      };
    });

    return { items, total, page, limit };
  }

  /**
   * 전체 내보내기 — 필터·정렬이 적용된 **전 범위** (page/limit 무시).
   *
   * 목록 페이지네이션이 이미 전량 로드 후 메모리 슬라이스라, 전 범위 확보에
   * 추가 쿼리가 없다. 상한(RESEARCH_EXPORT_MAX)을 넘으면 정렬 순 상위만 담고
   * `truncated`·`total` 로 **잘렸다는 사실을 호출부에 넘긴다** (조용한 절단 금지).
   *
   * 실존 판정·유사명은 계산하지 않는다 — 내보내기 용도(조사 프롬프트·배치 분할)에
   * 필요 없고, 전 범위 500행에 대해 돌리면 비싸다.
   */
  async getExport(dto: UnifiedCompanyResearchDto): Promise<{
    items: ResearchExportRow[];
    total: number;
    limit: number;
    truncated: boolean;
  }> {
    const merged = await this.collectRows(dto);
    const total = merged.length;
    const items = merged.slice(0, RESEARCH_EXPORT_MAX).map((r) => ({
      companyName: r.companyName,
      applicants: r.applicants,
      cards: r.cards,
    }));
    return {
      items,
      total,
      limit: RESEARCH_EXPORT_MAX,
      truncated: total > items.length,
    };
  }

  /**
   * 검색·필터·정렬까지 끝낸 병합 행 전체 (페이지네이션 이전) — 조사 캐시 ∪ 지원 카드.
   *
   * 목록(getUnified)과 내보내기(getExport)가 **같은 결과를 보도록** 공유한다 —
   * 갈라지면 "화면에 보이는 것과 내보낸 것이 다른" 최악의 상태가 된다.
   *
   * 병합 근거:
   * - 지원 카드 집계 = 수요 신호 (applicants 主·cards). getDemand 와 동일 쿼리:
   *   status IN (IN_PROGRESS·PASSED·FAILED) · is_sample=FALSE · soft delete 자동 제외 ·
   *   LOWER(TRIM) 정규화 · applicants=COUNT(DISTINCT user_id) · cards=COUNT(*) ·
   *   대표 표기 = MODE().
   * - 조사 캐시 집계 = 조사 메타 (정규화 키별 seedVersion·updatedAt·expiresAt·hitCount·
   *   optOut·inferredCount·researched).
   * - 양쪽 Map 을 정규화 키로 병합 (합집합) → 조사만/카드만/둘다 3유형 모두 노출.
   *
   * ⚠️ 검색·정렬·필터는 **병합 후 JS** 에서 수행. 베타 규모(수백 행) 전제 —
   *    전량 로드 후 메모리 처리. 규모 확대 시 SQL 페이지네이션 재설계 필요.
   */
  private async collectRows(
    dto: UnifiedCompanyResearchDto,
  ): Promise<UnifiedResearchRow[]> {
    const filter: UnifiedResearchFilter = dto.filter ?? 'all';
    const sort: UnifiedResearchSort = dto.sort ?? 'applicants';
    const order: SortOrder = dto.order ?? 'desc';

    // 1) 지원 카드 집계 — 정규화 키별 대표 표기·지원자·카드 수.
    //    deleted_at IS NULL 은 TypeORM 이 자동 적용 (withDeleted 미사용).
    const appRows = await this.appRepo
      .createQueryBuilder('a')
      .select('LOWER(TRIM(a.company_name))', 'norm')
      .addSelect('MODE() WITHIN GROUP (ORDER BY a.company_name)', 'companyName')
      .addSelect('COUNT(DISTINCT a.user_id)', 'applicants')
      .addSelect('COUNT(*)', 'cards')
      // 🔴 예정분을 **따로도** 센다. 합산만 주면 숫자가 왜 늘었는지 화면에서 알 수 없다 —
      //    「진행 3 · 예정 2」로 내역을 보여줘야 조용히 부푼 값으로 안 읽힌다.
      .addSelect(
        "COUNT(DISTINCT a.user_id) FILTER (WHERE a.status = 'PLANNED')",
        'plannedApplicants',
      )
      .addSelect("COUNT(*) FILTER (WHERE a.status = 'PLANNED')", 'plannedCards')
      .where('a.status IN (:...statuses)', {
        // 🔴 `PLANNED`(지원 예정) 포함 — 2026-08-26 추가.
        // 그전에는 지원 예정만 있는 회사가 **조사 목록에 아예 안 떴다.** 미조사 필터를
        // 걸어도 안 보여서, 아직 지원 안 한 회사는 조사 대상으로 올릴 방법이 없었다.
        //
        // 예정을 `applicants` 에 **합산**하는 이유 — 따로 세면 예정만 있는 회사가 `0명` 이
        // 되어 정렬 하단으로 밀리고, 페이지를 넘어가 결국 안 보인다. 그러면 목록에
        // 넣은 의미가 없다. 대신 위 `planned*` 로 내역을 함께 준다.
        statuses: ['PLANNED', 'IN_PROGRESS', 'PASSED', 'FAILED'],
      })
      // W1 온보딩 샘플 카드(가상 회사명) 제외 — 수요 목록 오염 방지
      .andWhere('a.is_sample = FALSE')
      .groupBy('LOWER(TRIM(a.company_name))')
      .getRawMany<{
        norm: string;
        companyName: string;
        applicants: string | number;
        cards: string | number;
        plannedApplicants: string | number;
        plannedCards: string | number;
      }>();
    const cardByNorm = new Map(appRows.map((r) => [r.norm, r]));

    // 2) 조사 캐시 집계 — 정규화 키별 조사 메타.
    //    파라미터 없는 고정 jsonb 경로 표현식 (사용자 입력 interpolation 없음).
    const cacheRows = await this.cacheRepo
      .createQueryBuilder('c')
      .select('LOWER(TRIM(c.company_name))', 'norm')
      .addSelect('MODE() WITHIN GROUP (ORDER BY c.company_name)', 'companyName')
      .addSelect('MAX(c.seed_version)', 'seedVersion')
      .addSelect('MAX(c.updated_at)', 'updatedAt')
      .addSelect('MAX(c.expires_at)', 'expiresAt')
      .addSelect('MAX(c.hit_count)', 'hitCount')
      .addSelect('bool_or(c.opt_out)', 'optOut')
      .addSelect(
        "bool_or(c.ai_research IS NOT NULL AND c.ai_research <> '{}'::jsonb)",
        'researched',
      )
      .addSelect(
        "MAX(jsonb_array_length(COALESCE(c.ai_research->'inferredFields', '[]'::jsonb)))",
        'inferredCount',
      )
      .groupBy('LOWER(TRIM(c.company_name))')
      .getRawMany<{
        norm: string;
        companyName: string;
        seedVersion: string | null;
        updatedAt: Date;
        expiresAt: Date;
        hitCount: string | number;
        optOut: boolean;
        researched: boolean;
        inferredCount: string | number;
      }>();
    const cacheByNorm = new Map(cacheRows.map((r) => [r.norm, r]));

    // 3) 합집합 키 병합 — 조사만·카드만·둘다 모두 포함.
    const keys = new Set<string>([...cardByNorm.keys(), ...cacheByNorm.keys()]);
    let merged: UnifiedResearchRow[] = [];
    for (const key of keys) {
      const card = cardByNorm.get(key);
      const cache = cacheByNorm.get(key);
      const cards = card ? Number(card.cards) : 0;
      // 🔴 `Number(undefined)` 는 **NaN** 이다. raw 쿼리 결과는 타입이 보장된 값이 아니라
      //    신뢰 경계 밖 데이터라, 별칭이 바뀌거나 select 가 빠지면 조용히 NaN 이 흘러든다.
      //    그러면 `plannedCards === cards` 가 `NaN === NaN` → false 라 **예정만 있는 회사가
      //    「지원 중」으로 오분류**된다. 화면은 멀쩡해 보이고 숫자만 틀리는 종류다.
      const plannedCards = toCount(card?.plannedCards);
      merged.push({
        // 대표 표기는 카드 쪽(원 사용자 표기) 우선, 없으면 캐시(정규화 저장값).
        companyName: card?.companyName ?? cache?.companyName ?? key,
        researched: cache?.researched ?? false,
        seedVersion: cache?.seedVersion ?? null,
        applicants: card ? Number(card.applicants) : 0,
        cards,
        plannedApplicants: toCount(card?.plannedApplicants),
        plannedCards,
        // 🔴 `cards === 0` 을 먼저 걸러낸다. 안 그러면 조사 캐시에만 있는 행이
        //    `0 === 0` 으로 전부 「지원 예정」이 된다 (카드가 없는 것과 예정인 것은 다르다).
        demandStage:
          cards === 0 ? null : plannedCards === cards ? 'planned' : 'applied',
        hitCount: cache ? Number(cache.hitCount) : 0,
        updatedAt: cache?.updatedAt ?? null,
        expiresAt: cache?.expiresAt ?? null,
        inferredCount: cache ? Number(cache.inferredCount) : null,
        optOut: cache?.optOut ?? false,
      });
    }

    // 4) 검색 (정규화 소문자 includes) → 필터 → 정렬 → 페이지네이션 (병합 후 JS).
    const q = this.norm(dto.search ?? '');
    if (q.length > 0) {
      merged = merged.filter((r) => this.norm(r.companyName).includes(q));
    }
    merged = this.applyFilter(merged, filter);
    this.sortRows(merged, sort, order);
    return merged;
  }

  /** 병합 행 필터 — all|unresearched|expiring|expired|optout. */
  private applyFilter(
    rows: UnifiedResearchRow[],
    filter: UnifiedResearchFilter,
  ): UnifiedResearchRow[] {
    const now = Date.now();
    const in30 = now + THIRTY_DAYS_MS;
    switch (filter) {
      case 'unresearched':
        return rows.filter((r) => !r.researched);
      case 'expiring':
        return rows.filter(
          (r) =>
            !r.optOut &&
            r.expiresAt != null &&
            r.expiresAt.getTime() >= now &&
            r.expiresAt.getTime() <= in30,
        );
      case 'expired':
        return rows.filter(
          (r) =>
            !r.optOut && r.expiresAt != null && r.expiresAt.getTime() < now,
        );
      case 'optout':
        return rows.filter((r) => r.optOut);
      case 'all':
      default:
        return rows;
    }
  }

  /** 병합 행 정렬 — null 은 order 와 무관하게 항상 뒤 (NULLS LAST). */
  private sortRows(
    rows: UnifiedResearchRow[],
    sort: UnifiedResearchSort,
    order: SortOrder,
  ): void {
    const dir = order === 'asc' ? 1 : -1;
    const value = (r: UnifiedResearchRow): string | number | null => {
      switch (sort) {
        case 'name':
          return this.norm(r.companyName);
        case 'applicants':
          return r.applicants;
        case 'cards':
          return r.cards;
        case 'hitCount':
          return r.hitCount;
        case 'updatedAt':
          return r.updatedAt ? r.updatedAt.getTime() : null;
        case 'inferredCount':
          return r.inferredCount;
        default:
          return r.applicants;
      }
    };
    rows.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // NULLS LAST — null 은 방향 무관 항상 뒤로.
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }
}
