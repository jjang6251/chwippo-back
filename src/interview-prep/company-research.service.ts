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

export interface CompanyResearchData {
  businessSummary?: string;
  coreValues?: string;
  visionMission?: string;
  recentTrends?: string;
  financials?: string;
  competitors?: string;
  jobInsights?: string;
  interviewKeywords?: string[];
}

export interface CompanyResearchResult {
  status: 'ok' | 'blocked' | 'opt_out';
  research?: CompanyResearchData;
  sources?: string[];
  isCached?: boolean;
  cachedAt?: Date;
  reason?: string;
}

const SYSTEM_PROMPT = `너는 한국 취준생을 위한 기업 면접 준비 보조다.

회사·직무 정보를 web_search 로 조사해 다음 8 항목을 JSON 으로 반환:
- businessSummary: 사업 영역 한 줄
- coreValues: 인재상·핵심가치
- visionMission: 회사 비전·미션
- recentTrends: 최근 사업 동향·신사업 (지난 1년)
- financials: 재무·매출 트렌드 3년
- competitors: 경쟁사·시장 포지셔닝
- jobInsights: 직무 일반 정보 (해당 직무 요구 스킬·트렌드)
- interviewKeywords: 예상 면접 질문 키워드 (회사·직무 특화) 배열

엄격한 규칙:
- 모르거나 정보 부족하면 해당 항목 빈 문자열 "" 또는 빈 배열 []
- 절대 가짜 사실·통계·날짜를 만들지 마라
- 검색 결과 없으면 일반론으로 답해도 되지만 추측 명시 ("일반적으로 ~")
- 잡플래닛·블라인드·Glassdoor 같은 후기 사이트 정보 사용 금지 (검색 도메인 화이트리스트 적용됨)
- 임원 이름·연락처 같은 개인정보 절대 포함 금지
- 모든 응답은 한국어`;

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
        items: { type: 'string' },
      },
    },
    required: [
      'businessSummary',
      'coreValues',
      'visionMission',
      'recentTrends',
      'financials',
      'competitors',
      'jobInsights',
      'interviewKeywords',
    ],
    additionalProperties: false,
  },
};

/** 90일 TTL */
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
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

  /** session → application → companyName/jobCategory 추출. 본인 소유 검증 */
  private async resolveCompanyFromSession(
    userId: string,
    sessionId: string,
  ): Promise<{
    session: InterviewPrepSession;
    companyName: string;
    jobCategory: string | null;
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
  ): Promise<{ companyName: string; jobCategory: string | null }> {
    const app = await this.appRepo.findOne({
      where: { id: applicationId, userId },
    });
    if (!app) throw new NotFoundException('지원 카드를 찾을 수 없습니다.');
    return {
      companyName: app.companyName,
      jobCategory: app.jobCategory ?? null,
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
    return {
      status: 'ok',
      research: row.aiResearch,
      sources: row.sources,
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
    const { companyName, jobCategory } =
      await this.resolveCompanyFromApplication(userId, applicationId);
    return this.fetchByCompany(userId, companyName, jobCategory, {
      resourceType: 'application_coverletter',
      resourceId: applicationId,
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
    return {
      status: 'ok',
      research: row.aiResearch,
      sources: row.sources,
      isCached: true,
      cachedAt: row.updatedAt,
    };
  }

  /**
   * 캐시 우선 fetch — miss/expired 시 LLM 호출.
   * quota check + abuser ban override 통합 (모든 LLM caller 동일 패턴).
   */
  async fetchForSession(
    userId: string,
    sessionId: string,
  ): Promise<CompanyResearchResult> {
    const { companyName, jobCategory } = await this.resolveCompanyFromSession(
      userId,
      sessionId,
    );
    return this.fetchByCompany(userId, companyName, jobCategory, {
      resourceType: 'interview_prep_session',
      resourceId: sessionId,
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
    resource: { resourceType: string; resourceId: string },
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
        return {
          status: 'ok',
          research: cached.aiResearch,
          sources: cached.sources,
          isCached: true,
          cachedAt: cached.updatedAt,
        };
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
      return {
        status: 'ok',
        research: cacheRetry.aiResearch,
        sources: cacheRetry.sources,
        isCached: true,
        cachedAt: cacheRetry.updatedAt,
      };
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
    const userPrompt =
      `# 회사명\n${companyName}\n\n` +
      (jobCategory ? `# 직무\n${jobCategory}\n\n` : '') +
      `위 회사·직무에 대해 화이트리스트 도메인을 검색해 8 항목을 정확히 채워주세요. 모르면 빈 문자열/빈 배열.`;

    let result = await this.llm.call({
      userId,
      feature: 'company_research',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      jsonSchema: RESEARCH_JSON_SCHEMA,
      webSearch: {
        allowedDomains: [...COMPANY_RESEARCH_ALLOWED_DOMAINS],
        maxUses: 3,
      },
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
    });

    // Fallback — Anthropic 가 화이트리스트 도메인 crawl 거부 (400) 시
    // web_search 없이 1회 retry. Claude 학습 데이터 기반 정보 활용.
    // 카카오뱅크 같은 유명 회사는 학습 데이터로 충분, 작은 회사는 부족하지만 차단 회피.
    if (
      result.status !== 'ok' &&
      result.errorMessage?.includes('not accessible to our user agent')
    ) {
      this.logger.warn(
        `web_search 도메인 차단 (company=${companyName}) → 도구 없이 retry`,
      );
      result = await this.llm.call({
        userId,
        feature: 'company_research',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt:
          userPrompt +
          '\n\n(검색 도구를 사용할 수 없습니다. 학습 데이터 기반으로 가능한 정보만 채우세요. 확실하지 않으면 빈 문자열/빈 배열.)',
        jsonSchema: RESEARCH_JSON_SCHEMA,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      });
    }

    if (result.status !== 'ok') {
      return {
        status: 'blocked',
        reason: '회사 조사 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
      };
    }

    const aiResearch = (result.json as CompanyResearchData) ?? {};
    const sources = this.extractSources(result.text);

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
    row.sources = sources;
    row.expiresAt = expiresAt;
    row.hitCount = (row.hitCount ?? 0) + 1;
    const saved = await this.cacheRepo.save(row);

    return {
      status: 'ok',
      research: aiResearch,
      sources,
      isCached: false,
      cachedAt: saved.updatedAt,
    };
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
