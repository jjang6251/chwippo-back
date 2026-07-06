import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { LlmService } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { CompanyResearchService } from '../interview-prep/company-research.service';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { Application } from './application.entity';
import { CoverletterChatService } from './coverletter-chat.service';
import { CoverletterChatMessage } from './coverletter-chat-message.entity';
import { CoverletterSourceRef } from './coverletter-source-ref.entity';
import { Coverletter } from '../myinfo/entities/coverletter.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { Award } from '../myinfo/entities/award.entity';
import { ActivityLog } from '../activity/entities/activity-log.entity';

/**
 * F1 자소서 풀페이지 Phase D — CoverletterChatService spec.
 *
 * 시나리오 매트릭스 (성공·실패·예외·IDOR·PII·race·truncate):
 *  1) listMessages: 다른 user IDOR → NotFound
 *  2) listMessages: 정상 — ASC 정렬
 *  3) listMessages: 0개 → 빈 배열
 *  4) deleteMessages: 다른 user IDOR → NotFound
 *  5) deleteMessages: 정상 → repo.delete 호출
 *  6) chat: 빈 메시지 → BadRequest
 *  7) chat: 5000자 초과 → BadRequest
 *  8) chat: 다른 user IDOR → NotFound
 *  9) chat: 정상 — user/assistant 양쪽 save + LLM 1회 호출
 * 10) chat: 메시지 이력 7+ → 최근 6개만 LLM 컨텍스트
 * 11) chat: quota blocked → LLM provider 미호출 + assistant 차단 메시지
 * 12) chat: LLM error → assistant 에 에러 메시지
 * 13) chat: suggestedUpdates clId 가 다른 application 의 cl → 무시 (IDOR)
 * 14) chat: suggestedUpdates 의 newAnswer 가 빈 문자열 → 무시
 * 15) chat: PII 입력 → 저장 시 스크럽
 * 16) chat: per-app cap 1000 도달 → 가장 오래된 메시지 삭제
 * 17) chat: selectedLogIds — 다른 user/app 의 log 는 무시 (IDOR)
 * 18) cleanupOldMessages: builder 호출 (SQL 검증은 cron spec)
 */
describe('CoverletterChatService', () => {
  let service: CoverletterChatService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let clRepo: jest.Mocked<Repository<ApplicationCoverletter>>;
  let refRepo: jest.Mocked<Repository<CoverletterSourceRef>>;
  let msgRepo: jest.Mocked<Repository<CoverletterChatMessage>>;
  // Phase 2.5 — myinfo 자소서 소재 + 수상 + 활동 log IDOR repo
  let myinfoClRepo: jest.Mocked<Repository<Coverletter>>;
  let myinfoCustomRepo: jest.Mocked<Repository<CoverletterCustom>>;
  let awardRepo: jest.Mocked<Repository<Award>>;
  let activityLogRepo: jest.Mocked<Repository<ActivityLog>>;
  let llm: jest.Mocked<LlmService>;
  let quotaCheck: jest.Mocked<QuotaCheckService>;
  let abuserBan: jest.Mocked<AbuserBanService>;
  let research: jest.Mocked<CompanyResearchService>;

  const APP_ID = 'app-uuid-1';
  const USER_ID = 'user-uuid-1';

  const makeApp = (overrides: Partial<Application> = {}): Application =>
    ({
      id: APP_ID,
      userId: USER_ID,
      companyName: '네이버',
      jobCategory: '백엔드',
      jobTitle: '신입',
      // PR_B1c — 자소서 chat 가드 통과 (모든 기존 spec 의 default)
      coverletterGenerationStatus: 'completed',
      ...overrides,
    }) as Application;

  const makeCl = (
    overrides: Partial<ApplicationCoverletter> = {},
  ): ApplicationCoverletter =>
    ({
      id: 'cl-1',
      applicationId: APP_ID,
      question: '지원동기',
      answer: null,
      category: '지원동기',
      charLimit: 500,
      orderIndex: 0,
      ...overrides,
    }) as ApplicationCoverletter;

  beforeEach(async () => {
    appRepo = mock<Repository<Application>>();
    clRepo = mock<Repository<ApplicationCoverletter>>();
    refRepo = mock<Repository<CoverletterSourceRef>>();
    msgRepo = mock<Repository<CoverletterChatMessage>>();
    myinfoClRepo = mock<Repository<Coverletter>>();
    myinfoCustomRepo = mock<Repository<CoverletterCustom>>();
    awardRepo = mock<Repository<Award>>();
    activityLogRepo = mock<Repository<ActivityLog>>();
    llm = mock<LlmService>();
    quotaCheck = mock<QuotaCheckService>();
    abuserBan = mock<AbuserBanService>();
    research = mock<CompanyResearchService>();
    myinfoClRepo.findOne.mockResolvedValue(null);
    myinfoCustomRepo.find.mockResolvedValue([]);
    awardRepo.find.mockResolvedValue([]);
    activityLogRepo.find.mockResolvedValue([]);

    // default returns
    msgRepo.create.mockImplementation((d) => d as CoverletterChatMessage);
    msgRepo.save.mockImplementation(
      async (d) =>
        ({
          id: 'msg-' + Math.random().toString(36).slice(2, 8),
          createdAt: new Date(),
          ...(d as Partial<CoverletterChatMessage>),
        }) as CoverletterChatMessage,
    );
    msgRepo.count.mockResolvedValue(0);
    msgRepo.find.mockResolvedValue([]);
    msgRepo.delete.mockResolvedValue({ affected: 0, raw: [] });
    appRepo.findOne.mockResolvedValue(makeApp());
    clRepo.find.mockResolvedValue([makeCl()]);
    refRepo.find.mockResolvedValue([]);
    research.getCachedForApplication.mockResolvedValue(null);
    quotaCheck.checkAndPrepare.mockResolvedValue({ blocked: false } as never);
    abuserBan.checkAndBan.mockResolvedValue(undefined as never);
    llm.call.mockResolvedValue({
      status: 'ok',
      text: '',
      json: { reply: 'AI 답변', suggestedUpdates: [] },
      promptTokens: 100,
      completionTokens: 50,
      costUsd: 0.001,
      latencyMs: 1000,
      callLogId: 'log-1',
      outputRedacted: false,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoverletterChatService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        {
          provide: getRepositoryToken(ApplicationCoverletter),
          useValue: clRepo,
        },
        {
          provide: getRepositoryToken(CoverletterSourceRef),
          useValue: refRepo,
        },
        {
          provide: getRepositoryToken(CoverletterChatMessage),
          useValue: msgRepo,
        },
        { provide: getRepositoryToken(Coverletter), useValue: myinfoClRepo },
        {
          provide: getRepositoryToken(CoverletterCustom),
          useValue: myinfoCustomRepo,
        },
        { provide: getRepositoryToken(Award), useValue: awardRepo },
        { provide: getRepositoryToken(ActivityLog), useValue: activityLogRepo },
        { provide: LlmService, useValue: llm },
        { provide: QuotaCheckService, useValue: quotaCheck },
        { provide: AbuserBanService, useValue: abuserBan },
        { provide: CompanyResearchService, useValue: research },
      ],
    }).compile();
    service = module.get(CoverletterChatService);
  });

  // ── listMessages ──
  describe('listMessages', () => {
    it('1) 다른 user IDOR → NotFound', async () => {
      appRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.listMessages(USER_ID, APP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('2) 정상 — ASC 정렬', async () => {
      const msgs = [{ id: 'm1' }, { id: 'm2' }] as CoverletterChatMessage[];
      msgRepo.find.mockResolvedValueOnce(msgs);
      const r = await service.listMessages(USER_ID, APP_ID);
      expect(r).toEqual(msgs);
      expect(msgRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { createdAt: 'ASC' } }),
      );
    });

    it('3) 0개 → 빈 배열', async () => {
      msgRepo.find.mockResolvedValueOnce([]);
      const r = await service.listMessages(USER_ID, APP_ID);
      expect(r).toEqual([]);
    });
  });

  // ── deleteMessages ──
  describe('deleteMessages', () => {
    it('4) 다른 user IDOR → NotFound', async () => {
      appRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.deleteMessages(USER_ID, APP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('5) 정상 → repo.delete 호출', async () => {
      await service.deleteMessages(USER_ID, APP_ID);
      expect(msgRepo.delete).toHaveBeenCalledWith({ applicationId: APP_ID });
    });
  });

  // ── chat ──
  describe('chat', () => {
    it('6) 빈 메시지 → BadRequest', async () => {
      await expect(
        service.chat(USER_ID, APP_ID, { userMessage: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('7) 5000자 초과 → BadRequest', async () => {
      await expect(
        service.chat(USER_ID, APP_ID, { userMessage: 'a'.repeat(5001) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('8) 다른 user IDOR → NotFound', async () => {
      appRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.chat(USER_ID, APP_ID, { userMessage: '안녕' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('A1) 조사 미완(idle) 상태에서도 chat 정상 진행 — 가드 제거 행위 anchor', async () => {
      // 기존 assertGenerationCompleted 는 completed 외 전부 차단했음.
      // 3경로 개편 후: 조사 상태와 무관하게 chat 가능 (조사 없으면 회사 섹션만 빠짐).
      appRepo.findOne.mockResolvedValueOnce(
        makeApp({ coverletterGenerationStatus: 'idle' }),
      );
      const r = await service.chat(USER_ID, APP_ID, { userMessage: '안녕' });
      expect(r.assistantMessage.role).toBe('assistant');
      expect(llm.call).toHaveBeenCalledTimes(1);
    });

    it('9) 정상 — user/assistant 양쪽 save + LLM 1회 호출', async () => {
      const r = await service.chat(USER_ID, APP_ID, { userMessage: '안녕' });
      expect(llm.call).toHaveBeenCalledTimes(1);
      expect(msgRepo.save).toHaveBeenCalledTimes(2); // user + assistant
      expect(r.userMessage.role).toBe('user');
      expect(r.assistantMessage.role).toBe('assistant');
    });

    it('10) 메시지 이력 7+ → 최근 6개만 LLM 컨텍스트', async () => {
      const history = Array.from({ length: 10 }, (_, i) => ({
        id: `m-${i}`,
        role: i % 2 ? 'assistant' : ('user' as const),
        content: `메시지 ${i}`,
        createdAt: new Date(2026, 0, i + 1),
      })) as CoverletterChatMessage[];
      // 첫 호출 = chat 의 history (DESC take 6) — 6개만 반환되도록 모킹
      msgRepo.find.mockImplementation(async (opts?: { take?: number }) => {
        if (opts?.take === 6) return history.slice(-6).reverse();
        return history;
      });
      await service.chat(USER_ID, APP_ID, { userMessage: '검토해줘' });
      const llmArg = llm.call.mock.calls[0][0];
      // userPrompt 안에 최근 6개만 (메시지 0~3 는 없어야)
      expect(llmArg.userPrompt).not.toContain('메시지 0');
      expect(llmArg.userPrompt).not.toContain('메시지 3');
      expect(llmArg.userPrompt).toContain('메시지 9');
    });

    it('11) quota blocked → LLM provider 미호출 + assistant 차단 메시지', async () => {
      quotaCheck.checkAndPrepare.mockResolvedValueOnce({
        blocked: true,
        code: 'DAY_LIMIT',
        reason: '오늘 한도 초과',
      } as never);
      llm.call.mockClear();
      const r = await service.chat(USER_ID, APP_ID, { userMessage: 'a' });
      // pre-blocked audit row 1회 + 실제 LLM 호출은 없음
      const realLlmCalls = llm.call.mock.calls.filter(
        (c) => !c[0].preBlockedStatus,
      );
      expect(realLlmCalls.length).toBe(0);
      expect(r.assistantMessage.content).toContain('한도');
    });

    it('12) LLM error → assistant 에 에러 메시지', async () => {
      llm.call.mockResolvedValueOnce({
        status: 'error',
        text: null,
        errorMessage: 'provider 5xx',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: 100,
        callLogId: 'log-err',
      } as never);
      const r = await service.chat(USER_ID, APP_ID, { userMessage: 'a' });
      // Phase 1 — error 시 ⚠️ prefix + errorMessage 그대로 (사용자에게 명확한 사유)
      expect(r.assistantMessage.content).toMatch(/⚠️/);
      expect(r.assistantMessage.suggestedUpdates).toBeNull();
      expect(r.assistantStatus).toBe('error');
    });

    it('13) suggestedUpdates clId 가 다른 application 의 cl → 무시 (IDOR)', async () => {
      llm.call.mockResolvedValueOnce({
        status: 'ok',
        text: '',
        json: {
          reply: '답변 제안',
          suggestedUpdates: [
            { clId: 'cl-1', newAnswer: '제안 답변' }, // valid (이 app 자식)
            { clId: 'cl-other-app', newAnswer: '나쁜 의도' }, // invalid
          ],
        },
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.001,
        latencyMs: 1000,
        callLogId: 'log-1',
        outputRedacted: false,
      });
      const r = await service.chat(USER_ID, APP_ID, { userMessage: 'a' });
      expect(r.assistantMessage.suggestedUpdates).toHaveLength(1);
      expect(r.assistantMessage.suggestedUpdates?.[0].clId).toBe('cl-1');
    });

    it('14) suggestedUpdates 의 newAnswer 가 빈 문자열 → 무시', async () => {
      llm.call.mockResolvedValueOnce({
        status: 'ok',
        text: '',
        json: {
          reply: '답변 제안',
          suggestedUpdates: [{ clId: 'cl-1', newAnswer: '' }],
        },
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.001,
        latencyMs: 1000,
        callLogId: 'log-1',
        outputRedacted: false,
      });
      const r = await service.chat(USER_ID, APP_ID, { userMessage: 'a' });
      expect(r.assistantMessage.suggestedUpdates).toBeNull();
    });

    it('15) PII 입력 → 저장 시 스크럽 (전화번호 → [REDACTED])', async () => {
      const r = await service.chat(USER_ID, APP_ID, {
        userMessage: '내 번호는 010-1234-5678 이에요',
      });
      expect(r.userMessage.content).not.toContain('010-1234-5678');
    });

    it('16) per-app cap 1000 도달 → 가장 오래된 메시지 자동 삭제', async () => {
      msgRepo.count.mockResolvedValueOnce(1000);
      msgRepo.find.mockImplementation(
        async (opts?: { take?: number; order?: Record<string, string> }) => {
          // enforceCap 의 oldest 조회 (take = 2)
          if (opts?.take === 2 && opts?.order?.createdAt === 'ASC') {
            return [
              { id: 'old-1' },
              { id: 'old-2' },
            ] as CoverletterChatMessage[];
          }
          return [];
        },
      );
      await service.chat(USER_ID, APP_ID, { userMessage: '안녕' });
      expect(msgRepo.delete).toHaveBeenCalledWith({
        id: expect.objectContaining({ _type: 'in' }),
      });
    });

    it('17) selectedLogIds — 다른 user/app 의 log 는 무시 (IDOR)', async () => {
      refRepo.find.mockResolvedValueOnce([]); // 검증 결과 0건 (none belongs)
      await service.chat(USER_ID, APP_ID, {
        userMessage: 'a',
        selectedLogIds: ['log-other-1', 'log-other-2'],
      });
      const llmArg = llm.call.mock.calls[0][0];
      // 선택한 log 가 컨텍스트에 안 들어가야
      expect(llmArg.userPrompt).not.toContain('log-other-1');
    });
  });

  // ── citations (Phase G.1, Notion AI 패턴) ──
  describe('citations', () => {
    it('19) selectedLogIds 보냄 + 본인 user 소유 → user.citations = { selectedLogIds }', async () => {
      // Phase 2.5 — source_refs 검증 폐기, user 소유 ActivityLog 직접 조회로 변경
      activityLogRepo.find.mockResolvedValueOnce([
        { id: 'log-1', content: 'x', occurredAt: '2026-01-01' } as never,
      ]);
      await service.chat(USER_ID, APP_ID, {
        userMessage: 'a',
        selectedLogIds: ['log-1'],
      });
      const userSaveCall = (msgRepo.save as jest.Mock).mock.calls[0][0];
      expect(userSaveCall.citations).toEqual({ selectedLogIds: ['log-1'] });
    });

    it('20) selectedLogIds 안 보냄 → user.citations = null', async () => {
      await service.chat(USER_ID, APP_ID, { userMessage: 'a' });
      const userSaveCall = (msgRepo.save as jest.Mock).mock.calls[0][0];
      expect(userSaveCall.citations).toBeNull();
    });

    it('21) 회사조사 cache 있음 → assistant.citations.citedResearch = true', async () => {
      research.getCachedForApplication.mockResolvedValueOnce({
        status: 'ok',
        research: { businessSummary: 'cached' },
        sources: [],
        isCached: true,
        cachedAt: new Date().toISOString(),
      } as never);
      await service.chat(USER_ID, APP_ID, { userMessage: 'a' });
      const assistantSaveCall = (msgRepo.save as jest.Mock).mock.calls[1][0];
      expect(assistantSaveCall.citations?.citedResearch).toBe(true);
    });

    it('22) selectedLogIds + 회사조사 모두 → assistant.citations 양쪽 포함', async () => {
      activityLogRepo.find.mockResolvedValueOnce([
        { id: 'log-1', content: 'x', occurredAt: '2026-01-01' } as never,
      ]);
      research.getCachedForApplication.mockResolvedValueOnce({
        status: 'ok',
        research: { businessSummary: 'cached' },
        sources: [],
        isCached: true,
        cachedAt: new Date().toISOString(),
      } as never);
      await service.chat(USER_ID, APP_ID, {
        userMessage: 'a',
        selectedLogIds: ['log-1'],
      });
      const assistantSaveCall = (msgRepo.save as jest.Mock).mock.calls[1][0];
      expect(assistantSaveCall.citations?.citedLogIds).toEqual(['log-1']);
      expect(assistantSaveCall.citations?.citedResearch).toBe(true);
    });
  });

  // ── cleanupOldMessages ──
  describe('cleanupOldMessages', () => {
    it('18) builder 호출 — DELETE WHERE application_id IN (...90 days) + RETURNING', async () => {
      const execMock = jest.fn().mockResolvedValue({ affected: 5, raw: [] });
      const returningMock = jest.fn().mockReturnValue({ execute: execMock });
      const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
      const deleteMock = jest.fn().mockReturnValue({ where: whereMock });
      msgRepo.createQueryBuilder.mockReturnValue({
        delete: deleteMock,
      } as never);

      const r = await service.cleanupOldMessages();
      expect(r.deleted).toBe(5);
      expect(deleteMock).toHaveBeenCalled();
      expect(whereMock.mock.calls[0][0]).toContain('Asia/Seoul');
      expect(whereMock.mock.calls[0][0]).toContain("INTERVAL '90 days'");
      expect(returningMock).toHaveBeenCalledWith(['id', 'applicationId']);
    });
  });
});
