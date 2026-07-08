import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Application } from '../applications/application.entity';
import { CompanyResearchCache } from './entities/company-research-cache.entity';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';

/**
 * 회사 조사 — 캐시 조회 전용 (2026-07-09 유저 트리거 조사 완전 제거, ADR-040).
 *
 * 조사 실행(LLM web_search)은 코드에서 철거됨 — 데이터 공급은 pre-seed 단일 소스
 * (CompanyResearchSeedService 부팅 적재, 원본은 레포 밖 data-seeds 폴더).
 *
 * **흐름**: application/session → 소유권 검증 → companyName + jobCategory 추출
 * → cache 조회 (직군 exact → generic NULL fallback) → hit_count++ (admin 랭킹
 * — pre-seed 우선순위 수요 신호) → 반환. miss 면 null — LLM 호출 경로 없음.
 *
 * **법적 안전장치**:
 * - opt_out=true 행은 빈 응답 + 안내. 행은 영구 보존 (재수집 차단 기록)
 * - 원문 직접 저장 X — AI 요약 (derivative work)
 * - 사용자 메모 (session.userResearchNotes) 는 별도 컬럼 (책임 분리)
 */

/**
 * PR_B1c 후속 — 회사조사 결과 품질 보강 Phase 1.
 *
 * **8 항목 (기존)** + **3 신규** = 11 항목:
 * - companyProfile: 설립·본사·산업·규모 (hero card 데이터)
 * - talentProfile: 인재상·문화 키워드 (회사 채용 페이지 원문)
 * - productsAndTech: 주요 제품·기술 스택 (직무 면접 학습용)
 */
export interface CompanyResearchData {
  businessSummary?: string;
  coreValues?: string;
  visionMission?: string;
  recentTrends?: string;
  financials?: string;
  competitors?: string;
  /** v2 (2026-07-09) — 경쟁사 대비 차별점·강점. 자소서 "왜 이 회사" 근거 */
  differentiators?: string;
  jobInsights?: string;
  interviewKeywords?: InterviewKeyword[];
  // PR 보강 — 신규 3 항목
  companyProfile?: CompanyProfile;
  talentProfile?: string[];
  productsAndTech?: ProductsAndTech;
}

/** PR 보강 — 회사 기본 정보 (hero card 표시) */
export interface CompanyProfile {
  founded?: string; // "1985"
  hq?: string; // "서울 송파구"
  industry?: string; // "IT서비스"
  size?: string; // "대기업 (1.5만명)"
}

/** PR 보강 — 제품·기술 스택 */
export interface ProductsAndTech {
  products?: string[];
  techStack?: string[];
}

/**
 * PR 보강 — interviewKeywords 카테고리별 색상 매핑.
 * 'tech' = 파랑 / 'talent' = 초록 / 'business' = 보라 / 'role' = 주황 / 'issue' = 빨강
 */
export interface InterviewKeyword {
  keyword: string;
  category: 'tech' | 'talent' | 'business' | 'role' | 'issue';
}

/** PR 보강 — 출처 객체 (Perplexity 식 inline footnote) */
export interface ResearchSource {
  id: number; // 본문의 [N] 마커와 매칭
  title: string;
  url: string;
  domain: string;
  publishedAt?: string; // ISO date or YYYY-MM
}

export interface CompanyResearchResult {
  status: 'ok' | 'blocked' | 'opt_out';
  research?: CompanyResearchData;
  /** PR 보강 — 객체 배열로 확장 (기존 string[] 호환 위해 union 유지) */
  sources?: ResearchSource[] | string[];
  /** PR 보강 — confirmed/inferred 분리 (LLM 추정 항목 명시) */
  inferredFields?: string[];
  isCached?: boolean;
  cachedAt?: Date;
  reason?: string;
}

@Injectable()
export class CompanyResearchService {
  private readonly logger = new Logger(CompanyResearchService.name);

  constructor(
    @InjectRepository(CompanyResearchCache)
    private readonly cacheRepo: Repository<CompanyResearchCache>,
    @InjectRepository(InterviewPrepSession)
    private readonly sessionRepo: Repository<InterviewPrepSession>,
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
  ) {}

  /** 정규화: lowercase + trim. 같은 회사 다른 표기 (대소문자·공백) cache 공유 */
  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  /**
   * PR 보강 — interviewKeywords 의 category 자동 추론.
   * LLM 이 schema 못 따라 단순 string 만 반환했을 때 → 키워드 텍스트 기반 카테고리 추론.
   *
   * tech: 기술 / 영문 / 약어 (API, MSA, K8s 등)
   * talent: 인성·문화 (도전, 협업, 책임 등)
   * business: 사업·전략 (매출, 글로벌, 시장 등)
   * role: 직무 (개발, 데이터, 디자인 등)
   * issue: 이슈 (논란, 데이터 침해 등)
   */
  private inferKeywordCategory(
    keyword: string,
  ): 'tech' | 'talent' | 'business' | 'role' | 'issue' {
    const kw = keyword.toLowerCase();
    if (
      /[a-z][a-z0-9]{1,}|api|msa|aws|gcp|cloud|k8s|kafka|spring|kotlin|java|python|database|backend|frontend|devops|개발|기술|아키텍처|시스템|보안|인프라/i.test(
        kw,
      )
    )
      return 'tech';
    if (
      /도전|협업|책임|성장|소통|열정|혁신|존중|배려|적극|성실|주도|학습|인재상|문화|가치관|마인드/.test(
        kw,
      )
    )
      return 'talent';
    if (
      /논란|침해|이슈|사고|위기|소송|벌금|규제|리스크|esg|환경|지속가능/i.test(
        kw,
      )
    )
      return 'issue';
    if (
      /직무|역량|경험|업무|담당|역할|기획|분석|데이터|디자인|마케팅|영업/.test(
        kw,
      )
    )
      return 'role';
    return 'business'; // 매출·시장·전략 default
  }

  /** interviewKeywords 후처리 — string 이면 category 추론, 객체면 그대로 */
  private enrichInterviewKeywords(keywords: unknown): {
    keyword: string;
    category: 'tech' | 'talent' | 'business' | 'role' | 'issue';
  }[] {
    if (!Array.isArray(keywords)) return [];
    return keywords
      .map((k) => {
        if (typeof k === 'string') {
          return { keyword: k, category: this.inferKeywordCategory(k) };
        }
        if (
          typeof k === 'object' &&
          k !== null &&
          typeof (k as { keyword?: unknown }).keyword === 'string'
        ) {
          const obj = k as { keyword: string; category?: string };
          const validCategory = ['tech', 'talent', 'business', 'role', 'issue'];
          const category = validCategory.includes(obj.category ?? '')
            ? (obj.category as
                | 'tech'
                | 'talent'
                | 'business'
                | 'role'
                | 'issue')
            : this.inferKeywordCategory(obj.keyword);
          return { keyword: obj.keyword, category };
        }
        return null;
      })
      .filter(
        (
          k,
        ): k is {
          keyword: string;
          category: 'tech' | 'talent' | 'business' | 'role' | 'issue';
        } => k !== null,
      );
  }

  /** session → application → companyName/jobCategory 추출. 본인 소유 검증 */
  private async resolveCompanyFromSession(
    userId: string,
    sessionId: string,
  ): Promise<{
    session: InterviewPrepSession;
    companyName: string;
    jobCategory: string | null;
    jobUrl: string | null;
  }> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, userId },
    });
    if (!session) throw new NotFoundException('면접 세션을 찾을 수 없습니다.');
    const app = await this.appRepo.findOne({
      where: { id: session.applicationId },
    });
    if (!app) throw new NotFoundException('지원 카드를 찾을 수 없습니다.');
    return {
      session,
      companyName: app.companyName,
      jobCategory: app.jobCategory ?? null,
      jobUrl: app.jobUrl ?? null,
    };
  }

  /** cache 조회 (정규화 key + job_category COALESCE) */
  /**
   * pre-seed fallback (2026-07-09, CEO 결정) — 직군 맞춤 캐시가 없으면 회사 generic
   * (job_category IS NULL) 캐시로 폴백. generic = 무료 기본 제공(pre-seed),
   * 직군 맞춤 조사는 추후 유료 업그레이드 경로로 제공.
   * 폴백은 exact row 가 아예 없을 때만 — exact 가 만료·optOut 이어도 exact 를 반환해
   * 기존 재조사·opt-out 판정 로직을 그대로 태운다 (동작 예측 가능성 우선).
   */
  private async findCacheRow(
    companyName: string,
    jobCategory: string | null,
  ): Promise<CompanyResearchCache | null> {
    const name = this.normalize(companyName);
    const exact = await this.cacheRepo
      .createQueryBuilder('c')
      .where('c.company_name = :name', { name })
      .andWhere(
        jobCategory ? 'c.job_category = :job' : 'c.job_category IS NULL',
        jobCategory ? { job: jobCategory } : {},
      )
      .getOne();
    if (exact || !jobCategory) return exact;
    return this.cacheRepo
      .createQueryBuilder('c')
      .where('c.company_name = :name', { name })
      .andWhere('c.job_category IS NULL')
      .getOne();
  }

  /**
   * application → companyName/jobCategory 추출. 본인 소유 검증.
   * 자소서 풀페이지 (`/board/:appId/coverletter`) 에서 사용.
   */
  private async resolveCompanyFromApplication(
    userId: string,
    applicationId: string,
  ): Promise<{
    companyName: string;
    jobCategory: string | null;
    jobUrl: string | null;
  }> {
    const app = await this.appRepo.findOne({
      where: { id: applicationId, userId },
    });
    if (!app) throw new NotFoundException('지원 카드를 찾을 수 없습니다.');
    return {
      companyName: app.companyName,
      jobCategory: app.jobCategory ?? null,
      // PR 보강 — 회사 공식 도메인 동적 화이트리스트 추가 위해
      jobUrl: app.jobUrl ?? null,
    };
  }

  /**
   * 자소서 풀페이지 — 캐시만 조회 (없으면 null, LLM 호출 X)
   */
  async getCachedForApplication(
    userId: string,
    applicationId: string,
  ): Promise<CompanyResearchResult | null> {
    const { companyName, jobCategory } =
      await this.resolveCompanyFromApplication(userId, applicationId);
    const row = await this.findCacheRow(companyName, jobCategory);
    if (!row) return null;
    if (row.optOut) {
      return {
        status: 'opt_out',
        reason: '이 회사는 정보 수집 동의가 철회됐어요.',
      };
    }
    if (row.expiresAt < new Date()) return null;
    this.bumpHitCount(row.id); // 2차 pre-seed 우선순위 데이터 (fire-and-forget)
    return this.buildResultFromCache(row);
  }

  /** hit_count 증가 — admin 랭킹(pre-seed 우선순위)용. 실패해도 조회에 영향 없음 (fire-and-forget) */
  private bumpHitCount(rowId: string): void {
    try {
      void Promise.resolve(
        this.cacheRepo.increment({ id: rowId }, 'hitCount', 1),
      ).catch(() => undefined);
    } catch {
      // 통계용 — 조회 실패로 이어지면 안 됨
    }
  }

  /**
   * PR 보강 — cache row → CompanyResearchResult 변환 helper.
   * aiResearch JSONB 안의 sources/inferredFields 우선, 없으면 entity.sources (legacy string[]) fallback.
   */
  private buildResultFromCache(
    row: CompanyResearchCache,
  ): CompanyResearchResult {
    const ai = row.aiResearch as CompanyResearchData & {
      sources?: ResearchSource[];
      inferredFields?: string[];
    };
    const sources = ai.sources ?? row.sources ?? [];
    // PR 보강 — legacy cache 의 string keyword 도 category 자동 추론
    const enriched: CompanyResearchData = {
      ...ai,
      interviewKeywords: this.enrichInterviewKeywords(ai.interviewKeywords),
    };
    return {
      status: 'ok',
      research: enriched,
      sources,
      inferredFields: ai.inferredFields ?? [],
      isCached: true,
      cachedAt: row.updatedAt,
    };
  }

  /**
   * 캐시만 조회 (없으면 null). 프론트 첫 진입 시 사용 — LLM 호출 X
   */
  async getCachedForSession(
    userId: string,
    sessionId: string,
  ): Promise<CompanyResearchResult | null> {
    const { companyName, jobCategory } = await this.resolveCompanyFromSession(
      userId,
      sessionId,
    );
    const row = await this.findCacheRow(companyName, jobCategory);
    if (!row) return null;
    if (row.optOut) {
      return {
        status: 'opt_out',
        reason: '이 회사는 정보 수집 동의가 철회됐어요.',
      };
    }
    if (row.expiresAt < new Date()) return null; // 만료 — 다음 pre-seed 갱신 대상
    this.bumpHitCount(row.id); // 2차 pre-seed 우선순위 데이터 (fire-and-forget)
    return this.buildResultFromCache(row);
  }

  /** 사용자 자유 메모 update — session 단위 */
  async updateUserNotes(
    userId: string,
    sessionId: string,
    notes: string | null,
  ): Promise<void> {
    if (notes !== null && notes.length > 5000) {
      throw new BadRequestException('메모는 5000자 이내로 작성해 주세요.');
    }
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, userId },
    });
    if (!session) throw new NotFoundException('면접 세션을 찾을 수 없습니다.');
    session.userResearchNotes = notes === null ? null : notes.trim() || null;
    await this.sessionRepo.save(session);
  }

  /**
   * 운영자 opt-out — 회사 측 삭제 요청 시 호출 (24시간 SLA).
   * cache 비우고 opt_out=true 토글. 향후 재조사 차단.
   */
  async optOut(adminUserId: string, companyName: string): Promise<void> {
    if (!adminUserId) {
      throw new ForbiddenException('admin only');
    }
    const normalized = this.normalize(companyName);
    // 해당 회사의 모든 (job_category) row 처리
    const rows = await this.cacheRepo.find({
      where: { companyName: normalized },
    });
    for (const r of rows) {
      r.optOut = true;
      r.aiResearch = {};
      r.sources = [];
      await this.cacheRepo.save(r);
    }
    this.logger.warn(
      `[OPT-OUT] admin=${adminUserId} company="${normalized}" rows=${rows.length}`,
    );
  }

  /** admin 통계용 — 회사별 hit ranking (opt_out 제외) */
  async getTopCompanies(
    limit = 20,
  ): Promise<
    Array<{ companyName: string; jobCategory: string | null; hitCount: number }>
  > {
    const rows = await this.cacheRepo
      .createQueryBuilder('c')
      .where('c.opt_out = FALSE')
      .orderBy('c.hit_count', 'DESC')
      .limit(limit)
      .getMany();
    return rows.map((r) => ({
      companyName: r.companyName,
      jobCategory: r.jobCategory,
      hitCount: r.hitCount,
    }));
  }
}
