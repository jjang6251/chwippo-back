import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { LlmService } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { MyinfoService } from '../myinfo/myinfo.service';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { ActivityReflection } from '../activity/entities/activity-reflection.entity';
import { Activity } from '../activity/entities/activity.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { buildCoverletterContext } from './coverletter-context-builder';
import { CoverletterSourceRef } from './coverletter-source-ref.entity';
import { CoverletterSourceRefsService } from './coverletter-source-refs.service';

/**
 * F6 PR 1 — POST /coverletters/:clId/ai-draft 본체.
 *
 * **흐름** (focus.md F6 PR 1 + ADR-027 위에 얹음):
 * 1. cl 본인 소유 검증 (CoverletterSourceRefsService.assertOwnsCoverletter)
 * 2. selected_source_ref_ids[] IDOR batch 검증 (Critical #3)
 * 3. 일·월 quota 사전 체크 (`coverletter_draft_v2` + `coverletter_recommend` 별도 합산)
 * 4. **AI 추천 1회 LLM 호출** (`coverletter_recommend`, callJson + schema) — 사용자 logs 중 상위 1개 자동 선택
 * 5. selected + recommended logs/reflections + myinfo dump → buildCoverletterContext
 * 6. **답변 LLM 호출** (`coverletter_draft_v2`, LlmService.call)
 * 7. ApplicationCoverletter.answer 업데이트 + source_refs bulk insert (selected aiRecommended=false / recommended aiRecommended=true)
 * 8. 응답 반환 (answer + meta + refs)
 *
 * **quota** (F6 PR 2 Phase 1 통합):
 * - `coverletter_draft_v2` · `coverletter_recommend` 각각 `feature_quota_configs` 의 (feature, tier) row 로 통제
 * - admin /ops/ai-feature-quotas 페이지에서 day·month·cooldown·enabled(kill switch) 동적 조절
 * - QuotaCheckService.checkAndPrepare() 단일 진입점 — memory `feedback_admin_quota_control`
 */

export type AiDraftStatus = 'ok' | 'blocked';

export interface AiDraftInput {
  /** 사용자가 사이드 패널에서 체크한 ref ID 들 (priority 1). source_refs 테이블의 row id 들 */
  selectedSourceRefIds?: string[];
  /** force=true 면 AI 추천 단계 skip (사용자가 명시 선택만으로 진행하려는 경우) */
  skipRecommend?: boolean;
}

export interface AiDraftResult {
  status: AiDraftStatus;
  /** 생성된 답변 (blocked 시 null) */
  answer: string | null;
  /** blocked 사유 (사용자 표시용) */
  reason?: string;
  meta?: {
    draftCallLogId: string;
    recommendCallLogId: string | null;
    estimatedInputTokens: number;
    logsUsed: number;
    reflectionsUsed: number;
    droppedCount: number;
    droppedRefIds: string[];
    /** 새로 생성된 ref ids (selected + recommended) */
    createdRefIds: string[];
  };
}

interface AiRecommendation {
  recommendedLogIds: string[];
  reason: string;
}

const AI_RECOMMEND_SCHEMA = {
  name: 'coverletter_recommend',
  schema: {
    type: 'object',
    properties: {
      recommended_log_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          '추천 log id (최대 1개, 사용자의 활동 로그 id 중에서만 선택)',
      },
      reason: {
        type: 'string',
        description: '추천 사유 (한국어 1~2 문장)',
      },
    },
    required: ['recommended_log_ids', 'reason'],
    additionalProperties: false,
  },
};

const RECOMMEND_SYSTEM_PROMPT = `너는 한국 취준생의 자소서 문항에 맞는 활동 로그를 추천하는 보조다.
주어진 문항·카테고리와 사용자의 활동 로그 목록을 보고, 답변에 가장 적합한 로그 ID 1개를 추천한다.
- 추천 사유는 한국어 1~2문장.
- 절대 본문에 없는 id 를 만들지 마라. 받은 목록 안에서만 선택.
- 적합한 로그가 없으면 빈 배열 반환.`;

@Injectable()
export class AiCoverletterDraftService {
  private readonly logger = new Logger(AiCoverletterDraftService.name);

  constructor(
    @InjectRepository(ApplicationCoverletter)
    private readonly clRepo: Repository<ApplicationCoverletter>,
    @InjectRepository(CoverletterSourceRef)
    private readonly refRepo: Repository<CoverletterSourceRef>,
    @InjectRepository(ActivityLog)
    private readonly activityLogRepo: Repository<ActivityLog>,
    @InjectRepository(ActivityReflection)
    private readonly reflectionRepo: Repository<ActivityReflection>,
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    private readonly sourceRefsService: CoverletterSourceRefsService,
    private readonly llm: LlmService,
    private readonly quotaCheck: QuotaCheckService,
    @Inject(forwardRef(() => MyinfoService))
    private readonly myinfo: MyinfoService,
    private readonly abuserBan: AbuserBanService,
  ) {}

  async generate(
    userId: string,
    coverletterId: string,
    input: AiDraftInput,
  ): Promise<AiDraftResult> {
    // 1. cl 소유 검증
    const cl = await this.sourceRefsService.assertOwnsCoverletter(
      userId,
      coverletterId,
    );

    if (!cl.question?.trim()) {
      throw new BadRequestException('자소서 문항이 비어있습니다.');
    }

    // application 정보 조회 (companyName, jobCategory)
    const clWithApp = await this.clRepo.findOne({
      where: { id: coverletterId },
      relations: ['application'],
    });
    if (!clWithApp?.application) {
      throw new NotFoundException('지원 카드를 찾을 수 없습니다.');
    }

    // A1 — 회사조사 완료 가드 제거 (3경로 개편). draft 컨텍스트는 원래
    // source_refs·myinfo 기반이라 조사와 무관 — 조사는 chat 단계에서만 활용됨.

    // 2. selected refs IDOR batch
    const selectedIds = input.selectedSourceRefIds ?? [];
    const selectedRefs =
      await this.sourceRefsService.assertSelectedRefsBelongToUser(
        userId,
        coverletterId,
        selectedIds,
      );

    // 3. quota 사전 체크 — QuotaCheckService 단일 진입점 (admin 통제).
    //    draft 한도 초과 → 사용자 가치 보존 어려움 (답변 생성 불가) → blocked 반환.
    //    recommend 한도 초과 → 추천만 skip 하고 draft 진행 (부수 기능, 가치 손실 최소).
    const draftQuota = await this.quotaCheck.checkAndPrepare(
      userId,
      'coverletter_draft_v2',
    );
    if (draftQuota.blocked) {
      const blockedResult = await this.llm.call({
        userId,
        feature: 'coverletter_draft_v2',
        systemPrompt: '',
        userPrompt: '',
        resourceType: 'application_coverletter',
        resourceId: coverletterId,
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: `${draftQuota.code}: ${draftQuota.reason}`,
      });
      // DAY_LIMIT 도달 시 abuser ban 평가 (3일 연속 발동, fire & forget)
      if (draftQuota.code === 'DAY_LIMIT') {
        void this.abuserBan
          .checkAndBan(userId, 'coverletter_draft_v2', 1)
          .catch((err: unknown) =>
            this.logger.warn(
              `AbuserBan check 실패 (user=${userId}): ${(err as Error).message}`,
            ),
          );
      }
      return {
        status: 'blocked',
        answer: null,
        reason: draftQuota.reason,
        meta: {
          draftCallLogId: blockedResult.callLogId,
          recommendCallLogId: null,
          estimatedInputTokens: 0,
          logsUsed: 0,
          reflectionsUsed: 0,
          droppedCount: 0,
          droppedRefIds: [],
          createdRefIds: [],
        },
      };
    }
    const shouldRecommend = !input.skipRecommend;
    let recommendQuotaOk = true;
    if (shouldRecommend) {
      const recommendQuota = await this.quotaCheck.checkAndPrepare(
        userId,
        'coverletter_recommend',
      );
      recommendQuotaOk = !recommendQuota.blocked;
    }

    // 4. 본인 logs/reflections 미리 로드 (selected 가 아닌 것 중 AI 추천 후보 풀)
    //    (성능 — 활성 활동만 50개 한도. archive 된 건 제외)
    //    TypeORM 주의: `archivedAt: undefined` 는 조건 무시 → archived 도 포함됨. IsNull() 명시 강제 (cross-user 격리 + 사용자 보관 활동 보호)
    const allLogs = await this.activityLogRepo.find({
      where: { userId, archivedAt: IsNull() },
      order: { occurredAt: 'DESC' },
      take: 50,
    });

    // 5. selected refs → log/reflection 조회
    const { logs: selLogs, reflections: selReflections } =
      await this.sourceRefsService.loadRefsWithSources(selectedRefs);

    // 6. AI 추천 호출 (옵션)
    let aiRecommendation: AiRecommendation = {
      recommendedLogIds: [],
      reason: '',
    };
    let recommendCallLogId: string | null = null;
    if (shouldRecommend && recommendQuotaOk && allLogs.length > 0) {
      const result = await this.callRecommend(
        userId,
        cl.question,
        cl.category,
        allLogs,
        selectedRefs
          .map((r) => r.sourceLogId)
          .filter((id): id is string => !!id),
      );
      aiRecommendation = result.recommendation;
      recommendCallLogId = result.callLogId;
    }

    // 7. AI 추천 logs → ActivityLog 조회 + selected 와 중복 제거
    const recommendedLogObjs: Array<{ refId: string; log: ActivityLog }> = [];
    const newAiRefs: Array<{ sourceLogId: string }> = [];
    if (aiRecommendation.recommendedLogIds.length > 0) {
      const recLogs = allLogs.filter((l) =>
        aiRecommendation.recommendedLogIds.includes(l.id),
      );
      for (const log of recLogs) {
        // 이미 selected 에 있으면 skip
        const alreadySelected = selLogs.some((s) => s.log.id === log.id);
        if (alreadySelected) continue;
        // refId 는 아직 없음 (insert 후 받음) — 빌더용 임시 id 'pending-ai-{logId}'
        recommendedLogObjs.push({ refId: `pending-ai-${log.id}`, log });
        newAiRefs.push({ sourceLogId: log.id });
      }
    }

    // 8. myinfo PII-safe dump
    const myinfoDump = await this.myinfo.getSafeDumpForAi(userId);

    // 8.5. 활동 총괄 회고 (베타 피드백 2026-06-23)
    //   selected logs/reflections + 추천 logs 에 묶인 활동 들의 summary_reflection 만 prompt 에 통째로 inject.
    //   사용자가 한꺼번에 wrap up 한 큰 그림 = 자소서 핵심 소재. cross-user 격리 (where userId).
    const activityIds = new Set<string>();
    for (const { log } of selLogs) activityIds.add(log.activityId);
    for (const { reflection } of selReflections)
      activityIds.add(reflection.activityId);
    for (const { log } of recommendedLogObjs) activityIds.add(log.activityId);
    let activitySummaries:
      | Array<{ activityName: string; summary: string }>
      | undefined;
    if (activityIds.size > 0) {
      const acts = await this.activityRepo.find({
        where: { userId, id: In([...activityIds]) },
        select: ['id', 'name', 'summaryReflection'],
      });
      activitySummaries = acts
        .filter((a) => a.summaryReflection && a.summaryReflection.trim())
        .map((a) => ({
          activityName: a.name,
          summary: a.summaryReflection!,
        }));
    }

    // 9. 컨텍스트 빌드
    const ctx = buildCoverletterContext({
      application: {
        companyName: clWithApp.application.companyName,
        jobCategory: clWithApp.application.jobCategory ?? null,
      },
      question: cl.question,
      category: cl.category,
      charLimit: cl.charLimit,
      selectedLogs: selLogs,
      selectedReflections: selReflections,
      aiRecommendedLogs: recommendedLogObjs,
      activitySummaries,
      myinfo: myinfoDump,
    });

    // 10. 답변 LLM 호출
    const draftResult = await this.llm.call({
      userId,
      feature: 'coverletter_draft_v2',
      systemPrompt: ctx.systemPrompt,
      userPrompt: ctx.userPrompt,
      resourceType: 'application_coverletter',
      resourceId: coverletterId,
    });

    if (draftResult.status !== 'ok') {
      return {
        status: 'blocked',
        answer: null,
        reason: this.formatBlockReason(
          draftResult.status,
          draftResult.errorMessage,
        ),
      };
    }

    // 11. answer 저장 + AI 추천 ref bulk insert (selected 는 이미 있음, AI 추천만 새로 저장)
    cl.answer = draftResult.text;
    // A1 — 최초 출처만 기록 (기존 답변을 덮는 재생성이면 원 출처 유지)
    if (!cl.answerOrigin) cl.answerOrigin = 'ai_draft';
    await this.clRepo.save(cl);

    const createdAiRefs = await this.sourceRefsService.bulkCreate(
      coverletterId,
      newAiRefs.map((r) => ({ ...r, aiRecommended: true })),
    );

    return {
      status: 'ok',
      answer: draftResult.text,
      meta: {
        draftCallLogId: draftResult.callLogId,
        recommendCallLogId,
        estimatedInputTokens: ctx.meta.estimatedInputTokens,
        logsUsed: ctx.meta.logsUsed,
        reflectionsUsed: ctx.meta.reflectionsUsed,
        droppedCount: ctx.meta.droppedCount,
        droppedRefIds: ctx.meta.droppedRefIds,
        createdRefIds: createdAiRefs.map((r) => r.id),
      },
    };
  }

  // ── private ──

  /**
   * AI 추천 LLM 호출 — Anthropic callJson (tool_use 강제). 실패 시 빈 추천 반환 + log.
   */
  private async callRecommend(
    userId: string,
    question: string,
    category: string | null,
    candidateLogs: ActivityLog[],
    excludeIds: string[],
  ): Promise<{ recommendation: AiRecommendation; callLogId: string }> {
    // 후보 풀에서 selected 제외 — AI 가 중복 추천 안 하도록
    const candidates = candidateLogs.filter((l) => !excludeIds.includes(l.id));
    if (candidates.length === 0) {
      return {
        recommendation: { recommendedLogIds: [], reason: '' },
        callLogId: 'no-call',
      };
    }

    // 후보 logs 압축 표현 (token cap 안)
    const candidatesText = candidates
      .slice(0, 30) // 최대 30개만 (token budget)
      .map(
        (l) =>
          `- id:${l.id} | [${l.occurredAt}] ${(l.noteSummary || l.content || '').slice(0, 100)}`,
      )
      .join('\n');

    const userPrompt = `# 자소서 문항\n${question}\n\n# 문항 분류\n${category ?? '기타'}\n\n# 후보 활동 로그\n\`\`\`\n${candidatesText}\n\`\`\`\n\n위 문항에 가장 적합한 활동 로그 1개를 추천하세요.`;

    const result = await this.llm.call({
      userId,
      feature: 'coverletter_recommend',
      systemPrompt: RECOMMEND_SYSTEM_PROMPT,
      userPrompt,
      jsonSchema: AI_RECOMMEND_SCHEMA,
    });

    if (result.status !== 'ok') {
      // 추천 실패 시 빈 추천 반환 (draft 진행에 영향 X)
      this.logger.warn(
        `AI recommend failed (user=${userId}): ${result.errorMessage ?? result.status}`,
      );
      return {
        recommendation: { recommendedLogIds: [], reason: '' },
        callLogId: result.callLogId,
      };
    }

    const parsed = result.json as AiRecommendation | undefined;
    if (!parsed?.recommendedLogIds) {
      return {
        recommendation: { recommendedLogIds: [], reason: '' },
        callLogId: result.callLogId,
      };
    }

    // hallucination 방어 — AI 가 만든 가짜 id 제거 (candidates 에 실존하는 id 만)
    const validIds = new Set(candidates.map((c) => c.id));
    const filtered = parsed.recommendedLogIds.filter((id) => validIds.has(id));

    return {
      recommendation: {
        recommendedLogIds: filtered.slice(0, 1), // 최대 1개 (focus.md)
        reason: parsed.reason ?? '',
      },
      callLogId: result.callLogId,
    };
  }

  private formatBlockReason(
    status: string,
    errorMessage: string | undefined | null,
  ): string {
    switch (status) {
      case 'blocked_consent':
        return errorMessage ?? 'AI 사용 동의가 필요합니다.';
      case 'blocked_quota':
        return errorMessage ?? '한도를 초과했어요.';
      case 'blocked_moderation':
        return '내용에 부적절한 표현이 감지됐어요. 수정 후 다시 시도해 주세요.';
      case 'blocked_input_cap':
        return '입력이 너무 길어요. 활동 로그를 줄여 다시 시도해 주세요.';
      case 'error':
      default:
        return '잠시 후 다시 시도해 주세요.';
    }
  }
}
