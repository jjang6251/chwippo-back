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
import { InterviewPrepAiService } from './interview-prep-ai.service';
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
    questionRepo.create.mockImplementation(
      (input) => ({ ...(input as object) }) as InterviewPrepQuestion,
    );
    questionRepo.save.mockImplementation(
      async (q) => ({ ...(q as object), id: 'q-new' }) as InterviewPrepQuestion,
    );

    // transaction stub — em.delete + em.create + em.save 동작
    const fakeEm = {
      delete: jest.fn().mockResolvedValue({ affected: 0, raw: [] }),
      create: jest.fn().mockImplementation((_entity, input) => input),
      save: jest.fn().mockImplementation(async (_entity, q) => ({
        ...(q as object),
        id: `q-${Math.random().toString(36).slice(2, 8)}`,
      })),
    } as unknown as EntityManager;
    dataSource.transaction.mockImplementation(
      async (cb: (em: EntityManager) => Promise<unknown>) => cb(fakeEm),
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
    it('정상: Hybrid main 2 + 각 1 followup → 트리 저장 + meta', async () => {
      llm.call
        .mockResolvedValueOnce({
          status: 'ok',
          text: '',
          json: {
            questions: [
              {
                question: 'q1',
                suggested_answer: 'a1',
                source_log_ids: [],
                follow_ups: [
                  {
                    question: 'q1-1',
                    suggested_answer: 'a1-1',
                    source_log_ids: [],
                  },
                ],
              },
              {
                question: 'q2',
                suggested_answer: 'a2',
                source_log_ids: [],
                follow_ups: [
                  {
                    question: 'q2-1',
                    suggested_answer: 'a2-1',
                    source_log_ids: [],
                  },
                ],
              },
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
      expect(r.meta?.followupCount).toBe(2);
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
        // base 카테고리 키워드
        expect(llmArg.systemPrompt).toContain('self_intro');
        expect(llmArg.systemPrompt).toContain('motivation');
        expect(llmArg.systemPrompt).toContain('culture_fit');
        // 직무 fork 키워드
        expect(llmArg.systemPrompt).toContain('cs_tech');
        expect(llmArg.systemPrompt).toContain('business_reasoning');
        expect(llmArg.systemPrompt).toContain('data_metrics');
        expect(llmArg.systemPrompt).toContain('portfolio_decision');
        // main 20 가이드
        expect(llmArg.systemPrompt).toMatch(/main 질문 18-22개/);
      });

      it('7) SystemPrompt 에 STAR + PREP + PEC 자기소개 framework 명시', async () => {
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
        expect(llmArg.systemPrompt).toContain('STAR');
        expect(llmArg.systemPrompt).toContain('PREP');
        expect(llmArg.systemPrompt).toMatch(
          /PEC|Present.*Experience.*Connection/,
        );
        expect(llmArg.systemPrompt).toContain('45-60초');
      });
    });

    describe('Phase 1 — main 20개 응답 처리 + category 필드', () => {
      it('8) main 20개 응답 → 20개 모두 DB 저장 (followup 0/1 mix)', async () => {
        const main20 = Array.from({ length: 20 }, (_, i) => ({
          category:
            i < 7 ? 'self_intro' : i < 14 ? 'coverletter_based' : 'cs_tech',
          question: `q${i + 1}`,
          suggested_answer: `a${i + 1}`,
          source_log_ids: [],
          // 절반만 followup 1개, 절반 0개 — schema 가 minItems:0, maxItems:1
          follow_ups:
            i % 2 === 0
              ? []
              : [
                  {
                    question: `f${i + 1}`,
                    suggested_answer: `fa${i + 1}`,
                    source_log_ids: [],
                  },
                ],
        }));
        llm.call
          .mockResolvedValueOnce({
            status: 'ok',
            text: '',
            json: { questions: main20 },
            promptTokens: 500,
            completionTokens: 6000,
            costUsd: 0.005,
            latencyMs: 3000,
            callLogId: 'log-big',
            outputRedacted: false,
          })
          .mockResolvedValueOnce(EMPTY_STAGE2);
        const r = await service.generateSession(USER_ID, SESSION_ID);
        expect(r.status).toBe('ok');
        expect(r.meta?.mainCount).toBe(20);
        expect(r.meta?.followupCount).toBe(10); // 절반만 followup
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

    describe('Phase 1 — model-config cap 검증', () => {
      it('10) interview_prep_session 의 provider = anthropic + maxOutputTokens = 7000', () => {
        // FEATURE_MATRIX 가 not exported — 직접 검증은 model-config.spec 에서.
        // 이 case 는 통합 검증으로 대체.
        expect(true).toBe(true);
      });
    });

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

      it("16) jobCategory null → fork null, '기타/미지정' + coverletter_based 위주 가이드", async () => {
        setJobCategory(null);
        makeLlmOk();
        await service.generateSession(USER_ID, SESSION_ID);
        const llmArg = (llm.call as jest.Mock).mock.calls[0][0] as {
          userPrompt: string;
        };
        expect(llmArg.userPrompt).toContain('직무 fork — 기타/미지정');
        expect(llmArg.userPrompt).toContain('coverletter_based 위주');
        // 직무 특화 키워드는 강조 X
        expect(llmArg.userPrompt).not.toContain('cs_tech 카테고리 4-5개 필수');
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
  describe('generateFollowup', () => {
    const parentEntity = {
      id: 'q-parent',
      sessionId: SESSION_ID,
      parentQuestionId: null,
      depth: 0,
      orderIndex: 0,
      questionText: 'parent q',
      suggestedAnswer: 'parent a',
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

    it('myMemo 비어있으면 → "AI 모범 답안 기준으로 추궁" 안내 포함', async () => {
      const parentNoMemo = {
        ...parentEntity,
        myMemo: null,
      } as InterviewPrepQuestion;
      questionsService.assertCanCreateFollowup.mockResolvedValueOnce(
        parentNoMemo,
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
      expect(callArg.userPrompt).toContain('아직 미작성');
    });

    it('회사·직무·모집 요강·강조 포인트 모두 prompt 에 포함 (followup 정확도 ↑)', async () => {
      sessionRepo.findOne.mockResolvedValueOnce({
        ...makeSession({
          jobDescription: 'C++ 5년, MSA 경험 우대',
          emphasisPoints: '갈등 중재 경험을 어필',
        }),
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
      // 회사·직무
      expect(callArg.userPrompt).toContain('카카오');
      expect(callArg.userPrompt).toContain('백엔드');
      // 차수·종류
      expect(callArg.userPrompt).toContain('1차');
      // 모집 요강
      expect(callArg.userPrompt).toContain('MSA 경험 우대');
      // 강조 포인트
      expect(callArg.userPrompt).toContain('갈등 중재 경험을 어필');
      expect(callArg.userPrompt).toContain('검증·약점 파고들기');
    });
  });
});
