import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { LlmService } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { CompanyResearchService } from '../interview-prep/company-research.service';
import { AiCoverletterFeedbackService } from './ai-coverletter-feedback.service';
import { CoverletterSourceRefsService } from './coverletter-source-refs.service';
import { ApplicationCoverletter } from './application-coverletter.entity';

/**
 * A1 Phase 2 — AI 제출 전 점검 spec.
 *
 * 시나리오 매트릭스:
 * - 정상: schema json 반환 + 프롬프트에 답변·문항 포함 + system 은 코드 상수(사용자 입력 미포함)
 * - 게이트: 답변 null / 100자 미만 → BadRequest (호출·차감 없음)
 * - IDOR: assertOwnsCoverletter reject 전파
 * - quota blocked → preBlockedStatus 로 audit 만 + status 'blocked' + 실호출 인자 없음
 *                  DAY_LIMIT 이면 abuserBan 평가
 * - 회사조사 캐시: 있으면 프롬프트 포함 (조회 전용) / 없으면 미포함
 * - llm error → status 'error' + reason
 */
describe('AiCoverletterFeedbackService', () => {
  let service: AiCoverletterFeedbackService;
  let sourceRefs: jest.Mocked<CoverletterSourceRefsService>;
  let llm: jest.Mocked<LlmService>;
  let quotaCheck: jest.Mocked<QuotaCheckService>;
  let abuserBan: jest.Mocked<AbuserBanService>;
  let research: { getCachedForApplication: jest.Mock };

  const USER_ID = 'user-1';
  const CL_ID = 'cl-1';
  const LONG_ANSWER = '가'.repeat(300);

  const makeCl = (
    over: Partial<ApplicationCoverletter> = {},
  ): ApplicationCoverletter =>
    ({
      id: CL_ID,
      applicationId: 'app-1',
      question: '지원 동기를 작성하세요',
      category: '지원동기',
      answer: LONG_ANSWER,
      answerOrigin: 'manual',
      charLimit: 1000,
      orderIndex: 0,
      application: { id: 'app-1', companyName: '카카오' },
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as unknown as ApplicationCoverletter;

  const OK_FEEDBACK = {
    strengths: ['정량 근거가 좋아요'],
    issues: [
      { kind: 'ai_tone', quote: '끊임없는 열정', advice: '구체 동사로' },
    ],
    suggestions: [],
    summary: '도입부만 다듬으면 좋겠어요',
  };

  beforeEach(async () => {
    sourceRefs = mock<CoverletterSourceRefsService>();
    sourceRefs.assertOwnsCoverletter.mockResolvedValue(makeCl());
    llm = mock<LlmService>();
    llm.call.mockResolvedValue({
      status: 'ok',
      text: '',
      json: OK_FEEDBACK,
      promptTokens: 400,
      completionTokens: 200,
      coinCost: 3,
      costUsd: 0.002,
      latencyMs: 800,
      callLogId: 'log-fb',
      outputRedacted: false,
    } as never);
    quotaCheck = mock<QuotaCheckService>();
    quotaCheck.checkAndPrepare.mockResolvedValue({ blocked: false } as never);
    abuserBan = mock<AbuserBanService>();
    research = { getCachedForApplication: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiCoverletterFeedbackService,
        { provide: CoverletterSourceRefsService, useValue: sourceRefs },
        { provide: LlmService, useValue: llm },
        { provide: QuotaCheckService, useValue: quotaCheck },
        { provide: AbuserBanService, useValue: abuserBan },
        { provide: CompanyResearchService, useValue: research },
      ],
    }).compile();
    service = module.get(AiCoverletterFeedbackService);
  });

  it('정상 — feedback json 반환 + 프롬프트에 답변·문항 포함, system 은 상수만', async () => {
    const r = await service.review(USER_ID, CL_ID);

    expect(r.status).toBe('ok');
    expect(r.feedback).toEqual(OK_FEEDBACK);
    expect(r.meta?.callLogId).toBe('log-fb');

    const call = llm.call.mock.calls[0][0];
    expect(call.feature).toBe('coverletter_feedback');
    expect(call.userPrompt).toContain('지원 동기를 작성하세요');
    expect(call.userPrompt).toContain(LONG_ANSWER);
    expect(call.userPrompt).toContain('1000자');
    // prompt injection 1차 방어 — 사용자 입력이 system 으로 새지 않음
    expect(call.systemPrompt).not.toContain(LONG_ANSWER);
    expect(call.jsonSchema).toBeDefined();
  });

  it('답변 없음·100자 미만 → BadRequest (호출·차감 없음)', async () => {
    sourceRefs.assertOwnsCoverletter.mockResolvedValue(
      makeCl({ answer: null }),
    );
    await expect(service.review(USER_ID, CL_ID)).rejects.toThrow(
      BadRequestException,
    );

    sourceRefs.assertOwnsCoverletter.mockResolvedValue(
      makeCl({ answer: '짧은 답' }),
    );
    await expect(service.review(USER_ID, CL_ID)).rejects.toThrow(
      BadRequestException,
    );
    expect(llm.call).not.toHaveBeenCalled();
  });

  it('IDOR — 소유 검증 실패 전파', async () => {
    sourceRefs.assertOwnsCoverletter.mockRejectedValue(new NotFoundException());
    await expect(service.review(USER_ID, CL_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(llm.call).not.toHaveBeenCalled();
  });

  it('quota blocked → preBlockedStatus audit 만 + blocked 반환, DAY_LIMIT 이면 abuserBan 평가', async () => {
    quotaCheck.checkAndPrepare.mockResolvedValue({
      blocked: true,
      code: 'DAY_LIMIT',
      reason: '오늘 한도 소진',
    } as never);
    abuserBan.checkAndBan.mockResolvedValue({ banned: false });

    const r = await service.review(USER_ID, CL_ID);

    expect(r.status).toBe('blocked');
    expect(llm.call).toHaveBeenCalledTimes(1);
    expect(llm.call.mock.calls[0][0].preBlockedStatus).toBe('blocked_quota');
    expect(abuserBan.checkAndBan).toHaveBeenCalledWith(
      USER_ID,
      'coverletter_feedback',
      1,
    );
  });

  it('회사조사 캐시 있으면 프롬프트 포함 (조회 전용 메서드만)', async () => {
    research.getCachedForApplication.mockResolvedValue({
      status: 'ok',
      research: { businessSummary: '커머스·광고 플랫폼' },
    });

    await service.review(USER_ID, CL_ID);

    const call = llm.call.mock.calls[0][0];
    expect(call.userPrompt).toContain('커머스·광고 플랫폼');
    expect(research.getCachedForApplication).toHaveBeenCalledWith(
      USER_ID,
      'app-1',
    );
  });

  it('글자수 초과 시 서버가 결정적으로 over_limit 지적 강제 지시 주입', async () => {
    // charLimit 200 · 답변 300자 → 100자 초과
    sourceRefs.assertOwnsCoverletter.mockResolvedValue(
      makeCl({ answer: '가'.repeat(300), charLimit: 200 }),
    );
    await service.review(USER_ID, CL_ID);
    const call = llm.call.mock.calls[0][0];
    expect(call.userPrompt).toContain('100자 초과');
    expect(call.userPrompt).toContain('over_limit');
  });

  it('글자수 제한 내면 초과 지시 미주입', async () => {
    sourceRefs.assertOwnsCoverletter.mockResolvedValue(
      makeCl({ answer: '가'.repeat(300), charLimit: 1000 }),
    );
    await service.review(USER_ID, CL_ID);
    const call = llm.call.mock.calls[0][0];
    expect(call.userPrompt).not.toContain('초과했다');
  });

  it('llm error → status error + reason (throw 안 함)', async () => {
    llm.call.mockResolvedValue({
      status: 'error',
      text: null,
      errorMessage: 'provider down',
      callLogId: 'log-e',
    } as never);

    const r = await service.review(USER_ID, CL_ID);
    expect(r.status).toBe('error');
    expect(r.reason).toBe('provider down');
  });
});
