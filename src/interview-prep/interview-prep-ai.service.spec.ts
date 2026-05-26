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
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get<InterviewPrepAiService>(InterviewPrepAiService);
  });

  // ── generateSession ──
  describe('generateSession', () => {
    it('정상: Hybrid main 2 + 각 1 followup → 트리 저장 + meta', async () => {
      llm.call.mockResolvedValue({
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
      });

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
  });
});
