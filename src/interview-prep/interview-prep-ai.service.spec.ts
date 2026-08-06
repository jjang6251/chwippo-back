import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import {
  DataSource,
  type EntityManager,
  type Repository,
  type SelectQueryBuilder,
} from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { LlmService } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { Application } from '../applications/application.entity';
import { ApplicationCoverletter } from '../applications/application-coverletter.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { CoverletterSourceRef } from '../applications/coverletter-source-ref.entity';
import { InterviewPrepQuestion } from './entities/interview-prep-question.entity';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';
import { CompanyResearchService } from './company-research.service';
import {
  ANSWER_SYSTEM_PROMPT,
  FOLLOWUP_SYSTEM_PROMPT,
  InterviewPrepAiService,
  MIN_PROBEABLE_ANSWER_CHARS,
  resolveFollowupBasis,
} from './interview-prep-ai.service';
import { InterviewPrepQuestionsService } from './interview-prep-questions.service';

/**
 * F6 PR 2 Phase 3 — InterviewPrepAiService spec.
 *
 * 시나리오 매트릭스 (plan S9.3):
 * - generateSession: 정상 (Hybrid main 2 + 각 follow-up 1) → questions tree 저장 + meta 반환
 * - generateSession: 다른 user session → NotFound
 * - generateSession: QuotaCheck DAY_LIMIT → blocked + abuser ban 트리거 + audit row
 * - generateSession: QuotaCheck FEATURE_DISABLED → blocked, abuser ban 미트리거, 컨텍스트 빌드 안 함
 * - generateSession: LLM error → blocked
 * - generateSession: JSON 응답 비어있음 → blocked
 * - generateSession: hallucination 방어 — AI 가 candidate 안 없는 id 반환 → filter 후 빈 배열 저장
 * - generateFollowup: 정상 (depth 0 → depth 1)
 * - generateFollowup: parent.depth=2 → BadRequest (assertCanCreateFollowup 가드)
 * - generateFollowup: quota blocked → blocked
 * - generateFollowup: JSON 빈 응답 → blocked
 * - generateFollowup: orderIndex 시블링 max+1 계산
 */
describe('InterviewPrepAiService', () => {
  let service: InterviewPrepAiService;
  let sessionRepo: jest.Mocked<Repository<InterviewPrepSession>>;
  let questionRepo: jest.Mocked<Repository<InterviewPrepQuestion>>;
  let appRepo: jest.Mocked<Repository<Application>>;
  let clRepo: jest.Mocked<Repository<ApplicationCoverletter>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let csrRepo: jest.Mocked<Repository<CoverletterSourceRef>>;
  let logRepo: jest.Mocked<Repository<ActivityLog>>;
  let llm: jest.Mocked<LlmService>;
  let quotaCheck: jest.Mocked<QuotaCheckService>;
  let abuserBan: jest.Mocked<AbuserBanService>;
  let questionsService: jest.Mocked<InterviewPrepQuestionsService>;
  let companyResearch: jest.Mocked<CompanyResearchService>;
  let dataSource: { transaction: jest.Mock };
  /** v2 — 저장된 질문 row 를 직접 검사하기 위해 테스트에서 접근한다 */
  let fakeEm: { delete: jest.Mock; create: jest.Mock; save: jest.Mock };

  const USER_ID = 'user-1';
  const SESSION_ID = 'sess-1';
  const APP_ID = 'app-1';

  const makeSession = (
    overrides: Partial<InterviewPrepSession> = {},
  ): InterviewPrepSession =>
    ({
      id: SESSION_ID,
      userId: USER_ID,
      applicationId: APP_ID,
      round: '1차',
      interviewType: 'technical',
      coverletterIds: [],
      extraLogIds: [],
      myMemo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as InterviewPrepSession;

  const makeApp = (): Application =>
    ({
      id: APP_ID,
      userId: USER_ID,
      companyName: '카카오',
      jobCategory: '백엔드',
    }) as Application;

  const makeLog = (id: string): ActivityLog =>
    ({
      id,
      userId: USER_ID,
      activityId: 'act-1',
      content: '로그',
      occurredAt: '2026-05-01',
      cat: null,
      comps: [],
      cl: [],
      quant: null,
      mood: null,
      keywords: [],
      note: null,
      noteSummary: '요약',
      noteSummaryHash: null,
      noteSummaryAt: null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      activity: undefined,
    }) as unknown as ActivityLog;

  // QueryBuilder mock for siblingMax orderIndex
  const qQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
  } as unknown as jest.Mocked<SelectQueryBuilder<InterviewPrepQuestion>> & {
    getRawOne: jest.Mock;
  };

  beforeEach(async () => {
    sessionRepo = mock<Repository<InterviewPrepSession>>();
    questionRepo = mock<Repository<InterviewPrepQuestion>>();
    appRepo = mock<Repository<Application>>();
    clRepo = mock<Repository<ApplicationCoverletter>>();
    stepRepo = mock<Repository<ApplicationStep>>();
    csrRepo = mock<Repository<CoverletterSourceRef>>();
    logRepo = mock<Repository<ActivityLog>>();
    llm = mock<LlmService>();
    quotaCheck = mock<QuotaCheckService>();
    abuserBan = mock<AbuserBanService>();
    questionsService = mock<InterviewPrepQuestionsService>();
    companyResearch = mock<CompanyResearchService>();
    // default — cache 없음 (null) → 회사 조사 블록 inject 안 됨
    companyResearch.getCachedForApplication.mockResolvedValue(null);
    dataSource = { transaction: jest.fn() };

    // defaults
    sessionRepo.findOne.mockResolvedValue(makeSession());
    /**
     * v2.1 — 생성 시작 시 `in_progress` 를 거는 atomic UPDATE. 기본은 **claim 성공**.
     * "이미 생성 중" 시나리오는 개별 테스트에서 affected 0 으로 override 한다.
     */
    sessionRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as SelectQueryBuilder<InterviewPrepSession>);
    sessionRepo.update.mockResolvedValue({
      affected: 1,
      raw: [],
      generatedMaps: [],
    });
    appRepo.findOne.mockResolvedValue(makeApp());
    clRepo.find.mockResolvedValue([]);
    csrRepo.find.mockResolvedValue([]);
    stepRepo.find.mockResolvedValue([]);
    logRepo.find.mockResolvedValue([]);
    quotaCheck.checkAndPrepare.mockResolvedValue({ blocked: false });
    abuserBan.checkAndBan.mockResolvedValue({ banned: false });
    qQb.select.mockReturnThis();
    qQb.where.mockReturnThis();
    qQb.getRawOne.mockReset().mockResolvedValue({ maxIdx: null });
    questionRepo.createQueryBuilder.mockReturnValue(qQb);
    // v2.1 — 꼬리질문이 형제 질문을 읽어 중복을 피한다 (기본은 형제 없음)
    questionRepo.find.mockResolvedValue([]);
    questionRepo.create.mockImplementation(
      (input) => ({ ...(input as object) }) as InterviewPrepQuestion,
    );
    questionRepo.save.mockImplementation(
      async (q) => ({ ...(q as object), id: 'q-new' }) as InterviewPrepQuestion,
    );

    // transaction stub — em.delete + em.create + em.save 동작
    fakeEm = {
      delete: jest.fn().mockResolvedValue({ affected: 0, raw: [] }),
      create: jest.fn().mockImplementation((_entity, input) => input),
      save: jest.fn().mockImplementation(async (_entity, q) => ({
        ...(q as object),
        id: `q-${Math.random().toString(36).slice(2, 8)}`,
      })),
    };
    dataSource.transaction.mockImplementation(
      async (cb: (em: EntityManager) => Promise<unknown>) =>
        cb(fakeEm as unknown as EntityManager),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterviewPrepAiService,
        {
          provide: getRepositoryToken(InterviewPrepSession),
          useValue: sessionRepo,
        },
        {
          provide: getRepositoryToken(InterviewPrepQuestion),
          useValue: questionRepo,
        },
        { provide: getRepositoryToken(Application), useValue: appRepo },
        {
          provide: getRepositoryToken(ApplicationCoverletter),
          useValue: clRepo,
        },
        { provide: getRepositoryToken(ApplicationStep), useValue: stepRepo },
        {
          provide: getRepositoryToken(CoverletterSourceRef),
          useValue: csrRepo,
        },
        { provide: getRepositoryToken(ActivityLog), useValue: logRepo },
        { provide: LlmService, useValue: llm },
        { provide: QuotaCheckService, useValue: quotaCheck },
        { provide: AbuserBanService, useValue: abuserBan },
        {
          provide: InterviewPrepQuestionsService,
          useValue: questionsService,
        },
        { provide: CompanyResearchService, useValue: companyResearch },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get<InterviewPrepAiService>(InterviewPrepAiService);
  });

  // ── generateSession ──
  // F1 v2 (2-stage): generateSession 안에서 llm.call 가 2번 호출됨 (Stage1 base + Stage2 fork).
  // 기존 spec 의 단일 응답 의도를 보존하려면 Stage2 mock 은 빈 questions ('ok' but empty).
  // → 실제 저장은 Stage1 응답만 (Stage2 questions=[] → 합산 영향 없음).
  const EMPTY_STAGE2 = {
    status: 'ok' as const,
    text: '',
    json: { questions: [] },
    promptTokens: 50,
    completionTokens: 10,
    costUsd: 0,
    latencyMs: 100,
    callLogId: 'log-stage2-empty',
    outputRedacted: false,
  };

  describe('generateSession', () => {
    /**
     * 🔴 v2 회귀 방어의 핵심. 응답에 `suggested_answer` 와 `follow_ups` 가 **들어 있어도**
     * 저장하면 안 된다.
     *
     * 스키마에서 뺐으니 안 올 거라고 가정하면 안 되는 이유 — 2026-08-06 벤치에서
     * **Anthropic `tool_use` 가 `maxItems` 를 무시하고 16개를 냈다.** 즉 스키마는 강제가
     * 아니라 요청일 뿐이고, 모델이 옛 형태로 답할 수 있다. 그때 답변이 조용히 저장되면
     * v2 의 전제(원가·지연·플레이스홀더 해소)가 통째로 무너진다.
     */
    it('v2: 응답에 답변·꼬리질문이 섞여 와도 질문만 저장한다 (답변 null · 꼬리 0)', async () => {
      llm.call
        .mockResolvedValueOnce({
          status: 'ok',
          text: '',
          json: {
            questions: [
              {
                category: 'self_intro',
                question: 'q1',
                source_log_ids: [],
                // 스키마에 없는 필드 — 모델이 옛 형태로 답한 상황을 재현
                suggested_answer: 'a1',
                follow_ups: [
                  {
                    question: 'q1-1',
                    suggested_answer: 'a1-1',
                    source_log_ids: [],
                  },
                ],
              },
              { category: 'motivation', question: 'q2', source_log_ids: [] },
            ],
          },
          promptTokens: 500,
          completionTokens: 300,
          costUsd: 0.001,
          latencyMs: 1500,
          callLogId: 'log-1',
          outputRedacted: false,
        })
        .mockResolvedValueOnce(EMPTY_STAGE2);

      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('ok');
      expect(r.meta?.mainCount).toBe(2);
      expect(r.meta?.followupCount).toBe(0);

      const saved = fakeEm.save.mock.calls.map(
        ([, row]: [unknown, Record<string, unknown>]) => row,
      );
      expect(saved).toHaveLength(2); // 꼬리질문 row 가 만들어지지 않았다
      for (const row of saved) {
        expect(row.suggestedAnswer).toBeNull();
        expect(row.depth).toBe(0);
        expect(row.parentQuestionId).toBeNull();
      }
      expect(saved.map((r2) => r2.questionText)).toEqual(['q1', 'q2']);

      expect(quotaCheck.checkAndPrepare).toHaveBeenCalledWith(
        USER_ID,
        'interview_prep_session',
      );
    });

    it('다른 user session → NotFound', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.generateSession(USER_ID, 'sess-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('QuotaCheck DAY_LIMIT → blocked + abuser ban 트리거 + audit row', async () => {
      quotaCheck.checkAndPrepare.mockResolvedValueOnce({
        blocked: true,
        code: 'DAY_LIMIT',
        reason: '오늘 한도 초과',
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'day',
        callLogId: 'log-b',
      });

      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('오늘');
      expect(llm.call).toHaveBeenCalledWith(
        expect.objectContaining({
          preBlockedStatus: 'blocked_quota',
          preBlockedReason: expect.stringContaining('DAY_LIMIT'),
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(abuserBan.checkAndBan).toHaveBeenCalledWith(
        USER_ID,
        'interview_prep_session',
        1,
      );
    });

    it('QuotaCheck FEATURE_DISABLED → blocked, abuser ban 미트리거, 본 LLM call X (audit 만)', async () => {
      quotaCheck.checkAndPrepare.mockResolvedValueOnce({
        blocked: true,
        code: 'FEATURE_DISABLED',
        reason: '관리자에 의해 일시 중단',
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'disabled',
        callLogId: 'log-b',
      });

      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('관리자');
      expect(abuserBan.checkAndBan).not.toHaveBeenCalled();
      // 본 LLM 생성 호출 X — audit 만 1번
      expect(llm.call).toHaveBeenCalledTimes(1);
    });

    it('LLM error → blocked + 잠시 후 안내', async () => {
      llm.call.mockResolvedValue({
        status: 'error',
        text: null,
        errorMessage: 'rate limit',
        callLogId: 'log-e',
      });
      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('잠시 후');
    });

    it('JSON 응답 비어있음 (questions=[]) → blocked', async () => {
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: { questions: [] },
        promptTokens: 50,
        completionTokens: 5,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'log-e',
        outputRedacted: false,
      });
      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('비어있어요');
    });

    it('hallucination 방어: AI 가 candidate 안 없는 id 반환 → filter 후 빈 배열 저장', async () => {
      // candidate 풀은 session.extraLogIds + csr → 빈 (default)
      // AI 가 'FAKE-ID' 반환 → filter 로 제거
      const savedQuestions: InterviewPrepQuestion[] = [];
      dataSource.transaction.mockImplementation(
        async (cb: (em: EntityManager) => Promise<unknown>) => {
          const em = {
            delete: jest.fn(),
            create: jest.fn().mockImplementation((_e, input) => input),
            save: jest.fn().mockImplementation(async (_e, q) => {
              const saved = {
                ...(q as object),
                id: `q-${savedQuestions.length}`,
              };
              savedQuestions.push(saved as InterviewPrepQuestion);
              return saved as InterviewPrepQuestion;
            }),
          } as unknown as EntityManager;
          return cb(em);
        },
      );

      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          questions: [
            {
              question: 'q1',
              suggested_answer: 'a1',
              source_log_ids: ['FAKE-ID', 'ANOTHER-FAKE'],
              follow_ups: [],
            },
          ],
        },
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'log-1',
        outputRedacted: false,
      });

      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('ok');
      // 저장된 main 의 sourceLogIds 는 빈 배열 (filter 결과)
      const mainSaved = savedQuestions.find((q) => q.depth === 0);
      expect(mainSaved?.sourceLogIds).toEqual([]);
    });

    it('candidate 풀에 실존 id 만 통과 — extraLogIds 안 id 는 보존', async () => {
      const session = makeSession({ extraLogIds: ['log-real'] });
      // mockResolvedValueOnce 대신 default override — 두 번째 호출도 같은 session 반환 보장
      sessionRepo.findOne.mockResolvedValue(session);
      logRepo.find.mockResolvedValue([makeLog('log-real')]);

      const savedQuestions: InterviewPrepQuestion[] = [];
      dataSource.transaction.mockImplementation(
        async (cb: (em: EntityManager) => Promise<unknown>) => {
          const em = {
            delete: jest.fn(),
            create: jest.fn().mockImplementation((_e, input) => input),
            save: jest.fn().mockImplementation(async (_e, q) => {
              const saved = {
                ...(q as object),
                id: `q-${savedQuestions.length}`,
              };
              savedQuestions.push(saved as InterviewPrepQuestion);
              return saved as InterviewPrepQuestion;
            }),
          } as unknown as EntityManager;
          return cb(em);
        },
      );

      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          questions: [
            {
              question: 'q1',
              suggested_answer: 'a1',
              source_log_ids: ['log-real', 'FAKE'],
              follow_ups: [],
            },
          ],
        },
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'log-c',
        outputRedacted: false,
      });

      await service.generateSession(USER_ID, SESSION_ID);
      const mainSaved = savedQuestions.find((q) => q.depth === 0);
      expect(mainSaved?.sourceLogIds).toEqual(['log-real']); // FAKE 만 제거
    });

    // ── F1 v2 (2026-06-01) — Phase 1: 회사조사 inject + 카테고리 enum + main 20 + cap 7000 ──
    describe('Phase 1 — 회사 조사 cache prompt inject', () => {
      const makeLlmOk = () => {
        llm.call.mockResolvedValue({
          status: 'ok',
          text: '',
          json: {
            questions: [
              {
                category: 'self_intro',
                question: 'q',
                suggested_answer: 'a',
                source_log_ids: [],
                follow_ups: [],
              },
            ],
          },
          promptTokens: 100,
          completionTokens: 50,
          costUsd: 0,
          latencyMs: 100,
          callLogId: 'log-1',
          outputRedacted: false,
        });
      };

      it("1) cache status='ok' → userPrompt 에 '# 회사 조사' 블록 포함 + businessSummary 인용", async () => {
        companyResearch.getCachedForApplication.mockResolvedValueOnce({
          status: 'ok',
          research: {
            businessSummary: '카카오뱅크는 모바일 전문 은행',
            coreValues: '고객 중심',
          },
          sources: [],
          isCached: true,
          cachedAt: new Date().toISOString(),
        } as never);
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('# 회사 조사');
        expect(llmArg.userPrompt).toContain('카카오뱅크는 모바일 전문 은행');
        expect(llmArg.userPrompt).toContain('고객 중심');
      });

      it('2) cache null → userPrompt 에 회사 조사 블록 없음', async () => {
        companyResearch.getCachedForApplication.mockResolvedValueOnce(null);
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).not.toContain('# 회사 조사');
      });

      it("3) cache status='opt_out' → 회사 조사 블록 없음 (회사가 정보 수집 거부)", async () => {
        companyResearch.getCachedForApplication.mockResolvedValueOnce({
          status: 'opt_out',
          reason: '이 회사는 정보 수집 동의가 철회됐어요.',
        } as never);
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).not.toContain('# 회사 조사');
      });

      it('4) cache.research 부분 (businessSummary 만) → 그 항목만 포함', async () => {
        companyResearch.getCachedForApplication.mockResolvedValueOnce({
          status: 'ok',
          research: { businessSummary: '핀테크 스타트업' },
          sources: [],
          isCached: true,
          cachedAt: new Date().toISOString(),
        } as never);
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('# 회사 조사');
        expect(llmArg.userPrompt).toContain('핀테크 스타트업');
        expect(llmArg.userPrompt).not.toContain('핵심 가치:');
        expect(llmArg.userPrompt).not.toContain('비전·미션:');
      });

      it('5) cache fetch throw → graceful (block 없음, prompt 진행)', async () => {
        companyResearch.getCachedForApplication.mockRejectedValueOnce(
          new Error('db down'),
        );
        makeLlmOk();
        const r = await service.generateSession(USER_ID, SESSION_ID);
        expect(r.status).toBe('ok');
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).not.toContain('# 회사 조사');
      });
    });

    describe('Phase 1 — SystemPrompt 카테고리 매트릭스 + main 20 가이드', () => {
      it('6) SystemPrompt 에 카테고리 7축 base + 직무별 fork 가이드 포함', async () => {
        llm.call.mockResolvedValue({
          status: 'ok',
          text: '',
          json: { questions: [] },
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          latencyMs: 1,
          callLogId: 'log-1',
          outputRedacted: false,
        });
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          systemPrompt: string;
        };
        /**
         * 🔴 2026-08-07 — 공통 질문 목록은 이제 **종류별로 갈아 끼운다.**
         *    이 세션은 `technical` 이라 인성·가치관 질문이 빠지는 게 정상이다.
         *    종류별 구성은 `interview-context-builder.spec.ts` 가 전수로 덮는다.
         */
        expect(llmArg.systemPrompt).toContain('self_intro');
        // 직무 fork 키워드 — 종류와 무관하게 항상 있다
        expect(llmArg.systemPrompt).toContain('cs_tech');
        expect(llmArg.systemPrompt).toContain('business_reasoning');
        expect(llmArg.systemPrompt).toContain('data_metrics');
        expect(llmArg.systemPrompt).toContain('portfolio_decision');
      });

      /**
       * v2 — 면접 공통 질문 10종이 프롬프트에 **명시**돼 있는가.
       *
       * 2026-08-06 벤치에서 6종은 이미 나왔지만 **입사 후 포부는 카테고리 자체가 없었고**,
       * 약점·갈등·"왜 우리 회사"·마지막 할 말은 다른 질문에 흡수돼 있었다.
       * 프롬프트에서 이 지시가 빠지면 조용히 원래대로 돌아간다.
       */
      it('7) 공통 질문 목록은 종류에 맞게 들어간다 (technical → 3개만)', async () => {
        llm.call.mockResolvedValue({
          status: 'ok',
          text: '',
          json: { questions: [] },
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          latencyMs: 1,
          callLogId: 'log-1',
          outputRedacted: false,
        });
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          systemPrompt: string;
        };
        // 기술 면접이라 인성·가치관은 빠지고, 3개만 남는다
        expect(llmArg.systemPrompt).toContain('closing_remark');
        expect(llmArg.systemPrompt).toContain('reverse_question');
        expect(llmArg.systemPrompt).toMatch(/아래 3개만/);
        // 🔴 인성·가치관 질문을 넣지 말라는 지시가 실제로 있어야 한다
        expect(llmArg.systemPrompt).toMatch(/넣지 마라/);
      });

      /**
       * 🔴 v2 회귀 방어 — 프롬프트가 **답변을 만들라고 시키면 안 된다.**
       * 특히 `[본인 경험 채우기]` 지시는 2026-08-06 벤치에서 luna 답변 43% 에 그대로 누출됐다.
       * (모델 결함이 아니라 프롬프트가 시킨 것이었다.)
       */
      it('7b) SystemPrompt 에 답변 생성·플레이스홀더 지시가 남아 있지 않다', async () => {
        llm.call.mockResolvedValue({
          status: 'ok',
          text: '',
          json: { questions: [] },
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          latencyMs: 1,
          callLogId: 'log-1',
          outputRedacted: false,
        });
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          systemPrompt: string;
        };
        expect(llmArg.systemPrompt).not.toContain('본인 경험 채우기');
        expect(llmArg.systemPrompt).not.toContain('suggested_answer');
        expect(llmArg.systemPrompt).not.toContain('follow_ups');
        expect(llmArg.systemPrompt).toContain('모범 답안은 만들지 않는다');
      });
    });

    describe('Phase 1 — main 20개 응답 처리 + category 필드', () => {
      it('8) main 20개 응답 → 20개 모두 질문만 저장 (답변 없음)', async () => {
        const main20 = Array.from({ length: 20 }, (_, i) => ({
          category:
            i < 7 ? 'self_intro' : i < 14 ? 'coverletter_based' : 'cs_tech',
          question: `q${i + 1}`,
          source_log_ids: [],
        }));
        llm.call
          .mockResolvedValueOnce({
            status: 'ok',
            text: '',
            json: { questions: main20 },
            promptTokens: 500,
            // v2 — 답변을 안 만들어 출력이 1/5 로 줄었다 (벤치 실측: 답변이 출력의 82~86%)
            completionTokens: 1200,
            costUsd: 0.001,
            latencyMs: 3000,
            callLogId: 'log-big',
            outputRedacted: false,
          })
          .mockResolvedValueOnce(EMPTY_STAGE2);
        const r = await service.generateSession(USER_ID, SESSION_ID);
        expect(r.status).toBe('ok');
        expect(r.meta?.mainCount).toBe(20);
        expect(r.meta?.followupCount).toBe(0);

        const saved = fakeEm.save.mock.calls.map(
          ([, row]: [unknown, Record<string, unknown>]) => row,
        );
        expect(saved).toHaveLength(20);
        expect(saved.every((row) => row.suggestedAnswer === null)).toBe(true);
      });

      it('9) AI 가 한 카테고리 몰빵 (모두 self_intro) → graceful, 응답 그대로 저장', async () => {
        const allSelfIntro = Array.from({ length: 20 }, (_, i) => ({
          category: 'self_intro',
          question: `q${i + 1}`,
          suggested_answer: `a${i + 1}`,
          source_log_ids: [],
          follow_ups: [],
        }));
        llm.call
          .mockResolvedValueOnce({
            status: 'ok',
            text: '',
            json: { questions: allSelfIntro },
            promptTokens: 100,
            completionTokens: 4000,
            costUsd: 0.003,
            latencyMs: 2000,
            callLogId: 'log-mono',
            outputRedacted: false,
          })
          .mockResolvedValueOnce(EMPTY_STAGE2);
        const r = await service.generateSession(USER_ID, SESSION_ID);
        expect(r.status).toBe('ok');
        expect(r.meta?.mainCount).toBe(20);
        // 가이드 위반이지만 응답 수용 — Phase 1 단계 graceful 정책
      });
    });

    // Phase 1 의 'model-config cap 검증' 케이스는 `expect(true).toBe(true)` 껍데기였고,
    // 주석이 가리킨 model-config.spec 은 존재하지 않았다 — 즉 cap 은 어디서도 검증되지 않았다.
    // D0 (2026-08-01) 에서 `src/ai/model-config.spec.ts` 를 실제로 만들어 14개 feature 의
    // provider·모델·입출력 한도를 전부 박제했으므로, 여기서 중복 검증하지 않는다.

    // ── Phase 2 (2026-06-01) — SystemPrompt fork by jobCategory ──
    describe('Phase 2 — jobCategory 기반 직무 fork hint', () => {
      const makeLlmOk = () => {
        llm.call.mockResolvedValue({
          status: 'ok',
          text: '',
          json: { questions: [] },
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          latencyMs: 1,
          callLogId: 'log-1',
          outputRedacted: false,
        });
      };

      const setJobCategory = (jobCategory: string | null) => {
        appRepo.findOne.mockResolvedValueOnce({
          ...makeApp(),
          jobCategory,
        });
      };

      it("11) jobCategory '백엔드 개발자' → fork=developer, userPrompt 에 cs_tech 4축 키워드 inject", async () => {
        setJobCategory('백엔드 개발자');
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('직무 fork — developer');
        expect(llmArg.userPrompt).toContain('cs_tech');
        expect(llmArg.userPrompt).toContain('자료구조');
        expect(llmArg.userPrompt).toContain('DB');
        expect(llmArg.userPrompt).toContain('OS');
        expect(llmArg.userPrompt).toContain('네트워크');
      });

      it("12) jobCategory '전략기획' → fork=planner, business_reasoning 키워드 inject", async () => {
        setJobCategory('전략기획');
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('직무 fork — planner');
        expect(llmArg.userPrompt).toContain('business_reasoning');
        expect(llmArg.userPrompt).toContain('시장 사이즈 추정');
        expect(llmArg.userPrompt).toContain('재무제표');
      });

      it("13) jobCategory '퍼포먼스 마케터' → fork=marketer, data_metrics + trend_ai inject", async () => {
        setJobCategory('퍼포먼스 마케터');
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('직무 fork — marketer');
        expect(llmArg.userPrompt).toContain('data_metrics');
        expect(llmArg.userPrompt).toContain('trend_ai');
        expect(llmArg.userPrompt).toContain('ROAS');
        expect(llmArg.userPrompt).toContain('AI 마케팅');
      });

      it("14) jobCategory 'B2B 영업' → fork=sales, customer_handling + performance inject", async () => {
        setJobCategory('B2B 영업');
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('직무 fork — sales');
        expect(llmArg.userPrompt).toContain('customer_handling');
        expect(llmArg.userPrompt).toContain('performance');
        expect(llmArg.userPrompt).toContain('고객 불만');
        expect(llmArg.userPrompt).toContain('목표 미달성');
      });

      it("15) jobCategory 'UI/UX 디자이너' → fork=designer, portfolio_decision + design_process inject", async () => {
        setJobCategory('UI/UX 디자이너');
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('직무 fork — designer');
        expect(llmArg.userPrompt).toContain('portfolio_decision');
        expect(llmArg.userPrompt).toContain('design_process');
        expect(llmArg.userPrompt).toContain('의사결정 rationale');
      });

      /**
       * 🔴 원래 `jobCategory: null` 로 검증했는데, 직무 게이트(2026-08-06) 이후
       * 그 경로는 **BadRequest 로 막혀 도달할 수 없다.** fork null 은 여전히 가능하다 —
       * `기타` 처럼 값은 있는데 매칭되는 fork 가 없는 경우다. 그쪽으로 옮긴다.
       */
      it("16) 매칭 없는 직무('기타') → fork null, '기타/미지정' + coverletter_based 위주 가이드", async () => {
        setJobCategory('기타');
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('직무 fork — 기타/미지정');
        expect(llmArg.userPrompt).toContain('- 직무: 기타');
        expect(llmArg.userPrompt).toContain('coverletter_based 위주');
        // 직무 특화 키워드는 강조 X
        expect(llmArg.userPrompt).not.toContain('cs_tech 카테고리 4-5개 필수');
      });

      /**
       * 🔴 세션 생성 후 카드에서 직무를 지우면 "다시 생성" 이 **조용히 일반론 질문**을
       *    낸다 (fork 사망). 사용자는 왜 나빠졌는지 알 길이 없으므로 막는다.
       *    세션 페이지 사이드바·세션 자료 모달에서 바로 고칠 수 있어 막다른 길이 아니다.
       */
      it('16b) 세션 생성 후 직무가 지워졌으면 다시 생성 차단 + LLM 미호출', async () => {
        appRepo.findOne.mockResolvedValue({
          id: APP_ID,
          userId: USER_ID,
          companyName: '카카오',
          jobCategory: null,
          jobTitle: null,
        } as Application);
        makeLlmOk();
        await expect(
          service.generateSession(USER_ID, SESSION_ID),
        ).rejects.toThrow('지원 직무를 먼저 입력');
        expect(llm.call).not.toHaveBeenCalled();
      });

      it("17) fuzzy matching — '프론트엔드 엔지니어' → developer, '브랜드 마케팅 매니저' → marketer", async () => {
        // developer fuzzy
        setJobCategory('프론트엔드 엔지니어');
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        let llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('직무 fork — developer');

        // marketer fuzzy
        setJobCategory('브랜드 마케팅 매니저');
        makeLlmOk();
        (llm.call as jest.Mock).mockClear();
        await service.generateSession(USER_ID, SESSION_ID);
        llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('직무 fork — marketer');
      });
    });
  });

  // ── generateFollowup ──
  /**
   * v2 — 답변 on-demand 생성. 계획의 10축을 케이스로 옮긴 것.
   *
   * 🔴 가장 중요한 축은 **IDOR** 이다. 이 endpoint 는 `:questionId` 하나만 받으므로,
   * 소유권 체인(질문 → 세션 → user_id)이 뚫리면 **남의 자소서·활동 기록으로 만든 답변**을
   * 받아볼 수 있다. `findOwnedRaw` 가 그 가드이고, 여기서 호출 여부를 고정한다.
   */
  describe('generateAnswer (v2)', () => {
    const QUESTION_ID = 'q-1';
    const makeQuestion = (
      overrides: Partial<InterviewPrepQuestion> = {},
    ): InterviewPrepQuestion =>
      ({
        id: QUESTION_ID,
        sessionId: SESSION_ID,
        parentQuestionId: null,
        depth: 0,
        orderIndex: 0,
        questionText: '자기소개를 해주세요.',
        suggestedAnswer: null,
        sourceLogIds: [],
        myMemo: null,
        ...overrides,
      }) as unknown as InterviewPrepQuestion;

    const okAnswer = {
      status: 'ok' as const,
      text: '',
      json: { suggested_answer: '저는 …입니다.', source_log_ids: [] },
      promptTokens: 2000,
      completionTokens: 600,
      costUsd: 0.0007,
      latencyMs: 3000,
      callLogId: 'log-a',
      outputRedacted: false,
    };

    beforeEach(() => {
      questionsService.findOwnedRaw.mockResolvedValue(makeQuestion());
    });

    it('정상 — 답변이 저장되고 갱신된 질문을 반환한다', async () => {
      llm.call.mockResolvedValue(okAnswer);
      const r = await service.generateAnswer(USER_ID, QUESTION_ID);

      expect(r.status).toBe('ok');
      expect(r.question?.suggestedAnswer).toBe('저는 …입니다.');
      expect(questionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedAnswer: '저는 …입니다.' }),
      );
      expect(quotaCheck.checkAndPrepare).toHaveBeenCalledWith(
        USER_ID,
        'interview_prep_answer',
      );
    });

    it('🔴 IDOR — 소유권 확인을 findOwnedRaw 로 위임한다 (남의 질문이면 404 전파)', async () => {
      questionsService.findOwnedRaw.mockRejectedValueOnce(
        new NotFoundException('질문을 찾을 수 없습니다.'),
      );
      await expect(
        service.generateAnswer(USER_ID, 'q-someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('세션이 없으면 NotFound (질문만 남은 정합성 깨짐 방어)', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.generateAnswer(USER_ID, QUESTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('멱등 — 이미 답변이 있어도 재생성해 덮어쓴다 (myMemo 는 보존)', async () => {
      questionsService.findOwnedRaw.mockResolvedValueOnce(
        makeQuestion({ suggestedAnswer: '옛 답변', myMemo: '내가 쓴 초안' }),
      );
      llm.call.mockResolvedValue(okAnswer);

      const r = await service.generateAnswer(USER_ID, QUESTION_ID);
      expect(r.question?.suggestedAnswer).toBe('저는 …입니다.');
      expect(r.question?.myMemo).toBe('내가 쓴 초안');
    });

    it('사용자 초안(myMemo)이 있으면 프롬프트에 넣어 그 방향을 살린다', async () => {
      questionsService.findOwnedRaw.mockResolvedValueOnce(
        makeQuestion({ myMemo: '물류 인턴 경험을 강조하고 싶음' }),
      );
      llm.call.mockResolvedValue(okAnswer);

      await service.generateAnswer(USER_ID, QUESTION_ID);
      const arg = llm.call.mock.calls[0][0];
      expect(arg.userPrompt).toContain('물류 인턴 경험을 강조하고 싶음');
      expect(arg.userPrompt).toContain('자기소개를 해주세요.');
    });

    it('🔴 금전 — 코인/쿼터 차단 시 provider 미호출 + blocked_quota audit', async () => {
      quotaCheck.checkAndPrepare.mockResolvedValueOnce({
        blocked: true,
        code: 'DAY_LIMIT',
        reason: '오늘 사용 한도를 넘었어요.',
      });
      llm.call.mockResolvedValue({ ...okAnswer, callLogId: 'log-blocked' });

      const r = await service.generateAnswer(USER_ID, QUESTION_ID);
      expect(r.status).toBe('blocked');
      expect(llm.call).toHaveBeenCalledWith(
        expect.objectContaining({ preBlockedStatus: 'blocked_quota' }),
      );
      expect(questionRepo.save).not.toHaveBeenCalled();
    });

    it('🔴 외부 응답 — 답변이 비어 오면 저장하지 않고 blocked', async () => {
      llm.call.mockResolvedValue({
        ...okAnswer,
        json: { suggested_answer: '   ', source_log_ids: [] },
      });
      const r = await service.generateAnswer(USER_ID, QUESTION_ID);
      expect(r.status).toBe('blocked');
      expect(questionRepo.save).not.toHaveBeenCalled();
    });

    it('🔴 외부 응답 — LLM error 면 blocked, 저장 없음', async () => {
      // error 결과는 `json` 을 갖지 않는 별개 형태다 (okAnswer spread 하면 타입이 안 맞는다)
      llm.call.mockResolvedValue({
        status: 'error',
        text: null,
        errorMessage: 'provider 500',
        callLogId: 'log-a',
      });
      const r = await service.generateAnswer(USER_ID, QUESTION_ID);
      expect(r.status).toBe('blocked');
      expect(questionRepo.save).not.toHaveBeenCalled();
    });

    it('hallucination 방어 — 후보 풀 밖 로그 id 는 걸러 저장한다', async () => {
      llm.call.mockResolvedValue({
        ...okAnswer,
        json: {
          suggested_answer: 'a',
          source_log_ids: ['없는-id', 'another-fake'],
        },
      });
      const r = await service.generateAnswer(USER_ID, QUESTION_ID);
      expect(r.question?.sourceLogIds).toEqual([]);
    });
  });

  /**
   * 🔴 새로고침 복귀 (v2.1) — 생성은 ~10초라 그 사이 새로고침하면 화면이 빈 상태로
   *    돌아간다. `in_progress` 표시가 그 근거이고, **모든 종료 경로에서 반드시 풀려야**
   *    한다. 하나라도 빠지면 그 세션은 2분간 잠긴다.
   */
  describe('generateSession — 생성 상태 전이', () => {
    function claim(affected: number) {
      sessionRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected }),
      } as unknown as SelectQueryBuilder<InterviewPrepSession>);
    }

    it('이미 생성 중이면(claim 실패) LLM 을 부르지 않고 안내한다', async () => {
      claim(0);
      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('이미 질문을 만들고 있어요');
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('성공하면 completed 로 푼다', async () => {
      claim(1);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          questions: [
            { category: 'self_intro', question: 'q', source_log_ids: [] },
          ],
        },
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'log-1',
        outputRedacted: false,
      });
      await service.generateSession(USER_ID, SESSION_ID);
      expect(sessionRepo.update).toHaveBeenCalledWith(
        { id: SESSION_ID },
        expect.objectContaining({ generationStatus: 'completed' }),
      );
    });

    it('🔴 quota 차단이어도 idle 로 푼다 — 안 풀면 2분간 재시도가 막힌다', async () => {
      claim(1);
      quotaCheck.checkAndPrepare.mockResolvedValue({
        blocked: true,
        code: 'DAY_LIMIT',
        reason: '한도 초과',
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: '한도 초과',
        callLogId: 'log-q',
      });
      await service.generateSession(USER_ID, SESSION_ID);
      expect(sessionRepo.update).toHaveBeenCalledWith(
        { id: SESSION_ID },
        expect.objectContaining({ generationStatus: 'idle' }),
      );
    });

    /**
     * 🔴 외부 응답 개별 항목 검증 (9축 · 2026-08-07 QA 발견).
     *
     * `question_text` 는 NOT NULL 이다. 빈 항목이 섞여 오면 insert 가 터지고 트랜잭션이
     * 통째로 롤백돼 **20개가 전부 날아간다.** LLM 호출은 이미 끝난 뒤라 코인은 나갔는데
     * 사용자는 500 을 본다. 막지 말고 거른다 — 19개라도 쓸 수 있는 편이 낫다.
     */
    it('🔴 본문 없는 질문이 섞여 와도 나머지는 저장한다 (500·전량 소실 방지)', async () => {
      claim(1);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          questions: [
            {
              category: 'self_intro',
              question: '자기소개 해주세요',
              source_log_ids: [],
            },
            { category: 'job_fit', question: '   ', source_log_ids: [] }, // 공백만
            { category: 'job_fit', source_log_ids: [] }, // 필드 자체 없음
            {
              category: 'closing_remark',
              question: '마지막 한마디',
              source_log_ids: [],
            },
          ],
        },
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'log-partial',
        outputRedacted: false,
      });
      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('ok');
      expect(r.meta?.mainCount).toBe(2);
      const saved = fakeEm.save.mock.calls.map(
        (c) => (c[1] as InterviewPrepQuestion).questionText,
      );
      expect(saved).toEqual(['자기소개 해주세요', '마지막 한마디']);
    });

    it('🔴 전부 본문이 없으면 빈 응답으로 안내한다 (빈 세션 저장 X)', async () => {
      claim(1);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          questions: [
            { category: 'self_intro', question: '', source_log_ids: [] },
            { category: 'job_fit', source_log_ids: [] },
          ],
        },
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'log-empty',
        outputRedacted: false,
      });
      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('비어있어요');
      expect(fakeEm.save).not.toHaveBeenCalled();
    });

    it('질문 본문 앞뒤 공백은 저장 전에 정리한다', async () => {
      claim(1);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          questions: [
            {
              category: 'self_intro',
              question: '  자기소개  ',
              source_log_ids: [],
            },
          ],
        },
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'log-trim',
        outputRedacted: false,
      });
      await service.generateSession(USER_ID, SESSION_ID);
      expect(
        (fakeEm.save.mock.calls[0][1] as InterviewPrepQuestion).questionText,
      ).toBe('자기소개');
    });

    /**
     * 🔴 차단 문구가 실제 이유와 맞는가 (15축 ⑤ · 2026-08-07).
     *
     * in-flight lock 차단은 audit 호환 때문에 status 로 `blocked_quota` 를 **재사용**한다.
     * 문구까지 같이 쓰면 "한도를 초과했어요" 가 떠서, 방금 누른 생성이 아직 도는 것뿐인데
     * 사용자는 한도에 걸린 줄 알고 포기하거나 문의한다. 코인도 안 나갔는데 나간 줄 안다.
     *
     * 진입점이 3개(세션·답변·꼬리질문)라 한 곳만 고치면 나머지가 조용히 틀린 문구를 낸다.
     */
    it('🔴 ALREADY_RUNNING 은 한도 초과가 아니라 "생성 중" 으로 안내한다', async () => {
      claim(1);
      llm.call.mockResolvedValue({
        status: 'blocked_quota', // audit 호환 — 실제 이유는 code 에 있다
        text: null,
        errorMessage: '[ALREADY_RUNNING] 동일 요청 진행 중',
        code: 'ALREADY_RUNNING',
        callLogId: 'log-run',
      });
      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('이미 생성 중');
      expect(r.reason).toContain('코인은 한 번만');
      // 🔴 이게 핵심 — 한도 문구가 새어 나오면 안 된다
      expect(r.reason).not.toContain('한도');
    });

    it('🔴 code 없는 진짜 한도 초과는 한도 문구 그대로', async () => {
      claim(1);
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: '오늘 한도를 다 썼어요.',
        callLogId: 'log-q2',
      });
      const r = await service.generateSession(USER_ID, SESSION_ID);
      expect(r.reason).toContain('한도');
      expect(r.reason).not.toContain('이미 생성 중');
    });

    it('🔴 본문이 예외를 던져도 failed 로 푼다 (직무 게이트 등)', async () => {
      claim(1);
      appRepo.findOne.mockResolvedValue({
        id: APP_ID,
        userId: USER_ID,
        companyName: '카카오',
        jobCategory: null,
        jobTitle: null,
      } as Application);
      await expect(
        service.generateSession(USER_ID, SESSION_ID),
      ).rejects.toThrow();
      expect(sessionRepo.update).toHaveBeenCalledWith(
        { id: SESSION_ID },
        expect.objectContaining({ generationStatus: 'failed' }),
      );
    });
  });

  describe('generateFollowup', () => {
    const parentEntity = {
      id: 'q-parent',
      sessionId: SESSION_ID,
      parentQuestionId: null,
      depth: 0,
      orderIndex: 0,
      questionText: 'parent q',
      // 🔴 20자 이상 — `MIN_PROBEABLE_ANSWER_CHARS` 미만이면 "추궁할 답변 없음" 으로 빠진다
      suggestedAnswer:
        '주문 처리 API 응답 속도를 850ms에서 210ms로 개선했습니다.',
      sourceLogIds: [],
      myMemo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as InterviewPrepQuestion;

    beforeEach(() => {
      questionsService.assertCanCreateFollowup.mockResolvedValue(parentEntity);
    });

    it('정상: parent depth=0 → child depth=1 + orderIndex max+1', async () => {
      qQb.getRawOne.mockResolvedValueOnce({ maxIdx: 2 });
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          question: 'followup q',
          suggested_answer: 'followup a',
          source_log_ids: [],
        },
        promptTokens: 50,
        completionTokens: 30,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'log-f',
        outputRedacted: false,
      });

      const r = await service.generateFollowup(USER_ID, 'q-parent');
      expect(r.status).toBe('ok');
      expect(r.question?.depth).toBe(1); // parent.depth + 1
      expect(r.question?.orderIndex).toBe(3); // max(2) + 1
      expect(r.question?.parentQuestionId).toBe('q-parent');
    });

    it('parent.depth=2 → assertCanCreateFollowup 가 BadRequest 던짐 (가드)', async () => {
      // assertCanCreateFollowup 가 BadRequest 던지는 시나리오는 questions.service.spec 영역.
      // 여기서는 던지면 그대로 전파됨을 확인.
      questionsService.assertCanCreateFollowup.mockRejectedValueOnce(
        new Error('MAX_DEPTH_REACHED'),
      );
      await expect(
        service.generateFollowup(USER_ID, 'q-parent'),
      ).rejects.toThrow('MAX_DEPTH_REACHED');
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('quota DAY_LIMIT → blocked + abuser ban 트리거', async () => {
      quotaCheck.checkAndPrepare.mockResolvedValueOnce({
        blocked: true,
        code: 'DAY_LIMIT',
        reason: '오늘 한도',
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'day',
        callLogId: 'log-b',
      });

      const r = await service.generateFollowup(USER_ID, 'q-parent');
      expect(r.status).toBe('blocked');
      await new Promise((r) => setTimeout(r, 10));
      expect(abuserBan.checkAndBan).toHaveBeenCalledWith(
        USER_ID,
        'interview_prep_followup',
        1,
      );
    });

    it('LLM JSON 비어있음 (question=undefined) → blocked', async () => {
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: { question: undefined, suggested_answer: '', source_log_ids: [] },
        promptTokens: 30,
        completionTokens: 5,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'log-e',
        outputRedacted: false,
      });
      const r = await service.generateFollowup(USER_ID, 'q-parent');
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('비어있어요');
    });

    it('hallucination — 응답 source_log_ids 가 candidate 외 → filter', async () => {
      const parentWithLogs = { ...parentEntity, sourceLogIds: ['log-A'] };
      questionsService.assertCanCreateFollowup.mockResolvedValueOnce(
        parentWithLogs,
      );
      sessionRepo.findOne.mockResolvedValueOnce(
        makeSession({ extraLogIds: ['log-B'] }),
      );
      // candidate logs = ['log-A', 'log-B'] (union dedup)
      logRepo.find.mockResolvedValueOnce([makeLog('log-A'), makeLog('log-B')]);
      qQb.getRawOne.mockResolvedValueOnce({ maxIdx: null });
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          question: 'f',
          suggested_answer: 'a',
          source_log_ids: ['log-A', 'FAKE'],
        },
        promptTokens: 30,
        completionTokens: 15,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'log-f',
        outputRedacted: false,
      });

      const r = await service.generateFollowup(USER_ID, 'q-parent');
      expect(r.status).toBe('ok');
      expect(r.question?.sourceLogIds).toEqual(['log-A']); // FAKE 제거
    });

    it('orderIndex: 시블링 0 → 첫 followup orderIndex=0', async () => {
      qQb.getRawOne.mockResolvedValueOnce({ maxIdx: null }); // 시블링 없음
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          question: 'first followup',
          suggested_answer: 'a',
          source_log_ids: [],
        },
        promptTokens: 30,
        completionTokens: 15,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'log-f',
        outputRedacted: false,
      });

      const r = await service.generateFollowup(USER_ID, 'q-parent');
      expect(r.question?.orderIndex).toBe(0); // null → -1 → +1 = 0
    });

    // Phase 4 (단계 A) — prompt 확장
    it('parent.myMemo 가 있으면 → prompt 에 "★ 사용자 실제 답변" 포함 (AI 모범 답안보다 우선)', async () => {
      const parentWithMemo = {
        ...parentEntity,
        myMemo: '저는 데이터로 설득해 ROAS 1.8 달성했습니다',
      } as InterviewPrepQuestion;
      questionsService.assertCanCreateFollowup.mockResolvedValueOnce(
        parentWithMemo,
      );
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: { question: 'f', suggested_answer: 'a', source_log_ids: [] },
        promptTokens: 30,
        completionTokens: 15,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'log-f',
        outputRedacted: false,
      });

      await service.generateFollowup(USER_ID, 'q-parent');
      const callArg = llm.call.mock.calls[0][0];
      expect(callArg.userPrompt).toContain('★ 사용자가 실제로 적은 본인 답변');
      expect(callArg.userPrompt).toContain('ROAS 1.8 달성');
    });

    /**
     * v2 — 추궁 대상이 **3단으로 내려간다.** 세션 생성이 질문만 만들어서
     * 부모 답변이 아예 없는 상태가 정상 경로가 됐기 때문이다 (v1 엔 항상 AI 답변이 있었다).
     * 세 갈래를 다 덮지 않으면 "답변 없는 질문에 꼬리질문" 이라는 **가장 흔한 케이스**가
     * 검증 밖으로 나간다.
     */
    const okFollowup = {
      status: 'ok' as const,
      text: '',
      json: { question: 'f', source_log_ids: [] },
      promptTokens: 30,
      completionTokens: 15,
      costUsd: 0.0001,
      latencyMs: 100,
      callLogId: 'log-f',
      outputRedacted: false,
    };

    it('myMemo 없고 AI 답변만 있으면 → AI 답변을 추궁 대상으로 준다', async () => {
      questionsService.assertCanCreateFollowup.mockResolvedValueOnce({
        ...parentEntity,
        myMemo: null,
        suggestedAnswer:
          'AI 가 만든 답변입니다. 캐시를 도입해 응답을 줄였습니다.',
      });
      llm.call.mockResolvedValue(okFollowup);

      await service.generateFollowup(USER_ID, 'q-parent');
      const callArg = llm.call.mock.calls[0][0];
      expect(callArg.userPrompt).toContain('AI 답변');
      expect(callArg.userPrompt).toContain('AI 가 만든 답변입니다');
      expect(callArg.userPrompt).not.toContain('★');
    });

    it('myMemo·AI 답변 둘 다 없으면 → 부모 질문 자체를 파고들라고 지시한다', async () => {
      questionsService.assertCanCreateFollowup.mockResolvedValueOnce({
        ...parentEntity,
        myMemo: null,
        suggestedAnswer: null,
      });
      llm.call.mockResolvedValue(okFollowup);

      await service.generateFollowup(USER_ID, 'q-parent');
      const callArg = llm.call.mock.calls[0][0];
      expect(callArg.userPrompt).toContain('부모 질문 자체를 한 단계 더 깊이');
    });

    it('v2: 꼬리질문도 답변을 저장하지 않는다 (응답에 섞여 와도 null)', async () => {
      questionsService.assertCanCreateFollowup.mockResolvedValueOnce({
        ...parentEntity,
        myMemo: null,
        suggestedAnswer: null,
      });
      llm.call.mockResolvedValue({
        ...okFollowup,
        // 스키마에서 뺐지만 모델이 옛 형태로 답할 수 있다 (벤치에서 실제로 확인된 실패 모드)
        json: { question: 'f', suggested_answer: 'a', source_log_ids: [] },
      });

      await service.generateFollowup(USER_ID, 'q-parent');
      expect(questionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedAnswer: null, depth: 1 }),
      );
    });

    /**
     * 🔴 판정이 맞아도 **저장 배선이 빠지면** 배지가 안 뜬다.
     *    `resolveFollowupBasis` 단위 테스트만으로는 이걸 못 잡는다.
     */
    it.each([
      [
        '메모가 있으면 my_memo',
        {
          myMemo: '제가 직접 적은 답변입니다. 인덱스를 추가해 해결했습니다.',
          suggestedAnswer: null,
        },
        'my_memo',
      ],
      [
        'AI 답변만 있으면 ai_answer',
        {
          myMemo: null,
          suggestedAnswer:
            'AI 가 만든 답변입니다. 캐시를 도입해 응답을 줄였습니다.',
        },
        'ai_answer',
      ],
      [
        '둘 다 없으면 question',
        { myMemo: null, suggestedAnswer: null },
        'question',
      ],
    ])('%s — 그 값이 실제로 저장된다', async (_l, patch, expected) => {
      // 🔴 부모는 `assertCanCreateFollowup` 이 돌려준다 (findOwnedRaw 아님)
      questionsService.assertCanCreateFollowup.mockResolvedValue({
        ...parentEntity,
        ...patch,
      });
      llm.call.mockResolvedValue(okFollowup);

      await service.generateFollowup(USER_ID, 'q-parent');
      expect(questionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ followupBasis: expected }),
      );
    });

    /**
     * 🔴 2026-08-07 — 공고 요건 출처가 바뀌었다. v2 에서 `session.jobDescription` 을
     *    프롬프트에서 걷어냈는데 **꼬리질문만 그걸 계속 보고 있었다.** 그 필드는 이제
     *    아무도 안 채우므로 꼬리질문은 사실상 공고를 못 봤다. `app.jobPosting` 으로 바꿨다.
     */
    it('회사·직무·공고 요건·강조 포인트 모두 prompt 에 포함 (followup 정확도 ↑)', async () => {
      appRepo.findOne.mockResolvedValue({
        id: APP_ID,
        userId: USER_ID,
        companyName: '카카오',
        jobCategory: '백엔드',
        jobTitle: '백엔드 개발자',
        jobPosting: {
          responsibilities: '결제 백엔드 개발',
          requirements: ['C++ 5년'],
          preferred: ['MSA 경험 우대'],
          techStack: [],
          qualifications: [],
          keywords: [],
          parsedAt: '2026-08-01T00:00:00Z',
        },
      } as unknown as Application);
      sessionRepo.findOne.mockResolvedValueOnce({
        ...makeSession({ emphasisPoints: '갈등 중재 경험을 어필' }),
      });
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: { question: 'f', suggested_answer: 'a', source_log_ids: [] },
        promptTokens: 30,
        completionTokens: 15,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'log-f',
        outputRedacted: false,
      });

      await service.generateFollowup(USER_ID, 'q-parent');
      const callArg = llm.call.mock.calls[0][0];
      // 회사·직무 — jobTitle 우선 (resolveJobText)
      expect(callArg.userPrompt).toContain('카카오');
      expect(callArg.userPrompt).toContain('백엔드 개발자');
      // 차수·종류
      expect(callArg.userPrompt).toContain('1차');
      // 🔴 공고 요건 — jobPosting 경로
      expect(callArg.userPrompt).toContain('MSA 경험 우대');
      // 강조 포인트
      expect(callArg.userPrompt).toContain('갈등 중재 경험을 어필');
      expect(callArg.userPrompt).toContain('검증·약점 파고들기');
      // v2 — 답변을 만들라고 시키지 않는다 (system 과 어긋나던 문구)
      expect(callArg.userPrompt).not.toContain('모범 답안을 만드세요');
    });

    it('🔴 형제 질문을 프롬프트에 넣어 중복을 막는다', async () => {
      // 실측: 꼬리질문 18건 중 7건이 재진술·타 문항 중복이었다 (부모만 보고 만들어서)
      questionRepo.find.mockResolvedValue([
        { id: 'q-a', questionText: '이미 있는 질문 A', parentQuestionId: null },
        { id: 'q-parent', questionText: '부모 자신', parentQuestionId: null },
      ] as InterviewPrepQuestion[]);
      llm.call.mockResolvedValue(okFollowup);

      await service.generateFollowup(USER_ID, 'q-parent');
      const p = llm.call.mock.calls[0][0].userPrompt;
      expect(p).toContain('이미 나온 질문들');
      expect(p).toContain('이미 있는 질문 A');
      // 본인은 빼야 한다 (부모 블록에 이미 있다)
      expect(p).not.toContain('- 부모 자신');
    });
  });
});

/**
 * 🔴 꼬리질문 근거 판정 (v2.1) — **프롬프트 분기와 저장값이 같아야 한다.**
 *    갈리면 화면엔 "내 답변 기반" 인데 실제로는 질문만 보고 만든 상태가 된다.
 */
/**
 * 🔴 답변 프롬프트 회귀 (2026-08-07 Fable 교차검증).
 *
 * 이 프롬프트는 이미 한 번 같은 실수를 했다 — `[본인 경험 채우기]` 플레이스홀더를 없애면서
 * **"~를 더하면 설득력이 커집니다" 라는 코치 문장을 넣으라고 지시**했고, 그게 답변 30개 중
 * 5개에 그대로 실렸다. 1인칭 면접 발화에 3인칭 조언이 섞이면 사용자가 그것까지 외운다.
 *
 * 그리고 "지어내기 금지" 가 **수치에만 걸려 있어서**, 성공 사례뿐인 자료에서 없던 오판을
 * 만들어 실패담으로 쓰는 사례를 못 막았다. 지시가 빠지면 조용히 되돌아간다.
 */
describe('ANSWER_SYSTEM_PROMPT — 답변 본문 오염 방지', () => {
  it('🔴 코치 문장을 넣으라고 시키지 않는다', () => {
    expect(ANSWER_SYSTEM_PROMPT).not.toMatch(/설득력이 커집니다/);
    expect(ANSWER_SYSTEM_PROMPT).toMatch(/코치 문장도 쓰지 마라/);
    expect(ANSWER_SYSTEM_PROMPT).toMatch(/그대로 말할 1인칭 발화/);
  });

  it('플레이스홀더 금지는 유지된다 (이전 회귀)', () => {
    expect(ANSWER_SYSTEM_PROMPT).toMatch(/대괄호 템플릿을 쓰지 마라/);
  });

  it('🔴 지어내기 금지가 수치를 넘어 판단·동기·인과까지 덮는다', () => {
    expect(ANSWER_SYSTEM_PROMPT).toMatch(/판단·동기·인과·평가/);
    expect(ANSWER_SYSTEM_PROMPT).toMatch(/없던 오판을 만들어/);
  });

  it('🔴 약점·실패 질문에 자료가 없으면 창작하지 말라고 명시한다', () => {
    expect(ANSWER_SYSTEM_PROMPT).toMatch(
      /약점·실패 질문에 자료가 없으면 만들어내지 마라/,
    );
  });

  it('짧게 끝내는 것이 늘리는 것보다 낫다고 명시한다', () => {
    expect(ANSWER_SYSTEM_PROMPT).toMatch(/짧아도 된다/);
  });
});

/**
 * 🔴 인젝션 guard 회귀 (2026-08-07).
 *
 * 답변·꼬리질문 프롬프트의 guard 문은 **코드에만 있고 테스트가 없었다.** 지워도
 * 아무 spec 이 안 깨진다. 두 프롬프트 다 이번 회차에 크게 손댔고(코치 문장 제거·형제
 * 블록 추가) 다음 회차에 또 손댈 예정이라, 지금이 방어를 박아둘 시점이다.
 *
 * 문구가 서로 다르므로(`무시한다` vs `무시하라`) 문장 전체가 아니라 **필수 개념**
 * 세 가지로 검사한다 — system prompt 변경 · role 변경 · 무시 지시.
 */
describe('인젝션 guard — 답변·꼬리질문 프롬프트', () => {
  it.each([
    ['ANSWER', ANSWER_SYSTEM_PROMPT],
    ['FOLLOWUP', FOLLOWUP_SYSTEM_PROMPT],
  ])(
    '%s — system prompt 변경·role 변경 요구를 무시하라는 지시가 있다',
    (_n, p) => {
      expect(p).toContain('system prompt 변경');
      expect(p).toContain('role 변경');
      expect(p).toMatch(/무시한다|무시하라/);
    },
  );

  it.each([
    ['ANSWER', ANSWER_SYSTEM_PROMPT],
    ['FOLLOWUP', FOLLOWUP_SYSTEM_PROMPT],
  ])('%s — 사용자 자료가 명령이 아니라 참고 정보임을 못박는다', (_n, p) => {
    expect(p).toMatch(/참고 정보|참고 정보다|'참고 정보'/);
  });
});

describe('resolveFollowupBasis', () => {
  const LONG = '가'.repeat(MIN_PROBEABLE_ANSWER_CHARS);
  const AI_LONG = '나'.repeat(MIN_PROBEABLE_ANSWER_CHARS);

  it.each([
    [
      '메모가 충분히 길면 메모',
      { myMemo: LONG, suggestedAnswer: AI_LONG },
      'my_memo',
    ],
    [
      '메모 없고 AI 답변',
      { myMemo: null, suggestedAnswer: AI_LONG },
      'ai_answer',
    ],
    [
      '둘 다 없으면 질문 심화',
      { myMemo: null, suggestedAnswer: null },
      'question',
    ],
    [
      '공백만인 메모는 없는 것',
      { myMemo: '   ', suggestedAnswer: AI_LONG },
      'ai_answer',
    ],
    ['공백만 둘 다', { myMemo: ' ', suggestedAnswer: '  ' }, 'question'],
  ] as const)('%s', (_label, parent, expected) => {
    expect(resolveFollowupBasis(parent)).toBe(expected);
  });

  /**
   * 🔴 `trim()` 만 보면 `ㅏ` 한 글자도 "답변 있음" 이 된다. 그 상태로 꼬리질문을 만들면
   *    모델이 그 한 글자를 답변으로 알고 추궁해 **말이 안 되는 질문**이 나오고 코인도 나간다.
   */
  it.each(['ㅏ', 'ㅇ', '음', '네', '잘 모르겠음', '가'.repeat(19)])(
    '너무 짧은 메모(%s)는 답변으로 치지 않는다 — 질문 심화로 내려간다',
    (short) => {
      expect(
        resolveFollowupBasis({ myMemo: short, suggestedAnswer: null }),
      ).toBe('question');
    },
  );

  it('경계 — 정확히 최소 길이면 답변으로 친다', () => {
    expect(resolveFollowupBasis({ myMemo: LONG, suggestedAnswer: null })).toBe(
      'my_memo',
    );
  });

  it('줄바꿈만 잔뜩인 메모도 걸러진다 — 공백은 길이에 안 넣는다', () => {
    expect(
      resolveFollowupBasis({
        myMemo: '가\n'.repeat(10),
        suggestedAnswer: null,
      }),
    ).toBe('question');
  });

  it('짧은 메모 + 충분한 AI 답변 → AI 답변을 추궁한다', () => {
    expect(
      resolveFollowupBasis({ myMemo: 'ㅏ', suggestedAnswer: AI_LONG }),
    ).toBe('ai_answer');
  });
});
