import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, MoreThanOrEqual, Repository } from 'typeorm';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { CoinService } from '../ai/coin.service';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import { TierConfig } from '../ai/entities/tier-config.entity';
import { LlmService } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { Application } from '../applications/application.entity';
import { startOfTodayKst } from '../common/datetime';
import { COMPANY_RESEARCH_ALLOWED_DOMAINS } from './company-research-whitelist';
import { CompanyResearchCache } from './entities/company-research-cache.entity';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';

/**
 * F6 PR 2 Phase 4 단계 B — 회사 조사 (Anthropic Claude haiku + web_search).
 *
 * **흐름**:
 * 1. 사용자가 session 의 "🔍 회사 조사" 버튼 클릭
 * 2. session.applicationId → application.companyName + jobCategory 추출
 * 3. cache (정규화 key) 조회:
 *    - hit + 90일 안 + opt_out=false → hit_count++ + 반환
 *    - opt_out=true → 빈 응답 + 안내
 *    - miss/expired → quota check → LLM web_search → 8 항목 추출 → cache upsert
 * 4. 응답 = ai_research JSONB + sources[] + isCached flag
 *
 * **법적 안전장치**:
 * - 화이트리스트 도메인만 (Anthropic web_search `allowed_domains`)
 * - 원문 직접 저장 X — AI 요약 (derivative work, fair use)
 * - opt_out 24시간 SLA
 * - 사용자 메모 (session.userResearchNotes) 는 별도 컬럼 (책임 분리)
 *
 * **garbage 입력 방어**:
 * - application.companyName 사용 (이미 검증된 데이터)
 * - cache miss 결과도 캐싱 (60일) — 같은 회사 무한 재시도 차단
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

/**
 * PR 보강 Phase 1 — system prompt 강화 + few-shot example.
 *
 * 1. 기준일 KST 동적 inject
 * 2. 11 항목 + sources/inferredFields optional
 * 3. Few-shot — 카카오 예시 1건 inline (LLM 응답 형식 학습)
 * 4. 항목 길이 가이드는 prompt cache 활용 (Anthropic ephemeral cache_read 90% 할인)
 */
function buildSystemPrompt(kstToday: string): string {
  return `너는 한국 취준생을 위한 기업 면접 준비 보조다.

**오늘은 ${kstToday} KST 입니다.** "최근"·"올해" 등 시간 표현 시 반드시 기간 (예: 2025-12 ~ 2026-06) 을 명시.

회사·직무 정보를 web_search 로 조사해 11 항목을 JSON 으로 반환.

**필수 8**: businessSummary·coreValues·visionMission·recentTrends·financials·competitors·jobInsights·interviewKeywords
**신규 3**: companyProfile·talentProfile·productsAndTech

**interviewKeywords** = [{ keyword, category }] 배열. category 는 tech / talent / business / role / issue 중 하나.

**예시** (이 형식 그대로 따라가):
\`\`\`json
{
  "businessSummary": "카카오톡 메신저와 카카오페이·카카오뱅크 등 금융·모빌리티 사업을 운영합니다.",
  "coreValues": "도전·성장·신뢰. 변화를 즐기는 사람을 환영합니다.",
  "visionMission": "사람과 기술로 더 나은 세상을 만들겠다.",
  "recentTrends": "2024년부터 글로벌 AI 사업 확대, 카카오톡 챗봇 강화.",
  "financials": "2023 매출 7.6조, 2024 매출 8.3조 (+9%).",
  "competitors": "네이버, 라인, 페이코 등.",
  "jobInsights": "백엔드 직무는 MSA·Kafka·K8s 경험과 대규모 트래픽 처리 경험을 요구합니다.",
  "interviewKeywords": [
    { "keyword": "MSA 설계 경험", "category": "tech" },
    { "keyword": "도전 정신", "category": "talent" },
    { "keyword": "글로벌 AI 전략", "category": "business" }
  ],
  "companyProfile": { "founded": "1995", "hq": "제주 제주시", "industry": "IT서비스", "size": "대기업 (5천명)" },
  "talentProfile": ["도전", "성장", "신뢰"],
  "productsAndTech": {
    "products": ["카카오톡", "카카오페이", "카카오뱅크"],
    "techStack": ["Spring Boot", "Kotlin", "Kafka", "K8s"]
  },
  "inferredFields": ["interviewKeywords"],
  "sources": [
    { "id": 1, "title": "카카오 회사 소개", "url": "https://ko.wikipedia.org/wiki/카카오", "domain": "ko.wikipedia.org" }
  ]
}
\`\`\`

규칙:
- 정보 부족하면 빈 값 ("" / [] / {})
- 가짜 사실·통계·출처 금지 (학습 데이터만 사용 시 inferredFields 에 항목명 추가)
- 잡플래닛·블라인드 같은 후기 사이트 금지
- 임원 이름·연락처 등 개인정보 금지
- 응답은 한국어

**중요**: web_search 로 검색한 후 **반드시** company_research tool 을 호출하여 위 11 항목을 JSON 으로 반환하세요.
정보가 부족하더라도 빈 값으로 채워서 반드시 tool 을 호출하세요. text 응답으로 끝내지 마세요.`;
}

const RESEARCH_JSON_SCHEMA = {
  name: 'company_research',
  schema: {
    type: 'object',
    properties: {
      businessSummary: { type: 'string' },
      coreValues: { type: 'string' },
      visionMission: { type: 'string' },
      recentTrends: { type: 'string' },
      financials: { type: 'string' },
      competitors: { type: 'string' },
      jobInsights: { type: 'string' },
      interviewKeywords: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            keyword: { type: 'string' },
            category: {
              type: 'string',
              enum: ['tech', 'talent', 'business', 'role', 'issue'],
            },
          },
          required: ['keyword', 'category'],
          additionalProperties: false,
        },
      },
      companyProfile: {
        type: 'object',
        properties: {
          founded: { type: 'string' },
          hq: { type: 'string' },
          industry: { type: 'string' },
          size: { type: 'string' },
        },
        // OpenAI strict mode 요구 — nested object 의 모든 properties required
        required: ['founded', 'hq', 'industry', 'size'],
        additionalProperties: false,
      },
      talentProfile: {
        type: 'array',
        items: { type: 'string' },
      },
      productsAndTech: {
        type: 'object',
        properties: {
          products: { type: 'array', items: { type: 'string' } },
          techStack: { type: 'array', items: { type: 'string' } },
        },
        required: ['products', 'techStack'],
        additionalProperties: false,
      },
      inferredFields: {
        type: 'array',
        items: { type: 'string' },
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            url: { type: 'string' },
            domain: { type: 'string' },
            publishedAt: { type: 'string' },
          },
          required: ['id', 'title', 'url', 'domain'],
          additionalProperties: false,
        },
      },
    },
    // PR 보강 — required 단순화: 본문 8 + 신규 3 만 required, sources/inferredFields optional
    //   LLM 응답이 schema 강제 안 받음 → JSON parse 실패 ↓ → 첫 호출 성공 확률 ↑
    required: [
      'businessSummary',
      'coreValues',
      'visionMission',
      'recentTrends',
      'financials',
      'competitors',
      'jobInsights',
      'interviewKeywords',
      'companyProfile',
      'talentProfile',
      'productsAndTech',
    ],
    additionalProperties: false,
  },
};

/** PR 보강 — Cache TTL 90 → 30일 (신규 row 만, 기존 90일 row 그대로) */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** miss 결과도 60일 캐싱 — 같은 회사 무한 재시도 차단 */
const MISS_CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

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
    @InjectRepository(LlmCallLog)
    private readonly llmCallLogRepo: Repository<LlmCallLog>,
    @InjectRepository(TierConfig)
    private readonly tierRepo: Repository<TierConfig>,
    private readonly llm: LlmService,
    private readonly quotaCheck: QuotaCheckService,
    private readonly abuserBan: AbuserBanService,
    private readonly coinService: CoinService,
  ) {}

  /** 정규화: lowercase + trim. 같은 회사 다른 표기 (대소문자·공백) cache 공유 */
  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  /**
   * PR 보강 — KST 기준일 (YYYY-MM-DD) 동적 생성.
   * LLM prompt 에 "오늘은 ${kstToday}" inject → "최근 1년" 시간 명시 강제.
   */
  private formatKstToday(): string {
    const now = new Date();
    // UTC + 9 = KST
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  /**
   * PR 보강 — application.jobUrl 의 회사 공식 도메인 추출.
   * 동적 화이트리스트 추가 — 회사 자체 사이트가 가장 정확한 정보원.
   *
   * 예: "https://www.kakaopay.com/recruit" → ["kakaopay.com", "careers.kakaopay.com"]
   * 잘못된 URL · 파싱 실패 → 빈 배열 fallback (정적 화이트리스트만 사용)
   */
  private extractCompanyDomain(jobUrl: string | null | undefined): string[] {
    if (!jobUrl?.trim()) return [];
    try {
      const url = new URL(jobUrl);
      // javascript: / data: / file: 등 차단 (보안)
      if (!['http:', 'https:'].includes(url.protocol)) return [];
      const host = url.hostname.toLowerCase();
      // www. 제거 + careers./about. 같은 채용 서브도메인도 함께 화이트리스트
      const apex = host.replace(/^www\./, '');
      return [apex, `careers.${apex}`, `about.${apex}`, `recruit.${apex}`];
    } catch {
      return [];
    }
  }

  /**
   * PR 보강 — sources[] 의 hallucination 가드.
   *
   * 검증:
   * 1. url 파싱 가능 + http/https 만 (보안)
   * 2. publishedAt 미래 날짜 X (fake 출처 방어)
   * 3. domain 이 allowedDomains 안에 포함 (외부 도메인 strip)
   * 4. id 중복 제거
   */
  private validateSources(
    sources: ResearchSource[],
    allowedDomains: string[],
  ): ResearchSource[] {
    const allowed = new Set(allowedDomains.map((d) => d.toLowerCase()));
    const seenIds = new Set<number>();
    const now = new Date();
    return sources.filter((s) => {
      if (!s || typeof s.id !== 'number' || seenIds.has(s.id)) return false;
      if (!s.url || !s.title || !s.domain) return false;
      try {
        const u = new URL(s.url);
        if (!['http:', 'https:'].includes(u.protocol)) return false;
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        // allowed 도메인 또는 그 subdomain 매칭
        const isAllowed = [...allowed].some(
          (d) => host === d || host.endsWith('.' + d),
        );
        if (!isAllowed) return false;
      } catch {
        return false;
      }
      if (s.publishedAt) {
        const pub = new Date(s.publishedAt);
        if (!isNaN(pub.getTime()) && pub > now) return false; // 미래 = fake
      }
      seenIds.add(s.id);
      return true;
    });
  }

  /**
   * PR 보강 — 본문 [N] 마커 hallucination 가드 + Anthropic <cite> 태그 strip.
   *
   * 응답 본문에서:
   * 1. <cite index="...">...</cite> 태그 제거 (Anthropic web_search 의 자동 citation)
   * 2. [N] 마커 추출 → validIds 외 strip
   */
  private stripOrphanFootnotes(
    research: CompanyResearchData,
    validIds: number[],
  ): CompanyResearchData {
    const validSet = new Set(validIds);
    const stripField = (text: string | undefined): string => {
      const cleaned = (text ?? '')
        // Anthropic web_search 의 <cite index="..."> 태그 제거 (내용은 보존)
        .replace(/<cite\b[^>]*>/gi, '')
        .replace(/<\/cite>/gi, '');
      // [N] 마커 — validIds 외 strip
      return cleaned.replace(/\[(\d+)\]/g, (match, num: string) =>
        validSet.has(Number(num)) ? match : '',
      );
    };
    return {
      ...research,
      businessSummary: stripField(research.businessSummary),
      coreValues: stripField(research.coreValues),
      visionMission: stripField(research.visionMission),
      recentTrends: stripField(research.recentTrends),
      financials: stripField(research.financials),
      competitors: stripField(research.competitors),
      jobInsights: stripField(research.jobInsights),
    };
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

  /** PR 보강 — inferredFields 검증 (schema 외 field name strip) */
  private isValidFieldName(field: string): boolean {
    return [
      'businessSummary',
      'coreValues',
      'visionMission',
      'recentTrends',
      'financials',
      'competitors',
      'jobInsights',
      'interviewKeywords',
      'companyProfile',
      'talentProfile',
      'productsAndTech',
    ].includes(field);
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
  private async findCacheRow(
    companyName: string,
    jobCategory: string | null,
  ): Promise<CompanyResearchCache | null> {
    return this.cacheRepo
      .createQueryBuilder('c')
      .where('c.company_name = :name', { name: this.normalize(companyName) })
      .andWhere(
        jobCategory ? 'c.job_category = :job' : 'c.job_category IS NULL',
        jobCategory ? { job: jobCategory } : {},
      )
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
    return this.buildResultFromCache(row);
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
   * 자소서 풀페이지 — 캐시 우선 fetch, miss/expired 시 LLM 호출.
   * fetchForSession 과 동일 흐름 (quota check + LLM 호출 + cache upsert).
   */
  async fetchForApplication(
    userId: string,
    applicationId: string,
  ): Promise<CompanyResearchResult> {
    const { companyName, jobCategory, jobUrl } =
      await this.resolveCompanyFromApplication(userId, applicationId);
    return this.fetchByCompany(userId, companyName, jobCategory, {
      resourceType: 'application_coverletter',
      resourceId: applicationId,
      jobUrl,
    });
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
    if (row.expiresAt < new Date()) return null; // 만료 — 다시 fetch 필요
    return this.buildResultFromCache(row);
  }

  /**
   * 캐시 우선 fetch — miss/expired 시 LLM 호출.
   * quota check + abuser ban override 통합 (모든 LLM caller 동일 패턴).
   */
  async fetchForSession(
    userId: string,
    sessionId: string,
  ): Promise<CompanyResearchResult> {
    const { companyName, jobCategory, jobUrl } =
      await this.resolveCompanyFromSession(userId, sessionId);
    return this.fetchByCompany(userId, companyName, jobCategory, {
      resourceType: 'interview_prep_session',
      resourceId: sessionId,
      jobUrl,
    });
  }

  /**
   * 회사명·직무로 직접 fetch (resource 메타 명시).
   * fetchForSession / fetchForApplication 공통 흐름.
   */
  private async fetchByCompany(
    userId: string,
    companyName: string,
    jobCategory: string | null,
    resource: {
      resourceType: string;
      resourceId: string;
      jobUrl?: string | null;
    },
  ): Promise<CompanyResearchResult> {
    // 1. cache 조회
    const cached = await this.findCacheRow(companyName, jobCategory);
    if (cached) {
      if (cached.optOut) {
        return {
          status: 'opt_out',
          reason: '이 회사는 정보 수집 동의가 철회됐어요.',
        };
      }
      if (cached.expiresAt > new Date()) {
        cached.hitCount += 1;
        await this.cacheRepo.save(cached);
        return this.buildResultFromCache(cached);
      }
    }

    // PR_B1 — 회사 조사 tier 별 cap (cache miss 일 N회). web_search_count > 0 인 호출만 카운트
    const balance = await this.coinService.getBalanceWithLazyReset(userId);
    const tierConfig = await this.tierRepo.findOne({
      where: { tier: balance.tier },
    });
    if (tierConfig) {
      const todayCacheMissCount = await this.llmCallLogRepo.count({
        where: {
          userId,
          feature: 'company_research',
          webSearchCount: MoreThan(0),
          createdAt: MoreThanOrEqual(startOfTodayKst()),
        },
      });
      if (todayCacheMissCount >= tierConfig.companyResearchDailyCap) {
        return {
          status: 'blocked',
          reason: `오늘 회사 조사 한도 도달 (${tierConfig.companyResearchDailyCap}/${tierConfig.companyResearchDailyCap}). 내일 다시 시도하거나 Pro 결제로 한도 확장 가능`,
        };
      }
    }

    // PR_B1 — cache 재조회 (race window: cap check 도중 다른 user 가 채웠을 수 있음)
    const cacheRetry = await this.findCacheRow(companyName, jobCategory);
    if (cacheRetry && cacheRetry.expiresAt > new Date() && !cacheRetry.optOut) {
      cacheRetry.hitCount += 1;
      await this.cacheRepo.save(cacheRetry);
      return this.buildResultFromCache(cacheRetry);
    }

    // 2. quota check (3중 가드 — cooldown·feature_quota_configs)
    const quota = await this.quotaCheck.checkAndPrepare(
      userId,
      'company_research',
    );
    if (quota.blocked) {
      await this.llm.call({
        userId,
        feature: 'company_research',
        systemPrompt: '',
        userPrompt: '',
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: `${quota.code}: ${quota.reason}`,
      });
      if (quota.code === 'DAY_LIMIT') {
        void this.abuserBan
          .checkAndBan(userId, 'company_research', 1)
          .catch((err: unknown) =>
            this.logger.warn(
              `AbuserBan check 실패 (user=${userId}): ${(err as Error).message}`,
            ),
          );
      }
      return { status: 'blocked', reason: quota.reason };
    }

    // 3. LLM 호출
    // PR 보강 — KST 기준일 + 직무 입장 + application.jobUrl 의 회사 공식 도메인 동적 추가
    const kstToday = this.formatKstToday();
    const systemPrompt = buildSystemPrompt(kstToday);
    const userPrompt =
      `# 회사명\n${companyName}\n\n` +
      (jobCategory ? `# 직무 (지원자 입장)\n${jobCategory}\n\n` : '') +
      `위 회사·직무에 대해 화이트리스트 도메인을 검색해 11 항목을 정확히 채워주세요.\n` +
      `모르면 빈 값. 출처 없으면 본문 표시 X. inferred 항목은 inferredFields 명시.`;

    // PR 보강 — application.jobUrl 의 회사 공식 도메인 추출 후 화이트리스트 동적 추가
    const dynamicDomains = this.extractCompanyDomain(resource.jobUrl);
    const allowedDomains = [
      ...COMPANY_RESEARCH_ALLOWED_DOMAINS,
      ...dynamicDomains,
    ];

    let result = await this.llm.call({
      userId,
      feature: 'company_research',
      systemPrompt,
      userPrompt,
      jsonSchema: RESEARCH_JSON_SCHEMA,
      webSearch: {
        allowedDomains,
        maxUses: 5, // PR 보강 — 3 → 5 (항목 11개 수집 위해)
      },
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
    });

    // 2-tier Fallback (PR 보강):
    //   Tier 1: 풀 화이트리스트 (위) — 정상 케이스
    //   Tier 2: 위키 + 공식 도메인만 (한국 신문사 차단 시)
    //   Tier 3: web_search off + 학습 데이터 + "확인 필요" 라벨
    if (
      result.status !== 'ok' &&
      result.errorMessage?.includes('not accessible to our user agent')
    ) {
      this.logger.warn(
        `web_search 도메인 차단 Tier 1 (company=${companyName}) → Tier 2 (위키+공식 만)`,
      );
      const tier2Domains = [
        'ko.wikipedia.org',
        'en.wikipedia.org',
        ...dynamicDomains,
      ];
      result = await this.llm.call({
        userId,
        feature: 'company_research',
        systemPrompt,
        userPrompt,
        jsonSchema: RESEARCH_JSON_SCHEMA,
        webSearch: { allowedDomains: tier2Domains, maxUses: 3 },
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      });

      if (
        result.status !== 'ok' &&
        result.errorMessage?.includes('not accessible to our user agent')
      ) {
        this.logger.warn(
          `Tier 2 도 차단 → Tier 3 (web_search off + 학습 데이터)`,
        );
        result = await this.llm.call({
          userId,
          feature: 'company_research',
          systemPrompt,
          userPrompt:
            userPrompt +
            '\n\n(검색 도구 사용 불가. 학습 데이터 기반 정보만 채우세요. 확실하지 않으면 빈 값 + inferredFields 에 포함.)',
          jsonSchema: RESEARCH_JSON_SCHEMA,
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
        });
      }
    }

    if (result.status !== 'ok') {
      return {
        status: 'blocked',
        reason: '회사 조사 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
      };
    }

    // cost hardening 🟡4 — LLM ok 시점에 50코인이 이미 차감됨.
    // 후처리·캐시 저장 실패는 사용자 귀책이 아니므로 best-effort 환불 후 rethrow
    // (없으면 사용자가 재시도할 때마다 50코인 이중 차감).
    try {
      // PR 보강 — 응답 후처리: hallucination 가드 (본문 [N] ↔ sources[].id 일치 검증)
      const rawResearch =
        (result.json as CompanyResearchData & {
          sources?: ResearchSource[];
          inferredFields?: string[];
        }) ?? {};
      const validatedSources = this.validateSources(
        rawResearch.sources ?? [],
        allowedDomains,
      );
      const sanitizedResearch = this.stripOrphanFootnotes(
        rawResearch,
        validatedSources.map((s) => s.id),
      );
      const inferredFields = (rawResearch.inferredFields ?? []).filter((f) =>
        this.isValidFieldName(f),
      );
      // PR 보강 — interviewKeywords 후처리 (LLM 이 string 만 반환 시 category 자동 추론)
      const enrichedKeywords = this.enrichInterviewKeywords(
        sanitizedResearch.interviewKeywords,
      );
      // PR 보강 — aiResearch JSONB 안에 ResearchSource[] 객체 + inferredFields 인라인 저장
      //   (entity.sources string[] 컬럼은 legacy 호환 — url 만 backfill)
      const aiResearch: CompanyResearchData & {
        sources?: ResearchSource[];
        inferredFields?: string[];
      } = {
        ...sanitizedResearch,
        interviewKeywords: enrichedKeywords,
        sources: validatedSources,
        inferredFields,
      };
      const legacySourceUrls = validatedSources.map((s) => s.url);

      // 4. cache upsert
      const isEmpty =
        !aiResearch.businessSummary?.trim() &&
        !aiResearch.recentTrends?.trim() &&
        (!aiResearch.interviewKeywords ||
          aiResearch.interviewKeywords.length === 0);
      const ttl = isEmpty ? MISS_CACHE_TTL_MS : CACHE_TTL_MS;
      const expiresAt = new Date(Date.now() + ttl);

      const row =
        cached ??
        this.cacheRepo.create({
          companyName: this.normalize(companyName),
          jobCategory,
          hitCount: 0,
          optOut: false,
        });
      row.aiResearch = aiResearch as Record<string, unknown>;
      row.sources = legacySourceUrls;
      row.expiresAt = expiresAt;
      row.hitCount = (row.hitCount ?? 0) + 1;
      const saved = await this.cacheRepo.save(row);

      return {
        status: 'ok',
        research: aiResearch,
        sources: validatedSources,
        inferredFields,
        isCached: false,
        cachedAt: saved.updatedAt,
      };
    } catch (err) {
      const refundResult = await this.coinService
        .refund(userId, 'company_research', '회사조사 후처리 실패 자동 환불')
        .catch((refundErr: unknown) => {
          this.logger.error(
            `후처리 실패 환불도 실패 (userId=${userId}): ${(refundErr as Error).message}`,
          );
          return { refunded: 0 };
        });
      this.logger.warn(
        `회사조사 후처리 실패 → ${refundResult.refunded} 코인 환불 (userId=${userId})`,
      );
      throw err;
    }
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

  /** URL 추출 + 화이트리스트 필터 */
  private extractSources(text: string): string[] {
    const urlPattern = /https?:\/\/[^\s)]+/g;
    const matches = text.match(urlPattern) ?? [];
    const allowed = new Set(
      COMPANY_RESEARCH_ALLOWED_DOMAINS as readonly string[],
    );
    return Array.from(
      new Set(
        matches.filter((url) => {
          try {
            const host = new URL(url).hostname.replace(/^www\./, '');
            return Array.from(allowed).some(
              (d) => host === d || host.endsWith(`.${d}`),
            );
          } catch {
            return false;
          }
        }),
      ),
    );
  }
}
