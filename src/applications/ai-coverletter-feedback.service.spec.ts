import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { LlmService, PROVIDER_OUTAGE_USER_MESSAGE } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { CompanyResearchService } from '../interview-prep/company-research.service';
import { AiCoverletterFeedbackService } from './ai-coverletter-feedback.service';
import { CoverletterSourceRefsService } from './coverletter-source-refs.service';
import { Application } from './application.entity';
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
  let appRepo: { findOne: jest.Mock };
  let clRepo: { update: jest.Mock };

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
    appRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'app-1', companyName: '카카오' }),
    };
    clRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiCoverletterFeedbackService,
        { provide: CoverletterSourceRefsService, useValue: sourceRefs },
        { provide: LlmService, useValue: llm },
        { provide: QuotaCheckService, useValue: quotaCheck },
        { provide: AbuserBanService, useValue: abuserBan },
        { provide: CompanyResearchService, useValue: research },
        { provide: getRepositoryToken(Application), useValue: appRepo },
        {
          provide: getRepositoryToken(ApplicationCoverletter),
          useValue: clRepo,
        },
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
    // 회사명은 appRepo 조회로 주입 (assertOwns 반환 cl 엔 application 관계 없음)
    expect(call.userPrompt).toContain('카카오');
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

  it('회사조사 talentProfile·coreValues 있으면 인재상·핵심 가치 블록 포함', async () => {
    research.getCachedForApplication.mockResolvedValue({
      status: 'ok',
      research: {
        businessSummary: '커머스',
        talentProfile: ['도전정신', '협업'],
        coreValues: '고객 최우선주의',
      },
    });

    await service.review(USER_ID, CL_ID);

    const call = llm.call.mock.calls[0][0];
    expect(call.userPrompt).toContain('# 인재상');
    expect(call.userPrompt).toContain('도전정신');
    expect(call.userPrompt).toContain('협업');
    expect(call.userPrompt).toContain('# 핵심 가치');
    expect(call.userPrompt).toContain('고객 최우선주의');
  });

  it('talentProfile 이 문자열 배열이 아니면(객체 배열) 인재상 블록 미포함 (에러 없이)', async () => {
    research.getCachedForApplication.mockResolvedValue({
      status: 'ok',
      research: {
        businessSummary: '커머스',
        talentProfile: [{ label: '도전' }],
      },
    });

    const r = await service.review(USER_ID, CL_ID);

    expect(r.status).toBe('ok');
    const call = llm.call.mock.calls[0][0];
    expect(call.userPrompt).not.toContain('# 인재상');
    expect(call.userPrompt).not.toContain('# 핵심 가치');
  });

  it('분량 미달(제한 60% 미만) → 보강 힌트 주입', async () => {
    // charLimit 500 · 답변 200자 (40%) → 60% 미만
    sourceRefs.assertOwnsCoverletter.mockResolvedValue(
      makeCl({ answer: '가'.repeat(200), charLimit: 500 }),
    );
    await service.review(USER_ID, CL_ID);
    const call = llm.call.mock.calls[0][0];
    expect(call.userPrompt).toContain('분량이 제한의 40%');
  });

  it('분량 60% 이상 → 보강 힌트 미주입', async () => {
    // charLimit 500 · 답변 450자 (90%) → 60% 이상, 초과도 아님
    sourceRefs.assertOwnsCoverletter.mockResolvedValue(
      makeCl({ answer: '가'.repeat(450), charLimit: 500 }),
    );
    await service.review(USER_ID, CL_ID);
    const call = llm.call.mock.calls[0][0];
    expect(call.userPrompt).not.toContain('분량이 제한의');
  });

  it('llm error(internal) → status error + reason (throw 안 함)', async () => {
    llm.call.mockResolvedValue({
      status: 'error',
      text: null,
      errorMessage: 'provider down',
      errorKind: 'internal',
      callLogId: 'log-e',
    } as never);

    const r = await service.review(USER_ID, CL_ID);
    expect(r.status).toBe('error');
    expect(r.reason).toBe('provider down');
  });

  it('⑧ llm error(provider_outage) → 503 ServiceUnavailable + 장애 문구', async () => {
    llm.call.mockResolvedValue({
      status: 'error',
      text: null,
      errorMessage: '500 upstream',
      errorKind: 'provider_outage',
      callLogId: 'log-e',
    } as never);

    await expect(service.review(USER_ID, CL_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.review(USER_ID, CL_ID)).rejects.toThrow(
      PROVIDER_OUTAGE_USER_MESSAGE,
    );
  });

  // ── 추가 후보 (웨이브) — blocked 문구 분화 ──
  describe('blocked 문구 분화', () => {
    it('blocked_quota (코인 부족) → "치뽀 코인이 부족해요"', async () => {
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: '코인이 부족해요',
        callLogId: 'log-q',
      });
      const r = await service.review(USER_ID, CL_ID);
      expect(r.status).toBe('error');
      expect(r.reason).toContain('치뽀 코인이 부족해요');
    });

    it('blocked_quota + code ALREADY_RUNNING → "이미 점검이 진행 중"', async () => {
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: '이미 처리 중이에요. 잠시만 기다려 주세요.',
        callLogId: 'log-r',
        code: 'ALREADY_RUNNING',
      });
      const r = await service.review(USER_ID, CL_ID);
      expect(r.reason).toContain('이미 점검이 진행 중');
    });

    it('blocked_consent → "AI 이용 동의가 필요해요"', async () => {
      llm.call.mockResolvedValue({
        status: 'blocked_consent',
        text: null,
        errorMessage: '동의 필요',
        callLogId: 'log-c',
      });
      const r = await service.review(USER_ID, CL_ID);
      expect(r.reason).toContain('AI 이용 동의가 필요해요');
    });

    it('blocked_input_cap → "내용이 너무 길어요"', async () => {
      llm.call.mockResolvedValue({
        status: 'blocked_input_cap',
        text: null,
        errorMessage: '입력 초과',
        callLogId: 'log-i',
      });
      const r = await service.review(USER_ID, CL_ID);
      expect(r.reason).toContain('내용이 너무 길어요');
    });

    it('blocked_moderation → 기존 범용 문구 유지', async () => {
      llm.call.mockResolvedValue({
        status: 'blocked_moderation',
        text: null,
        errorMessage: 'flagged',
        callLogId: 'log-m',
      });
      const r = await service.review(USER_ID, CL_ID);
      expect(r.reason).toContain('점검이 차단됐어요');
    });

    it('blocked_cost_quota (비용 가드) → 기존 범용 문구 유지', async () => {
      llm.call.mockResolvedValue({
        status: 'blocked_cost_quota',
        text: null,
        errorMessage: '비용 한도',
        callLogId: 'log-cc',
      });
      const r = await service.review(USER_ID, CL_ID);
      expect(r.reason).toContain('점검이 차단됐어요');
    });
  });

  it('성공 시 결과 영속화 — clRepo.update(feedback + lastFeedbackAt) 호출', async () => {
    const r = await service.review(USER_ID, CL_ID);

    expect(r.status).toBe('ok');
    expect(clRepo.update).toHaveBeenCalledTimes(1);
    const [id, patch] = clRepo.update.mock.calls[0];
    expect(id).toBe(CL_ID);
    expect(patch.lastFeedback).toEqual(OK_FEEDBACK);
    expect(patch.lastFeedbackAt).toBeInstanceOf(Date);
  });

  it('저장 update reject 돼도 status ok + feedback 정상 반환 (유실 방지)', async () => {
    clRepo.update.mockRejectedValue(new Error('db down'));

    const r = await service.review(USER_ID, CL_ID);

    expect(r.status).toBe('ok');
    expect(r.feedback).toEqual(OK_FEEDBACK);
    expect(clRepo.update).toHaveBeenCalledTimes(1);
  });

  it('quota blocked 시 결과 저장 안 함 (기존 기록 보존)', async () => {
    quotaCheck.checkAndPrepare.mockResolvedValue({
      blocked: true,
      code: 'MONTH_LIMIT',
      reason: '이번 달 한도 소진',
    } as never);

    const r = await service.review(USER_ID, CL_ID);

    expect(r.status).toBe('blocked');
    expect(clRepo.update).not.toHaveBeenCalled();
  });

  it('llm error 시 결과 저장 안 함 (기존 기록 보존)', async () => {
    llm.call.mockResolvedValue({
      status: 'error',
      text: null,
      errorMessage: 'provider down',
      callLogId: 'log-e',
    } as never);

    const r = await service.review(USER_ID, CL_ID);

    expect(r.status).toBe('error');
    expect(clRepo.update).not.toHaveBeenCalled();
  });
});
