import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import { LlmService, PROVIDER_OUTAGE_USER_MESSAGE } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { todayKst } from '../common/datetime';
import { User } from '../users/user.entity';
import { CompanyResearchCache } from '../interview-prep/entities/company-research-cache.entity';
import { Application } from './application.entity';
import { ApplicationsService } from './applications.service';
import {
  CommitFromPostingDto,
  CreateFromPostingDto,
} from './dto/job-posting-card.dto';
import { buildCardSystemPrompt, CARD_SCHEMA } from './job-posting-card.prompt';
import {
  buildDraft,
  normalizeCardOutput,
  resolveJob,
  stripCompanyAffix,
  MAX_COMPANY_LEN,
  type CardDraft,
} from './job-posting-card.rules';
import { PostingDraftStore } from './posting-draft.store';

/**
 * 보완 질문 대기 카드 — 새로고침 후 「생성 중 카드」를 되살리는 데 **필요한 만큼만**.
 *
 * 🔴 초안 본문(`CardDraft`)은 절대 나가지 않는다. 나가면 클라이언트가 그것을 손봐서
 * 되돌려 보낼 수 있고, 파싱하지 않은 값이 「AI 가 채운 칸」으로 저장된다.
 */
export interface PendingPostingSummary {
  hash: string;
  needs: 'company' | 'job';
  /** needs='job' 일 때 고를 후보 (공고 표기 그대로). 그 외엔 [] */
  candidates: string[];
  companyName: string | null;
  jobTitle: string | null;
  /** 초안을 만든 시각 (ISO). 프론트가 「생성 중」 카드 정렬·경과 표시에 쓴다 */
  createdAt: string | null;
}

/** `GET /applications/from-posting/pending` 응답 봉투 */
export interface PendingPostingResponse {
  drafts: PendingPostingSummary[];
}

export type FromPostingBlockCode =
  | 'QUOTA_EXCEEDED'
  | 'CONSENT_REQUIRED'
  | 'TOO_MANY_PENDING'
  | 'ERROR';

/**
 * 응답 봉투 4갈래 — 기존 파서 관례대로 **200 + 봉투**다 (에러 코드로 갈래를 나누지 않는다).
 *
 * 🔴 `blocked` 를 generic ERROR 하나로 뭉개지 않는다. 동의 미완을 「실패했어요」로 보여주면
 * 사용자는 **해결할 수 있는데도 막다른 길**로 읽는다 (2026-07 실사고).
 */
export type FromPostingResult =
  | { card: Application }
  | {
      needs: 'company' | 'job';
      hash: string;
      /** needs='job' 일 때 고를 후보 (공고 표기 그대로) */
      candidates: string[];
      /** 프로필 희망 직무와 글자가 맞은 후보 — 「내 직무와 가까움」 배지 */
      nearProfile: string[];
      /** needs='job' 일 때 이미 찾은 회사명 (카드 미리보기용) */
      companyName: string | null;
    }
  | { notPosting: true }
  | { blocked: true; code: FromPostingBlockCode; reason: string };

/**
 * 공고 붙여넣기 → 카드 (대장 21 · 2026-08-29).
 *
 * 흐름: 위생·해시 → **같은 원문 재요청 차단** → 진행 슬롯 → quota 선차단 →
 *       LLM(strict json) → normalize → 서버 규칙 → 봉투 or 카드 생성(한 TX).
 *
 * 🔴 원문(`rawText`)은 저장·응답 어디에도 남지 않는다. 남는 것은 sha256 과
 *    `llm_call_logs` 의 PII 스크럽된 200자 발췌뿐이다 (기존 `jobposting_parse` 와 같은 정책).
 */
@Injectable()
export class JobPostingCardService {
  private readonly logger = new Logger(JobPostingCardService.name);

  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly llm: LlmService,
    private readonly quotaCheck: QuotaCheckService,
    private readonly drafts: PostingDraftStore,
    private readonly applications: ApplicationsService,
    /** 조사 캐시 — 엔티티만 주입 (InterviewPrepModule 서비스 주입은 순환 표면을 키운다) */
    @InjectRepository(CompanyResearchCache)
    private readonly researchRepo: Repository<CompanyResearchCache>,
  ) {}

  /**
   * 파싱된 회사명이 **우리가 조사해 둔 회사**(시드 본명·별칭)면 그 표시용 표기로 되돌린다.
   *
   * 공고엔 「SK hynix」와 「SK하이닉스」가 같이 적혀 있어 모델이 번갈아 골랐고, 그러면 같은 회사
   * 카드가 두 이름으로 갈리며 절반은 조사가 안 붙었다 (CEO 실기 8/30). 규칙은 하나 —
   * **있으면 그 회사로, 없으면 파싱된 이름 그대로.** 사용자가 직접 적은 회사명(commit 경로)은
   * 건드리지 않는다 (사람 말만 볼펜). 조회 실패는 정규화만 포기하고 카드는 만든다.
   */
  private async canonicalCompanyName(
    name: string | null,
  ): Promise<string | null> {
    if (!name) return name;
    try {
      const row = await this.researchRepo.findOne({
        where: {
          companyName: name.trim().toLowerCase(),
          jobCategory: IsNull(),
        },
        select: ['id', 'canonicalName'],
      });
      const canonical = row?.canonicalName?.trim();
      return canonical ? canonical : name;
    } catch (e) {
      this.logger.warn(
        `회사명 정규화 조회 실패 — 파싱값 유지 (${String(e).slice(0, 80)})`,
      );
      return name;
    }
  }

  // ── POST /applications/from-posting ───────────────────────────────────

  async parseAndCreate(
    userId: string,
    dto: CreateFromPostingDto,
  ): Promise<FromPostingResult> {
    const rawText = dto.rawText;
    const textHash = sha256(rawText);
    const jobContext = dto.jobContext?.trim() || null;

    // ① 같은 원문 10분 내 재요청 → 새로 만들지 않고 **그때 만든 카드**를 돌려준다.
    //    클라이언트 해시 차단은 새로고침 한 번에 사라지므로 여기가 진짜 방어선이다.
    const existing = await this.recallExistingCard(userId, textHash);
    if (existing) return { card: existing };

    // ② 진행 중 3장 — 초과분은 LLM 을 부르지 않는다 (돈이 나가는 자리 앞에서 막는다)
    const slot = await this.drafts.acquireSlot(userId);
    if (slot === null) {
      return {
        blocked: true,
        code: 'TOO_MANY_PENDING',
        reason: '먼저 만든 카드가 끝나면 이어서 만들어 드릴게요.',
      };
    }

    try {
      // ③ quota 선차단 — admin 통제 단일 진입점 (코드에서 건너뛰지 않는다)
      const quota = await this.quotaCheck.checkAndPrepare(
        userId,
        'jobposting_card',
      );
      if (quota.blocked) {
        // provider 미호출 audit row — 「막혔다」도 기록이 있어야 admin 이 본다
        await this.llm.call({
          userId,
          feature: 'jobposting_card',
          systemPrompt: '',
          userPrompt: '',
          resourceType: 'user',
          resourceId: userId,
          preBlockedStatus: 'blocked_quota',
          preBlockedReason: `${quota.code}: ${quota.reason}`,
        });
        return { blocked: true, code: 'QUOTA_EXCEEDED', reason: quota.reason };
      }

      const today = todayKst();
      const ctxBlock = jobContext
        ? `# 지원 직무 (이 직무 요건·일정만 추출)\n${jobContext}\n\n`
        : '';
      // 사용자 입력은 전부 user 역할 · 코드블록 격리 (system 프롬프트에 절대 안 섞인다)
      const userPrompt = `${ctxBlock}# 파싱할 공고 텍스트\n\`\`\`\n${rawText}\n\`\`\``;

      const result = await this.llm.call({
        userId,
        feature: 'jobposting_card',
        systemPrompt: buildCardSystemPrompt(today),
        userPrompt,
        resourceType: 'user',
        resourceId: userId,
        jsonSchema: CARD_SCHEMA,
      });

      if (result.status !== 'ok') {
        return this.blockedFromLlm(result.status, result.errorKind);
      }

      // 🔴 `as` 단언 금지 — `result.json` 은 status='ok' 여도 undefined 일 수 있다
      const out = normalizeCardOutput(result.json);
      const draft = buildDraft({
        out,
        todayKst: today,
        jobContext,
        profileJobTitle: await this.profileJobTitle(userId),
      });

      if (draft.notPosting) return { notPosting: true };
      // 「우리가 조사해 둔 회사면 그 표기로」 — needs 판정·초안 저장보다 먼저 (초안에도 표준 표기가 남게)
      draft.companyName = await this.canonicalCompanyName(draft.companyName);

      const needs = this.needsOf(draft);
      if (needs) {
        await this.drafts.saveDraft(userId, textHash, needs, draft);
        return {
          needs,
          hash: textHash,
          candidates: draft.jobTitles,
          nearProfile: draft.nearProfile,
          companyName: draft.companyName,
        };
      }

      const card = await this.createCard(
        userId,
        draft,
        textHash,
        jobContext ? 2 : 1,
      );
      return { card };
    } finally {
      await this.drafts.releaseSlot(userId, slot);
    }
  }

  // ── POST /applications/from-posting/commit ────────────────────────────

  /**
   * 보완 질문에 답하고 카드 생성 — **LLM 을 부르지 않는다** (차감 0).
   *
   * 🔴 회사명 보완에 2차 파싱이 없는 이유: 회사명은 요건·일정을 바꾸지 않는다.
   *    한 번 더 부르면 돈과 시간만 쓰고 결과가 같다 (또는 미묘하게 달라져 더 나쁘다).
   *
   * ⚠️ **직무 보완도 여기서는 재파싱하지 않는다.** 부문별 요건을 다시 뽑으려면 원문이
   *    필요한데 서버는 원문을 보관하지 않기 때문이다(금지선). 정상 흐름에서 직무 선택은
   *    프론트가 원문을 들고 `POST /from-posting` 을 `jobContext` 와 함께 다시 호출해
   *    2차 파싱을 태운다. 이 경로는 **새로고침으로 원문을 잃은 뒤의 복구용**이다 —
   *    카드는 만들어지고, 요건만 1차 파싱 결과가 남는다 (`callCount = 1`).
   */
  async commitDraft(
    userId: string,
    dto: CommitFromPostingDto,
  ): Promise<FromPostingResult> {
    const pending = await this.drafts.getDraft(userId, dto.hash);
    // 타 사용자의 hash 는 키가 userId 를 포함하므로 여기서 자연히 404 가 된다
    if (!pending) {
      throw new NotFoundException(
        '초안이 만료됐어요. 공고를 다시 붙여넣어 주세요.',
      );
    }

    const existing = await this.recallExistingCard(userId, dto.hash);
    if (existing) return { card: existing };

    const draft: CardDraft = { ...pending.draft };

    const typedCompany = dto.companyName?.trim();
    if (typedCompany) {
      const cleaned = stripCompanyAffix(typedCompany).slice(0, MAX_COMPANY_LEN);
      if (cleaned) {
        draft.companyName = cleaned;
        // 🔴 `filled` 에 넣지 않는다 — 그건 「AI 가 채운 칸」이고, 사람이 적은 값을 넣으면
        //    「AI 값 수정률」의 분모가 오염된다. `companySource='typed'` 가 출처를 말한다.
        draft.companySource = 'typed';
      }
    }

    const typedJob = dto.jobContext?.trim();
    if (typedJob) {
      const picked = resolveJob(draft.jobTitles, typedJob, null);
      draft.jobTitle = picked.jobTitle;
      draft.jobPicked = picked.picked;
      draft.jobTitles = [];
      if (picked.jobTitle && !draft.filled.includes('jobTitle')) {
        draft.filled.push('jobTitle');
      }
    }

    const needs = this.needsOf(draft);
    if (needs) {
      await this.drafts.saveDraft(userId, dto.hash, needs, draft);
      return {
        needs,
        hash: dto.hash,
        candidates: draft.jobTitles,
        nearProfile: draft.nearProfile,
        companyName: draft.companyName,
      };
    }

    const card = await this.createCard(userId, draft, dto.hash, 1);
    await this.drafts.deleteDraft(userId, dto.hash);
    return { card };
  }

  // ── GET /applications/from-posting/pending ────────────────────────────

  /**
   * 보완 대기 초안 목록 — 새로고침 후 「생성 중 카드」를 되살린다.
   * 초안 **본문은 안 준다** (조작 구멍). 화면을 그리는 데 필요한 만큼만.
   */
  async listPending(userId: string): Promise<PendingPostingResponse> {
    const rows = await this.drafts.listPending(userId);
    return {
      drafts: rows.map((p) => ({
        hash: p.hash,
        needs: p.needs,
        candidates: p.draft.jobTitles,
        companyName: p.draft.companyName,
        jobTitle: p.draft.jobTitle,
        createdAt: Number.isFinite(p.savedAt)
          ? new Date(p.savedAt).toISOString()
          : null,
      })),
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /**
   * 무엇을 더 물어야 하나.
   * 회사명이 먼저다 — `applications.company_name` 은 NOT NULL 이라 **없으면 카드 자체가
   * 안 만들어진다.** 직무는 비어도 카드가 선다.
   */
  private needsOf(draft: CardDraft): 'company' | 'job' | null {
    if (!draft.companyName) return 'company';
    if (!draft.jobTitle && draft.jobTitles.length > 1) return 'job';
    return null;
  }

  private async createCard(
    userId: string,
    draft: CardDraft,
    textHash: string,
    callCount: 1 | 2,
  ): Promise<Application> {
    const card = await this.applications.createFromDraft(userId, draft, {
      textHash,
      callCount,
    });
    await this.drafts.rememberCard(userId, textHash, card.id);
    await this.drafts.deleteDraft(userId, textHash);
    return card;
  }

  /** 같은 원문으로 방금 만든 카드가 **아직 살아 있으면** 그것을 돌려준다 */
  private async recallExistingCard(
    userId: string,
    textHash: string,
  ): Promise<Application | null> {
    const appId = await this.drafts.recallCard(userId, textHash);
    if (!appId) return null;
    const app = await this.appRepo.findOne({
      where: { id: appId, userId, deletedAt: IsNull() },
      relations: ['steps'],
    });
    if (!app) {
      // 되돌리기로 지웠다면 「다시 만들기」가 정상 — 기억을 지운다
      await this.drafts.forgetCard(userId, textHash);
      return null;
    }
    app.steps.sort((a, b) => a.orderIndex - b.orderIndex);
    return app;
  }

  private async profileJobTitle(userId: string): Promise<string | null> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, signupJobTitle: true },
    });
    return user?.signupJobTitle?.trim() || null;
  }

  private blockedFromLlm(
    status: string,
    errorKind: string | undefined,
  ): FromPostingResult {
    if (status === 'blocked_consent') {
      return {
        blocked: true,
        code: 'CONSENT_REQUIRED',
        reason: 'AI 사용 동의가 필요해요. 동의 후 다시 시도해주세요.',
      };
    }
    const isOutage = status === 'error' && errorKind === 'provider_outage';
    return {
      blocked: true,
      code: 'ERROR',
      // provider 원문 에러는 audit 에만 — 조직 ID·빌링 상태가 섞여 나올 수 있다
      reason: isOutage
        ? PROVIDER_OUTAGE_USER_MESSAGE
        : status === 'error'
          ? '카드를 만들지 못했어요. 잠시 후 다시 시도해 주세요.'
          : '지금은 카드를 만들 수 없어요.',
    };
  }
}

/** 원문 → sha256 (원문 자체는 어디에도 남기지 않는다 — 이 값만 남는다) */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
