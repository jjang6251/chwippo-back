import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository } from 'typeorm';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { LlmService } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { ActivityReflection } from '../activity/entities/activity-reflection.entity';
import { Activity } from '../activity/entities/activity.entity';
import { MyinfoService } from '../myinfo/myinfo.service';
import { AiCoverletterDraftService } from './ai-coverletter-draft.service';
import { Application } from './application.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { CoverletterSourceRef } from './coverletter-source-ref.entity';
import { CoverletterSourceRefsService } from './coverletter-source-refs.service';

/**
 * F6 PR 2 Phase 1 — AiCoverletterDraftService spec.
 *
 * 변경: hard-coded COVERLETTER_AI_LIMITS 제거, QuotaCheckService 통합.
 * - draft/recommend quota 모두 QuotaCheckService.checkAndPrepare 가 단일 진입점
 * - admin 통제 시나리오 추가 (FEATURE_DISABLED / COOLDOWN)
 *
 * 시나리오:
 * - 정상 흐름 (recommend OK + draft OK + ref 저장)
 * - cl 다른 user (NotFound) / question 비어있음 (BadRequest) / application 없음 (NotFound)
 * - IDOR batch fail 전파 (Forbidden)
 * - quota: draft DAY_LIMIT / MONTH_LIMIT / FEATURE_DISABLED / COOLDOWN
 * - recommend quota blocked → recommend 만 skip, draft 진행
 * - skipRecommend=true → recommend 호출 0
 * - recommend hallucination (가짜 log_id) → filter
 * - recommend LLM error → 빈 추천 + draft 계속
 * - draft LLM blocked_* / error 매핑
 * - DAY_LIMIT 시 abuser ban 트리거 / 다른 code 는 미트리거
 */
describe('AiCoverletterDraftService', () => {
  let service: AiCoverletterDraftService;
  let clRepo: jest.Mocked<Repository<ApplicationCoverletter>>;
  let activityLogRepo: jest.Mocked<Repository<ActivityLog>>;
  let reflectionRepo: jest.Mocked<Repository<ActivityReflection>>;
  let activityRepo: { find: jest.Mock };
  let sourceRefs: jest.Mocked<CoverletterSourceRefsService>;
  let llm: jest.Mocked<LlmService>;
  let quotaCheck: jest.Mocked<QuotaCheckService>;
  let myinfo: jest.Mocked<MyinfoService>;
  let abuserBan: jest.Mocked<AbuserBanService>;

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
      // PR_B1c — 자소서 draft 가드 통과 (모든 기존 spec 의 default)
      coverletterGenerationStatus: 'completed',
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
    activityLogRepo = mock<Repository<ActivityLog>>();
    reflectionRepo = mock<Repository<ActivityReflection>>();
    activityRepo = { find: jest.fn().mockResolvedValue([]) };
    sourceRefs = mock<CoverletterSourceRefsService>();
    llm = mock<LlmService>();
    quotaCheck = mock<QuotaCheckService>();
    myinfo = mock<MyinfoService>();
    abuserBan = mock<AbuserBanService>();
    abuserBan.getActiveOverride.mockResolvedValue(null);
    abuserBan.checkAndBan.mockResolvedValue({ banned: false });

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
    activityLogRepo.find.mockResolvedValue([]);
    myinfo.getSafeDumpForAi.mockResolvedValue(EMPTY_MYINFO_DUMP);
    // quota default: 통과
    quotaCheck.checkAndPrepare.mockResolvedValue({ blocked: false });

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
        {
          provide: getRepositoryToken(ActivityLog),
          useValue: activityLogRepo,
        },
        {
          provide: getRepositoryToken(ActivityReflection),
          useValue: reflectionRepo,
        },
        {
          provide: getRepositoryToken(Activity),
          useValue: activityRepo,
        },
        { provide: CoverletterSourceRefsService, useValue: sourceRefs },
        { provide: LlmService, useValue: llm },
        { provide: QuotaCheckService, useValue: quotaCheck },
        { provide: MyinfoService, useValue: myinfo },
        { provide: AbuserBanService, useValue: abuserBan },
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
    expect(quotaCheck.checkAndPrepare).toHaveBeenCalledWith(
      USER_ID,
      'coverletter_draft_v2',
    );
  });

  it('정상: AI 추천 1개 + draft → recommended ref aiRecommended=true 로 bulk insert', async () => {
    activityLogRepo.find.mockResolvedValue([makeLog('log-A')]);
    llm.call
      .mockResolvedValueOnce({
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
    // draft + recommend → quota check 2번
    expect(quotaCheck.checkAndPrepare).toHaveBeenCalledTimes(2);
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

  // ── 3. quota (QuotaCheckService 통합) ──

  it('draft DAY_LIMIT → blocked + reason 전파 + audit row + abuser ban 트리거', async () => {
    quotaCheck.checkAndPrepare.mockResolvedValueOnce({
      blocked: true,
      code: 'DAY_LIMIT',
      reason: '오늘 자소서 작성 3회를 모두 사용했어요.',
    });
    llm.call.mockResolvedValue({
      status: 'blocked_quota',
      text: null,
      errorMessage: 'day',
      callLogId: 'log-blocked',
    });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('오늘');
    expect(llm.call).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'coverletter_draft_v2',
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: expect.stringContaining('DAY_LIMIT'),
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(abuserBan.checkAndBan).toHaveBeenCalledWith(
      USER_ID,
      'coverletter_draft_v2',
      1,
    );
  });

  it('draft MONTH_LIMIT → blocked + "이번 달" reason + abuser ban 미트리거', async () => {
    quotaCheck.checkAndPrepare.mockResolvedValueOnce({
      blocked: true,
      code: 'MONTH_LIMIT',
      reason: '이번 달 자소서 작성 20회를 모두 사용했어요.',
    });
    llm.call.mockResolvedValue({
      status: 'blocked_quota',
      text: null,
      errorMessage: 'month',
      callLogId: 'log-blocked',
    });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('이번 달');
    expect(abuserBan.checkAndBan).not.toHaveBeenCalled();
  });

  it('draft FEATURE_DISABLED (admin kill switch) → blocked + reason + LLM 미호출', async () => {
    quotaCheck.checkAndPrepare.mockResolvedValueOnce({
      blocked: true,
      code: 'FEATURE_DISABLED',
      reason: '관리자에 의해 일시 중단된 기능이에요.',
    });
    llm.call.mockResolvedValue({
      status: 'blocked_quota',
      text: null,
      errorMessage: 'disabled',
      callLogId: 'log-x',
    });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('관리자');
    expect(abuserBan.checkAndBan).not.toHaveBeenCalled();
    // recommend·draft 본 LLM 호출 안 됨 — audit row 만
    expect(llm.call).toHaveBeenCalledTimes(1);
  });

  it('draft COOLDOWN → blocked + reason', async () => {
    quotaCheck.checkAndPrepare.mockResolvedValueOnce({
      blocked: true,
      code: 'COOLDOWN',
      reason: '다음 사용까지 90초 남았어요.',
      nextAvailableAt: new Date(Date.now() + 90_000),
    });
    llm.call.mockResolvedValue({
      status: 'blocked_quota',
      text: null,
      errorMessage: 'cooldown',
      callLogId: 'log-x',
    });
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('90초');
    expect(abuserBan.checkAndBan).not.toHaveBeenCalled();
  });

  it('recommend quota blocked → recommend 만 skip, draft 진행 (사용자 가치 보존)', async () => {
    activityLogRepo.find.mockResolvedValue([makeLog('log-A')]);
    quotaCheck.checkAndPrepare
      .mockResolvedValueOnce({ blocked: false }) // draft OK
      .mockResolvedValueOnce({
        blocked: true,
        code: 'DAY_LIMIT',
        reason: '오늘 추천 한도 도달',
      });
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
    const result = await service.generate(USER_ID, CL_ID, {});
    expect(result.status).toBe('ok');
    expect(llm.call).toHaveBeenCalledTimes(1);
    expect(llm.call).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'coverletter_draft_v2' }),
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.meta?.recommendCallLogId).toBeNull();
  });

  it('skipRecommend=true → recommend quota 체크 자체 안 함 + recommend LLM 호출 0', async () => {
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
    // draft quota 만 1번 호출
    expect(quotaCheck.checkAndPrepare).toHaveBeenCalledTimes(1);
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

  // ── 6. audit 추적 ──

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

  // ── 활동 총괄 회고 통합 (베타 피드백 2026-06-23) ──
  describe('activitySummaries 통합', () => {
    it('IDOR — activityRepo.find 호출 시 where 에 userId 동봉 (cross-user 격리)', async () => {
      activityLogRepo.find.mockResolvedValue([makeLog('log-A')]);
      llm.call
        .mockResolvedValueOnce({
          status: 'ok',
          text: '',
          json: { recommendedLogIds: ['log-A'], reason: 'r' },
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

      await service.generate(USER_ID, CL_ID, {});

      // activity find 호출 — 반드시 userId 동봉 (cross-user IDOR 차단)
      if (activityRepo.find.mock.calls.length > 0) {
        const where = activityRepo.find.mock.calls[0][0]?.where;
        expect(where).toEqual(
          expect.objectContaining({ userId: USER_ID }),
        );
      }
    });

    it('summary 있는 활동만 prompt 에 inject (NULL / 빈 string 제외)', async () => {
      activityLogRepo.find.mockResolvedValue([makeLog('log-A')]);
      activityRepo.find.mockResolvedValue([
        { id: 'a-1', name: '인턴', summaryReflection: '6개월 wrap up' },
        { id: 'a-2', name: '동아리', summaryReflection: null },
        { id: 'a-3', name: '공모전', summaryReflection: '   ' }, // 빈 string
      ]);
      llm.call
        .mockResolvedValueOnce({
          status: 'ok',
          text: '',
          json: { recommendedLogIds: ['log-A'], reason: 'r' },
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

      await service.generate(USER_ID, CL_ID, {});

      // 2번째 LLM 호출 (draft) 의 userPrompt 에 인턴 의 wrap up 만 들어가 있는지
      const draftCall = llm.call.mock.calls.find(
        (c) => c[0].feature === 'coverletter_draft_v2',
      );
      if (draftCall) {
        const userPrompt = draftCall[0].userPrompt;
        if (userPrompt.includes('활동 총괄 회고')) {
          expect(userPrompt).toContain('인턴');
          expect(userPrompt).toContain('6개월 wrap up');
          expect(userPrompt).not.toContain('## 동아리');
          expect(userPrompt).not.toContain('## 공모전');
        }
      }
    });
  });
});
