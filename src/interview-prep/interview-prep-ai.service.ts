import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { LlmService } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { Application } from '../applications/application.entity';
import { ApplicationCoverletter } from '../applications/application-coverletter.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { CoverletterSourceRef } from '../applications/coverletter-source-ref.entity';
import {
  buildInterviewContext,
  type CoverletterInput,
  type StepNoteInput,
} from './interview-context-builder';
import { InterviewPrepQuestion } from './entities/interview-prep-question.entity';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';
import { InterviewPrepQuestionsService } from './interview-prep-questions.service';

/**
 * F6 PR 2 Phase 2 — InterviewPrepAiService.
 *
 * **두 메서드**:
 * 1. `generateSession(userId, sessionId)` — Hybrid (ADR-024) — main 5~8 + 각 main 의 꼬리 1~2개 일괄 1 LLM call (`interview_prep_session`)
 * 2. `generateFollowup(userId, parentQuestionId, hint?)` — on-demand 단일 꼬리질문 (`interview_prep_followup`)
 *
 * **hallucination 방어** — AI 응답의 `source_log_ids` 는 컨텍스트 빌더가 생산한 `candidateLogIds` 안 id 만 filter.
 *
 * **quota** — QuotaCheckService 단일 진입점. blocked 시 LlmService.preBlockedStatus 로 audit row + DAY_LIMIT 시 abuser ban.
 */
export type GenerateStatus = 'ok' | 'blocked';

export interface GenerateSessionResult {
  status: GenerateStatus;
  reason?: string;
  meta?: {
    callLogId: string;
    coverlettersUsed: number;
    logsUsed: number;
    droppedCount: number;
    estimatedInputTokens: number;
    mainCount: number;
    followupCount: number;
  };
}

export interface GenerateFollowupResult {
  status: GenerateStatus;
  reason?: string;
  question?: InterviewPrepQuestion;
  meta?: {
    callLogId: string;
  };
}

interface AiQuestionItem {
  question: string;
  suggested_answer: string;
  source_log_ids: string[];
  follow_ups: Array<{
    question: string;
    suggested_answer: string;
    source_log_ids: string[];
  }>;
}

interface AiSessionResponse {
  questions: AiQuestionItem[];
}

interface AiFollowupResponse {
  question: string;
  suggested_answer: string;
  source_log_ids: string[];
}

const SESSION_JSON_SCHEMA = {
  name: 'interview_prep_session',
  schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 5,
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            suggested_answer: { type: 'string' },
            source_log_ids: {
              type: 'array',
              items: { type: 'string' },
              description:
                '답변 근거 활동 로그 id (받은 후보 풀 안 id 만, 없으면 빈 배열)',
            },
            follow_ups: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string' },
                  suggested_answer: { type: 'string' },
                  source_log_ids: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['question', 'suggested_answer', 'source_log_ids'],
                additionalProperties: false,
              },
            },
          },
          required: [
            'question',
            'suggested_answer',
            'source_log_ids',
            'follow_ups',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
};

const FOLLOWUP_JSON_SCHEMA = {
  name: 'interview_prep_followup',
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      suggested_answer: { type: 'string' },
      source_log_ids: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['question', 'suggested_answer', 'source_log_ids'],
    additionalProperties: false,
  },
};

const FOLLOWUP_SYSTEM_PROMPT = `너는 한국 취준생의 면접 추궁형 꼬리질문 1개를 만든다.
- 부모 질문·답변을 더 깊이 파고드는 한 줄 질문.
- 부모 답변의 약점·전제·구체 사례를 짚는다.
- 답변 (suggested_answer) 도 함께 작성. 자료 안에서만 근거.
- source_log_ids 는 받은 후보 풀의 id 중에서만 선택, 없으면 빈 배열.`;

@Injectable()
export class InterviewPrepAiService {
  private readonly logger = new Logger(InterviewPrepAiService.name);

  constructor(
    @InjectRepository(InterviewPrepSession)
    private readonly sessionRepo: Repository<InterviewPrepSession>,
    @InjectRepository(InterviewPrepQuestion)
    private readonly questionRepo: Repository<InterviewPrepQuestion>,
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationCoverletter)
    private readonly clRepo: Repository<ApplicationCoverletter>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(CoverletterSourceRef)
    private readonly csrRepo: Repository<CoverletterSourceRef>,
    @InjectRepository(ActivityLog)
    private readonly logRepo: Repository<ActivityLog>,
    private readonly llm: LlmService,
    private readonly quotaCheck: QuotaCheckService,
    private readonly abuserBan: AbuserBanService,
    private readonly questionsService: InterviewPrepQuestionsService,
    private readonly dataSource: DataSource,
  ) {}

  // ── 1. session 일괄 생성 (Hybrid) ──

  async generateSession(
    userId: string,
    sessionId: string,
  ): Promise<GenerateSessionResult> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, userId },
    });
    if (!session) throw new NotFoundException('면접 세션을 찾을 수 없습니다.');

    // quota 사전 체크
    const quota = await this.quotaCheck.checkAndPrepare(
      userId,
      'interview_prep_session',
    );
    if (quota.blocked) {
      const blocked = await this.llm.call({
        userId,
        feature: 'interview_prep_session',
        systemPrompt: '',
        userPrompt: '',
        resourceType: 'interview_prep_session',
        resourceId: sessionId,
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: `${quota.code}: ${quota.reason}`,
      });
      if (quota.code === 'DAY_LIMIT') {
        void this.abuserBan
          .checkAndBan(userId, 'interview_prep_session', 1)
          .catch((err: unknown) =>
            this.logger.warn(
              `AbuserBan check 실패 (user=${userId}): ${(err as Error).message}`,
            ),
          );
      }
      return {
        status: 'blocked',
        reason: quota.reason,
        meta: {
          callLogId: blocked.callLogId,
          coverlettersUsed: 0,
          logsUsed: 0,
          droppedCount: 0,
          estimatedInputTokens: 0,
          mainCount: 0,
          followupCount: 0,
        },
      };
    }

    // 컨텍스트 데이터 모으기
    const app = await this.appRepo.findOne({
      where: { id: session.applicationId },
    });
    if (!app) throw new NotFoundException('지원 카드를 찾을 수 없습니다.');

    const coverletters: CoverletterInput[] =
      session.coverletterIds.length > 0
        ? (
            await this.clRepo.find({
              where: { id: In(session.coverletterIds) },
            })
          ).map((c) => ({
            id: c.id,
            category: c.category,
            question: c.question,
            answer: c.answer,
          }))
        : [];

    // coverletter_source_refs 의 log → ActivityLog
    const csrLogIds =
      session.coverletterIds.length > 0
        ? (
            await this.csrRepo.find({
              where: { coverletterId: In(session.coverletterIds) },
            })
          )
            .map((r) => r.sourceLogId)
            .filter((id): id is string => !!id)
        : [];
    const sourceLogs =
      csrLogIds.length > 0
        ? await this.logRepo.find({
            where: { id: In(csrLogIds), userId },
          })
        : [];

    const extraLogs =
      session.extraLogIds.length > 0
        ? await this.logRepo.find({
            where: { id: In(session.extraLogIds), userId },
          })
        : [];

    const steps = await this.stepRepo.find({
      where: { applicationId: session.applicationId },
      order: { orderIndex: 'ASC' },
    });
    const stepNotes: StepNoteInput[] = steps
      .filter((s) => s.notes?.trim())
      .map((s) => ({ stepName: s.name, notes: s.notes }));

    const ctx = buildInterviewContext({
      application: {
        companyName: app.companyName,
        jobCategory: app.jobCategory ?? null,
      },
      round: session.round,
      interviewType: session.interviewType,
      coverletters,
      sourceLogs,
      extraLogs,
      stepNotes,
      sessionMemo: session.myMemo,
    });

    // LLM 호출 (callJson + jsonSchema)
    const result = await this.llm.call({
      userId,
      feature: 'interview_prep_session',
      systemPrompt: ctx.systemPrompt,
      userPrompt: ctx.userPrompt,
      jsonSchema: SESSION_JSON_SCHEMA,
      resourceType: 'interview_prep_session',
      resourceId: sessionId,
    });

    if (result.status !== 'ok') {
      return {
        status: 'blocked',
        reason: this.formatBlockReason(result.status, result.errorMessage),
        meta: {
          callLogId: result.callLogId,
          coverlettersUsed: ctx.meta.coverlettersUsed,
          logsUsed: ctx.meta.logsUsed,
          droppedCount: ctx.meta.droppedCount,
          estimatedInputTokens: ctx.meta.estimatedInputTokens,
          mainCount: 0,
          followupCount: 0,
        },
      };
    }

    const parsed = result.json as AiSessionResponse | undefined;
    if (!parsed?.questions || parsed.questions.length === 0) {
      return {
        status: 'blocked',
        reason: '질문 생성 결과가 비어있어요. 다시 시도해 주세요.',
        meta: {
          callLogId: result.callLogId,
          coverlettersUsed: ctx.meta.coverlettersUsed,
          logsUsed: ctx.meta.logsUsed,
          droppedCount: ctx.meta.droppedCount,
          estimatedInputTokens: ctx.meta.estimatedInputTokens,
          mainCount: 0,
          followupCount: 0,
        },
      };
    }

    // hallucination 방어 — candidate 풀 안 id 만 filter
    const validIds = new Set(ctx.meta.candidateLogIds);
    const filterIds = (ids: string[]): string[] =>
      ids.filter((id) => validIds.has(id));

    // 기존 질문 모두 삭제 (재생성) — 트랜잭션
    let mainCount = 0;
    let followupCount = 0;
    await this.dataSource.transaction(async (em) => {
      await em.delete(InterviewPrepQuestion, { sessionId });
      for (let mi = 0; mi < parsed.questions.length; mi++) {
        const main = parsed.questions[mi];
        const mainRow = em.create(InterviewPrepQuestion, {
          sessionId,
          parentQuestionId: null,
          depth: 0,
          orderIndex: mi,
          questionText: main.question,
          suggestedAnswer: main.suggested_answer,
          sourceLogIds: filterIds(main.source_log_ids ?? []),
          myMemo: null,
        });
        const savedMain = await em.save(InterviewPrepQuestion, mainRow);
        mainCount++;
        for (let fi = 0; fi < (main.follow_ups ?? []).length; fi++) {
          const fu = main.follow_ups[fi];
          const fuRow = em.create(InterviewPrepQuestion, {
            sessionId,
            parentQuestionId: savedMain.id,
            depth: 1,
            orderIndex: fi,
            questionText: fu.question,
            suggestedAnswer: fu.suggested_answer,
            sourceLogIds: filterIds(fu.source_log_ids ?? []),
            myMemo: null,
          });
          await em.save(InterviewPrepQuestion, fuRow);
          followupCount++;
        }
      }
    });

    return {
      status: 'ok',
      meta: {
        callLogId: result.callLogId,
        coverlettersUsed: ctx.meta.coverlettersUsed,
        logsUsed: ctx.meta.logsUsed,
        droppedCount: ctx.meta.droppedCount,
        estimatedInputTokens: ctx.meta.estimatedInputTokens,
        mainCount,
        followupCount,
      },
    };
  }

  // ── 2. 단일 followup 생성 ──

  async generateFollowup(
    userId: string,
    parentQuestionId: string,
    hint?: string,
  ): Promise<GenerateFollowupResult> {
    // depth 가드 (parent.depth >= 2 → 차단)
    const parent = await this.questionsService.assertCanCreateFollowup(
      userId,
      parentQuestionId,
    );

    const session = await this.sessionRepo.findOne({
      where: { id: parent.sessionId, userId },
    });
    if (!session) throw new NotFoundException('면접 세션을 찾을 수 없습니다.');

    // quota
    const quota = await this.quotaCheck.checkAndPrepare(
      userId,
      'interview_prep_followup',
    );
    if (quota.blocked) {
      const blocked = await this.llm.call({
        userId,
        feature: 'interview_prep_followup',
        systemPrompt: '',
        userPrompt: '',
        resourceType: 'interview_prep_session',
        resourceId: session.id,
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: `${quota.code}: ${quota.reason}`,
      });
      if (quota.code === 'DAY_LIMIT') {
        void this.abuserBan
          .checkAndBan(userId, 'interview_prep_followup', 1)
          .catch((err: unknown) =>
            this.logger.warn(
              `AbuserBan check 실패 (user=${userId}): ${(err as Error).message}`,
            ),
          );
      }
      return {
        status: 'blocked',
        reason: quota.reason,
        meta: { callLogId: blocked.callLogId },
      };
    }

    // candidate 풀 = parent 의 sourceLogIds + session.extraLogIds (단순 합산, dedup)
    const candidateIds = Array.from(
      new Set([...parent.sourceLogIds, ...session.extraLogIds]),
    );
    const candidates =
      candidateIds.length > 0
        ? await this.logRepo.find({
            where: { id: In(candidateIds), userId },
          })
        : [];

    const candidateText =
      candidates.length === 0
        ? '(후보 없음)'
        : candidates
            .map(
              (l) =>
                `- (id:${l.id}) [${l.occurredAt}] ${(l.noteSummary || l.content || '').slice(0, 200)}`,
            )
            .join('\n');

    const userPrompt =
      `# 부모 질문\n${parent.questionText}\n\n` +
      `# 부모 모범 답안\n${parent.suggestedAnswer ?? '(없음)'}\n\n` +
      (hint ? `# 사용자 힌트\n${hint}\n\n` : '') +
      `# 후보 활동 로그 (source_log_ids 에 사용 가능한 id 만 나열)\n\`\`\`\n${candidateText}\n\`\`\`\n\n` +
      `위 부모를 더 깊이 파고드는 꼬리질문 1개와 모범 답안을 만드세요.`;

    const result = await this.llm.call({
      userId,
      feature: 'interview_prep_followup',
      systemPrompt: FOLLOWUP_SYSTEM_PROMPT,
      userPrompt,
      jsonSchema: FOLLOWUP_JSON_SCHEMA,
      resourceType: 'interview_prep_session',
      resourceId: session.id,
    });

    if (result.status !== 'ok') {
      return {
        status: 'blocked',
        reason: this.formatBlockReason(result.status, result.errorMessage),
        meta: { callLogId: result.callLogId },
      };
    }

    const parsed = result.json as AiFollowupResponse | undefined;
    if (!parsed?.question) {
      return {
        status: 'blocked',
        reason: '꼬리질문 생성 결과가 비어있어요.',
        meta: { callLogId: result.callLogId },
      };
    }

    const validIds = new Set(candidates.map((c) => c.id));
    const filtered = (parsed.source_log_ids ?? []).filter((id) =>
      validIds.has(id),
    );

    // 같은 parent 의 마지막 orderIndex + 1
    const siblingMax = await this.questionRepo
      .createQueryBuilder('q')
      .select('MAX(q.orderIndex)', 'maxIdx')
      .where('q.parent_question_id = :pid', { pid: parent.id })
      .getRawOne<{ maxIdx: number | null }>();
    const orderIndex = (siblingMax?.maxIdx ?? -1) + 1;

    const created = this.questionRepo.create({
      sessionId: session.id,
      parentQuestionId: parent.id,
      depth: parent.depth + 1,
      orderIndex,
      questionText: parsed.question,
      suggestedAnswer: parsed.suggested_answer,
      sourceLogIds: filtered,
      myMemo: null,
    });
    const saved = await this.questionRepo.save(created);

    return {
      status: 'ok',
      question: saved,
      meta: { callLogId: result.callLogId },
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
        return '입력이 너무 길어요. 자소서·로그 선택을 줄여 다시 시도해 주세요.';
      case 'error':
      default:
        return '잠시 후 다시 시도해 주세요.';
    }
  }
}
