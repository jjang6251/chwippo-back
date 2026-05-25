import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { mock } from 'jest-mock-extended';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { LlmService } from './llm.service';
import { ModerationService } from './moderation.service';
import {
  NOTE_SUMMARY_LIMITS,
  NoteSummaryService,
} from './note-summary.service';

describe('NoteSummaryService', () => {
  let service: NoteSummaryService;
  let llm: jest.Mocked<LlmService>;
  let moderation: jest.Mocked<ModerationService>;
  let emFindOne: jest.Mock;
  let emCount: jest.Mock;
  let emSave: jest.Mock;

  const longText = '가'.repeat(100); // 100자 — MIN_NOTE_CHARS(50) 초과
  const longNote = { type: 'doc', content: [{ type: 'text', text: longText }] };

  const makeLog = (overrides: Partial<ActivityLog> = {}): ActivityLog => ({
    id: 'log-1',
    activityId: 'act-1',
    userId: 'user-1',
    content: '제목',
    occurredAt: '2026-05-10',
    cat: null,
    comps: [],
    cl: [],
    quant: null,
    mood: null,
    keywords: [],
    note: longNote,
    noteSummary: null,
    noteSummaryHash: null,
    noteSummaryAt: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    activity: undefined as unknown as ActivityLog['activity'],
    ...overrides,
  });

  beforeEach(async () => {
    emFindOne = jest.fn();
    emCount = jest.fn();
    emSave = jest.fn().mockImplementation(async (_, e) => e);

    const fakeEm = {
      findOne: emFindOne,
      count: emCount,
      save: emSave,
    } as unknown as EntityManager;

    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(fakeEm)),
    } as unknown as DataSource;

    const mockLogRepo = mock<Repository<ActivityLog>>();
    const mockLlmLogRepo = mock<Repository<LlmCallLog>>();
    const mockLlm = mock<LlmService>();
    const mockMod = mock<ModerationService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NoteSummaryService,
        { provide: getRepositoryToken(ActivityLog), useValue: mockLogRepo },
        { provide: getRepositoryToken(LlmCallLog), useValue: mockLlmLogRepo },
        { provide: LlmService, useValue: mockLlm },
        { provide: ModerationService, useValue: mockMod },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<NoteSummaryService>(NoteSummaryService);
    llm = module.get(LlmService);
    moderation = module.get(ModerationService);

    moderation.check.mockResolvedValue({
      flagged: false,
      categories: [],
      apiFailed: false,
    });
  });

  describe('extractPlainText', () => {
    it('Tiptap JSON 에서 text 노드만 추출', () => {
      const text = NoteSummaryService.extractPlainText({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '안녕' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '세상' }] },
        ],
      });
      expect(text).toBe('안녕 세상');
    });

    it('null 노트는 빈 문자열', () => {
      expect(NoteSummaryService.extractPlainText(null)).toBe('');
    });
  });

  describe('summarize', () => {
    it('노트가 50자 미만이면 BadRequest', async () => {
      emFindOne.mockResolvedValue(
        makeLog({
          note: { type: 'doc', content: [{ type: 'text', text: '짧음' }] },
        }),
      );

      await expect(service.summarize('user-1', 'log-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('없는 log → NotFound', async () => {
      emFindOne.mockResolvedValue(null);
      await expect(service.summarize('user-1', 'log-x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('다른 user 의 log → Forbidden', async () => {
      emFindOne.mockResolvedValue(makeLog({ userId: 'other' }));
      await expect(service.summarize('user-1', 'log-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('정상: LLM 호출 → 요약 저장 + hash 저장 + 잔여 횟수 반환', async () => {
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValue(0);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '요약된 내용',
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'call-1',
      });

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('ok');
      expect(result.summary).toBe('요약된 내용');
      expect(result.cached).toBe(false);
      expect(result.remainingPerNote).toBe(
        NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H - 1,
      );
      // log.noteSummary, hash, at 저장 확인
      expect(emSave).toHaveBeenCalledWith(
        ActivityLog,
        expect.objectContaining({
          noteSummary: '요약된 내용',
          noteSummaryHash: expect.any(String),
        }),
      );
    });

    it('같은 hash + force=false → LLM 호출 없이 캐시 반환', async () => {
      const hash =
        '7f23ae7e5e0fed5466b8fb12d3c4ce4e0c3a9f6bd87aab1f4ade62b6f7b4d6f7'; // 임의
      emFindOne.mockResolvedValue(
        makeLog({
          noteSummary: '예전 요약',
          noteSummaryHash: hash,
        }),
      );

      // hash 계산 결과가 동일하도록 — 동일 텍스트면 동일 hash
      // 따라서 실제 hash 를 미리 계산해 entity 에 주입하는 helper
      const fakeLog = makeLog();
      fakeLog.noteSummary = '예전 요약';
      const text = NoteSummaryService.extractPlainText(fakeLog.note);
      const realHash = createHash('sha256').update(text).digest('hex');
      fakeLog.noteSummaryHash = realHash;
      emFindOne.mockResolvedValueOnce(fakeLog);

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('cached');
      expect(result.summary).toBe('예전 요약');
      expect(llm.call).not.toHaveBeenCalled();
    });

    // memory `feedback_test_real_user_flows` — note 수정 후 첫 summarize 호출 흐름
    it('기존 noteSummary 가 있어도 hash 가 다르면 (note 수정 후) 캐시 무효 + 새 LLM 호출', async () => {
      const fakeLog = makeLog();
      fakeLog.noteSummary = '예전 요약';
      // 일부러 다른 hash 저장 (note 수정된 상태 시뮬레이션)
      fakeLog.noteSummaryHash = 'STALE_HASH_DIFFERENT_FROM_ACTUAL';
      emFindOne.mockResolvedValue(fakeLog);
      emCount.mockResolvedValue(0);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '새 요약',
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');

      // 캐시 hit 아님 → 새 LLM 호출
      expect(result.status).toBe('ok');
      expect(result.cached).toBe(false);
      expect(result.summary).toBe('새 요약');
      expect(llm.call).toHaveBeenCalled();
      // 새 hash + summary 저장됨
      expect(emSave).toHaveBeenCalledWith(
        ActivityLog,
        expect.objectContaining({
          noteSummary: '새 요약',
          noteSummaryHash: expect.not.stringMatching(/STALE_HASH/),
        }),
      );
    });

    it('force=true → 캐시 무시하고 다시 호출', async () => {
      const fakeLog = makeLog();
      fakeLog.noteSummary = '예전 요약';
      const text = NoteSummaryService.extractPlainText(fakeLog.note);
      fakeLog.noteSummaryHash = createHash('sha256').update(text).digest('hex');
      emFindOne.mockResolvedValue(fakeLog);
      emCount.mockResolvedValue(0);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '새 요약',
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1', {
        force: true,
      });

      expect(result.summary).toBe('새 요약');
      expect(llm.call).toHaveBeenCalled();
    });

    it('노트당 24h 한도 초과 → blocked + 0회 남음 + audit 로그', async () => {
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValueOnce(NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H);
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'limit',
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('blocked');
      expect(result.remainingPerNote).toBe(0);
      expect(llm.call).toHaveBeenCalledWith(
        expect.objectContaining({ preBlockedStatus: 'blocked_quota' }),
      );
    });

    it('일 한도 초과 → blocked + reason 메시지', async () => {
      emFindOne.mockResolvedValue(makeLog());
      // perNote count(0) → day count(30) 초과
      emCount
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(NOTE_SUMMARY_LIMITS.PER_USER_PER_DAY);
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'day',
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');
      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('오늘');
    });

    it('moderation flagged → blocked + blocked_moderation 로그', async () => {
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValue(0);
      moderation.check.mockResolvedValue({
        flagged: true,
        categories: ['hate'],
        apiFailed: false,
      });
      llm.call.mockResolvedValue({
        status: 'blocked_moderation',
        text: null,
        errorMessage: 'flagged',
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');
      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('부적절');
      expect(llm.call).toHaveBeenCalledWith(
        expect.objectContaining({ preBlockedStatus: 'blocked_moderation' }),
      );
    });

    it('LLM 자체 에러 → blocked + 재시도 안내', async () => {
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValue(0);
      llm.call.mockResolvedValue({
        status: 'error',
        text: null,
        errorMessage: 'rate limit',
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');
      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('잠시 후');
    });

    it('월 한도 300회 초과 → blocked + "이번 달" reason', async () => {
      emFindOne.mockResolvedValue(makeLog());
      // perNote count(0) → day count(0) → month count(300)
      emCount
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(NOTE_SUMMARY_LIMITS.PER_USER_PER_MONTH);
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'month',
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');
      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('이번 달');
    });

    it('moderation API 실패 (apiFailed=true) → fail-open, 정상 LLM 호출 진행', async () => {
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValue(0);
      moderation.check.mockResolvedValue({
        flagged: false,
        categories: [],
        apiFailed: true,
      });
      llm.call.mockResolvedValue({
        status: 'ok',
        text: 'fail-open 요약',
        promptTokens: 50,
        completionTokens: 30,
        costUsd: 0.0001,
        latencyMs: 100,
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');
      expect(result.status).toBe('ok');
      expect(result.summary).toBe('fail-open 요약');
    });

    it('알려진 quota race leak (문서화): 동시 호출 시 count() 사이 락 없음 — 양쪽 ok 가능 (수용)', async () => {
      // 동시 호출 시 두 transaction 이 count() 단계에서 서로 못 보고 통과.
      // 시뮬: 모든 count = 0 (한도 미만) → 양쪽 모두 ok.
      // 실 운영에서는 두 요청이 모두 count=29 본 후 양쪽 통과 = 31회 leak. 동일 메커니즘.
      const logA = makeLog({ id: 'log-A' });
      const logB = makeLog({ id: 'log-B' });
      emFindOne.mockResolvedValueOnce(logA).mockResolvedValueOnce(logB);
      emCount.mockResolvedValue(0);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: 'r',
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.0001,
        latencyMs: 50,
        callLogId: 'c',
      });

      const [r1, r2] = await Promise.all([
        service.summarize('user-1', 'log-A'),
        service.summarize('user-1', 'log-B'),
      ]);
      // 두 호출 사이 quota 락 없음을 명시 — F7 에서 user_ai_quota 테이블로 정확화 검토
      expect(r1.status).toBe('ok');
      expect(r2.status).toBe('ok');
    });
  });
});
