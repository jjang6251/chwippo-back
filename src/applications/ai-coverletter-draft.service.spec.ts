import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository } from 'typeorm';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import { LlmService } from '../ai/llm.service';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { ActivityReflection } from '../activity/entities/activity-reflection.entity';
import { MyinfoService } from '../myinfo/myinfo.service';
import {
  AiCoverletterDraftService,
  COVERLETTER_AI_LIMITS,
} from './ai-coverletter-draft.service';
import { Application } from './application.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { CoverletterSourceRef } from './coverletter-source-ref.entity';
import { CoverletterSourceRefsService } from './coverletter-source-refs.service';

/**
 * F6 PR 1 — AiCoverletterDraftService spec.
 *
 * 시나리오:
 * - 정상 흐름 (recommend OK + draft OK + ref 저장)
 * - cl 다른 user (NotFound) / question 비어있음 (BadRequest) / application 없음 (NotFound)
 * - IDOR batch fail 전파 (Forbidden)
 * - quota: draft 일 한도 / 월 한도 / recommend 한도 (recommend 만 skip, draft 진행)
 * - skipRecommend=true → recommend 호출 0
 * - recommend hallucination (가짜 log_id) → filter
 * - recommend LLM error → 빈 추천 + draft 계속
 * - draft LLM error / blocked_consent / blocked_input_cap / blocked_moderation 매핑
 * - selected log 가 candidates 에 있어도 excludeIds 로 제외
 * - candidates 비어있음 → recommend 호출 0
 */
describe('AiCoverletterDraftService', () => {
  let service: AiCoverletterDraftService;
  let clRepo: jest.Mocked<Repository<ApplicationCoverletter>>;
  let logCallRepo: jest.Mocked<Repository<LlmCallLog>>;
  let activityLogRepo: jest.Mocked<Repository<ActivityLog>>;
  let reflectionRepo: jest.Mocked<Repository<ActivityReflection>>;
  let sourceRefs: jest.Mocked<CoverletterSourceRefsService>;
  let llm: jest.Mocked<LlmService>;
  let myinfo: jest.Mocked<MyinfoService>;

  const USER_ID = 'user-1';
  const CL_ID = 'cl-1';

  const makeCl = (
    overrides: Partial<ApplicationCoverletter> = {},
  ): ApplicationCoverletter =>
    ({
      id: CL_ID,
      applicationId: 'app-1',
      question: '지원동기를 작성하세요',
      category: '지원동기',
      answer: null,
      charLimit: 500,
      orderIndex: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as ApplicationCoverletter;

  const makeClWithApp = (
    clOverrides: Partial<ApplicationCoverletter> = {},
  ) => ({
    ...makeCl(clOverrides),
    application: {
      id: 'app-1',
      companyName: '카카오',
      jobCategory: '백엔드',
    } as Application,
  });

  const makeLog = (
    id: string,
    overrides: Partial<ActivityLog> = {},
  ): ActivityLog =>
    ({
      id,
      activityId: 'act-1',
      userId: USER_ID,
      content: '로그 내용',
      occurredAt: '2026-05-01',
      cat: null,
      comps: [],
      cl: [],
      quant: null,
      mood: null,
      keywords: [],
      note: null,
      noteSummary: null,
      noteSummaryHash: null,
      noteSummaryAt: null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      activity: undefined,
      ...overrides,
    }) as ActivityLog;

  const EMPTY_MYINFO_DUMP = {
    coverletterDrafts: [],
    experiences: [],
    educations: [],
    certs: [],
    awards: [],
  };

  beforeEach(async () => {
    clRepo = mock<Repository<ApplicationCoverletter>>();
    const refRepo = mock<Repository<CoverletterSourceRef>>();
    logCallRepo = mock<Repository<LlmCallLog>>();
    activityLogRepo = mock<Repository<ActivityLog>>();
    reflectionRepo = mock<Repository<ActivityReflection>>();
    sourceRefs = mock<CoverletterSourceRefsService>();
    llm = mock<LlmService>();
    myinfo = mock<MyinfoService>();

    // defaults
    sourceRefs.assertOwnsCoverletter.mockResolvedValue(makeCl());
    sourceRefs.assertSelectedRefsBelongToUser.mockResolvedValue([]);
    sourceRefs.loadRefsWithSources.mockResolvedValue({
      logs: [],
      reflections: [],
    });
    sourceRefs.bulkCreate.mockResolvedValue([]);
    clRepo.findOne.mockResolvedValue(makeClWithApp());
    clRepo.save.mockImplementation(async (d) => d as ApplicationCoverletter);
    logCallRepo.count.mockResolvedValue(0); // quota OK
    activityLogRepo.find.mockResolvedValue([]);
    myinfo.getSafeDumpForAi.mockResolvedValue(EMPTY_MYINFO_DUMP);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiCoverletterDraftService,
        {
          provide: getRepositoryToken(ApplicationCoverletter),
          useValue: clRepo,
        },
        {
          provide: getRepositoryToken(CoverletterSourceRef),
          useValue: refRepo,
        },
        { provide: getRepositoryToken(LlmCallLog), useValue: logCallRepo },
        {
          provide: getRepositoryToken(ActivityLog),
          useValue: activityLogRepo,
        },
        {
          provide: getRepositoryToken(ActivityReflection),
          useValue: reflectionRepo,
        },
        { provide: CoverletterSourceRefsService, useValue: sourceRefs },
        { provide: LlmService, useValue: llm },
        { provide: MyinfoService, useValue: myinfo },
      ],
    }).compile();
    service = module.get<AiCoverletterDraftService>(AiCoverletterDraftService);
  });

  // ── 1. 정상 흐름 ──

  it('정상: draft 만 (recommend candidates 0) → answer 저장 + meta 반환', async () => {
    llm.call.mockResolvedValue({
      status: 'ok',
      text: '생성된 자소서 답변',
      json: undefined,
      promptTokens: 500,
      completionTokens: 300,
      costUsd: 0.01,
      latencyMs: 1000,
      callLogId: 'log-draft',
      outputRedacted: false,
    });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.answer).toBe('생성된 자소서 답변');
    expect(clRepo.save).toHaveBeenCalled();
    expect(result.meta?.draftCallLogId).toBe('log-draft');
  });

  it('정상: AI 추천 1개 + draft → recommended ref aiRecommended=true 로 bulk insert', async () => {
    activityLogRepo.find.mockResolvedValue([makeLog('log-A')]);
    llm.call
      .mockResolvedValueOnce({
        // recommend
        status: 'ok',
        text: '',
        json: { recommendedLogIds: ['log-A'], reason: '적합' },
        promptTokens: 100,
        completionTokens: 30,
        costUsd: 0.001,
        latencyMs: 500,
        callLogId: 'log-rec',
        outputRedacted: false,
      })
      .mockResolvedValueOnce({
        // draft
        status: 'ok',
        text: '답변',
        json: undefined,
        promptTokens: 600,
        completionTokens: 200,
        costUsd: 0.02,
        latencyMs: 1500,
        callLogId: 'log-draft',
        outputRedacted: false,
      });
    sourceRefs.bulkCreate.mockResolvedValue([
      { id: 'ref-new' } as CoverletterSourceRef,
    ]);

    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('ok');
    expect(sourceRefs.bulkCreate).toHaveBeenCalledWith(
      CL_ID,
      expect.arrayContaining([
        expect.objectContaining({ sourceLogId: 'log-A', aiRecommended: true }),
      ]),
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.meta?.recommendCallLogId).toBe('log-rec');
    expect(result.meta?.createdRefIds).toEqual(['ref-new']);
  });

  // ── 2. 검증 실패 ──

  it('cl 다른 user → NotFoundException 전파', async () => {
    sourceRefs.assertOwnsCoverletter.mockRejectedValue(new NotFoundException());
    await expect(service.generate(USER_ID, CL_ID, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('cl.question 비어있음 → BadRequestException', async () => {
    sourceRefs.assertOwnsCoverletter.mockResolvedValue(
      makeCl({ question: '' }),
    );
    await expect(service.generate(USER_ID, CL_ID, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('application 없음 (관계 로드 실패) → NotFoundException', async () => {
    clRepo.findOne.mockResolvedValue({
      ...makeCl(),
      application: undefined as unknown as Application,
    });
    await expect(service.generate(USER_ID, CL_ID, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('selected refs IDOR fail → Forbidden 전파', async () => {
    sourceRefs.assertSelectedRefsBelongToUser.mockRejectedValue(
      new ForbiddenException(),
    );
    await expect(
      service.generate(USER_ID, CL_ID, {
        selectedSourceRefIds: ['ref-other'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── 3. quota ──

  it('draft 일 한도 도달 → blocked + "오늘" reason + LlmService.call(blocked_quota) 로 audit row 일관성 보장', async () => {
    logCallRepo.count.mockResolvedValueOnce(
      COVERLETTER_AI_LIMITS.DRAFT_PER_DAY,
    );
    llm.call.mockResolvedValue({
      status: 'blocked_quota',
      text: null,
      errorMessage: '오늘',
      callLogId: 'log-blocked',
    });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('오늘');
    // preBlockedStatus 로 LlmService 호출 (audit row 일관성 — NoteSummary 패턴)
    expect(llm.call).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'coverletter_draft_v2',
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: expect.stringContaining('오늘'),
      }),
    );
  });

  it('draft 월 한도 도달 → blocked + "이번 달" reason + audit row', async () => {
    // 일 = 0, 월 = 한도
    logCallRepo.count
      .mockResolvedValueOnce(0) // draft day
      .mockResolvedValueOnce(COVERLETTER_AI_LIMITS.DRAFT_PER_MONTH); // draft month
    llm.call.mockResolvedValue({
      status: 'blocked_quota',
      text: null,
      errorMessage: '이번 달',
      callLogId: 'log-blocked',
    });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('이번 달');
    expect(llm.call).toHaveBeenCalledWith(
      expect.objectContaining({ preBlockedStatus: 'blocked_quota' }),
    );
  });

  it('recommend 한도 도달 — recommend 만 skip, draft 진행 (사용자 가치 보존)', async () => {
    // draft quota OK (4 calls: draft day/month + recommend day/month)
    logCallRepo.count
      .mockResolvedValueOnce(0) // draft day
      .mockResolvedValueOnce(0) // draft month
      .mockResolvedValueOnce(COVERLETTER_AI_LIMITS.RECOMMEND_PER_DAY) // recommend day FULL
      .mockResolvedValueOnce(0); // recommend month (unused)
    activityLogRepo.find.mockResolvedValue([makeLog('log-A')]);
    llm.call.mockResolvedValueOnce({
      // draft only
      status: 'ok',
      text: '답변',
      json: undefined,
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      latencyMs: 1,
      callLogId: 'log-draft',
      outputRedacted: false,
    });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('ok');
    expect(llm.call).toHaveBeenCalledTimes(1);
    expect(llm.call).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'coverletter_draft_v2' }),
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.meta?.recommendCallLogId).toBeNull();
  });

  it('skipRecommend=true → recommend LLM 미호출 (quota 안 씀)', async () => {
    activityLogRepo.find.mockResolvedValue([makeLog('log-A')]);
    llm.call.mockResolvedValueOnce({
      status: 'ok',
      text: '답변',
      json: undefined,
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      latencyMs: 1,
      callLogId: 'log-draft',
      outputRedacted: false,
    });
    await service.generate(USER_ID, CL_ID, { skipRecommend: true });
    expect(llm.call).toHaveBeenCalledTimes(1);
    expect(llm.call).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'coverletter_draft_v2' }),
    );
    // recommend quota count 호출되지 않음 (draft day+month 2개만)
    expect(logCallRepo.count).toHaveBeenCalledTimes(2);
  });

  // ── 4. AI 추천 hallucination 방어 ──

  it('recommend 가 candidates 에 없는 가짜 id 반환 → filter 후 빈 추천 fallback', async () => {
    activityLogRepo.find.mockResolvedValue([makeLog('log-real')]);
    llm.call
      .mockResolvedValueOnce({
        status: 'ok',
        text: '',
        json: { recommendedLogIds: ['FAKE-ID-NOT-IN-LIST'], reason: 'h' },
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        callLogId: 'log-rec',
        outputRedacted: false,
      })
      .mockResolvedValueOnce({
        status: 'ok',
        text: '답변',
        json: undefined,
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        callLogId: 'log-draft',
        outputRedacted: false,
      });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('ok');
    // 가짜 id → bulk insert 호출되지만 ref 0건
    expect(sourceRefs.bulkCreate).toHaveBeenCalledWith(CL_ID, []);
  });

  it('recommend LLM error → 빈 추천 fallback + draft 계속 진행', async () => {
    activityLogRepo.find.mockResolvedValue([makeLog('log-A')]);
    llm.call
      .mockResolvedValueOnce({
        status: 'error',
        text: null,
        errorMessage: 'rate limit',
        callLogId: 'log-rec-err',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        text: '답변',
        json: undefined,
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        callLogId: 'log-draft',
        outputRedacted: false,
      });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('ok');
    expect(sourceRefs.bulkCreate).toHaveBeenCalledWith(CL_ID, []);
  });

  it('candidates 풀 비어있음 (사용자 활동 로그 0) → recommend 호출 0', async () => {
    activityLogRepo.find.mockResolvedValue([]);
    llm.call.mockResolvedValue({
      status: 'ok',
      text: '답변',
      json: undefined,
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      latencyMs: 1,
      callLogId: 'log-draft',
      outputRedacted: false,
    });
    await service.generate(USER_ID, CL_ID, {});
    expect(llm.call).toHaveBeenCalledTimes(1);
    expect(llm.call).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'coverletter_draft_v2' }),
    );
  });

  // ── 5. draft blocked 매핑 ──

  it('draft blocked_consent → reason "AI 사용 동의" + ref 저장 안 함', async () => {
    llm.call.mockResolvedValue({
      status: 'blocked_consent',
      text: null,
      errorMessage: 'AI 사용 동의가 필요합니다.',
      callLogId: 'log-x',
    });
    const result = await service.generate(USER_ID, CL_ID, {
      skipRecommend: true,
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('동의');
    expect(clRepo.save).not.toHaveBeenCalled();
    expect(sourceRefs.bulkCreate).not.toHaveBeenCalled();
  });

  it('draft blocked_input_cap → reason "입력이 너무 길어요"', async () => {
    llm.call.mockResolvedValue({
      status: 'blocked_input_cap',
      text: null,
      errorMessage: '입력 토큰 초과',
      callLogId: 'log-x',
    });
    const result = await service.generate(USER_ID, CL_ID, {
      skipRecommend: true,
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('입력이 너무 길어요');
  });

  it('draft blocked_moderation → reason "부적절한 표현"', async () => {
    llm.call.mockResolvedValue({
      status: 'blocked_moderation',
      text: null,
      errorMessage: 'flagged',
      callLogId: 'log-x',
    });
    const result = await service.generate(USER_ID, CL_ID, {
      skipRecommend: true,
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('부적절');
  });

  it('draft generic error → reason "잠시 후 다시 시도"', async () => {
    llm.call.mockResolvedValue({
      status: 'error',
      text: null,
      errorMessage: 'unknown',
      callLogId: 'log-x',
    });
    const result = await service.generate(USER_ID, CL_ID, {
      skipRecommend: true,
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('잠시 후');
  });

  // ── 6. 사용자 입력 격리 (PR 0 의 LlmService.call 가 PII·consent gate 자동 적용 — 여기선 LlmService 호출만 검증) ──

  it('LlmService.call 호출 시 resourceType/resourceId 정확히 전달 (audit 추적)', async () => {
    llm.call.mockResolvedValue({
      status: 'ok',
      text: '답변',
      json: undefined,
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      latencyMs: 1,
      callLogId: 'log-draft',
      outputRedacted: false,
    });
    await service.generate(USER_ID, CL_ID, { skipRecommend: true });
    expect(llm.call).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        feature: 'coverletter_draft_v2',
        resourceType: 'application_coverletter',
        resourceId: CL_ID,
      }),
    );
  });
});
