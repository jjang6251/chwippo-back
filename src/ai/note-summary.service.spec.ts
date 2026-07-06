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
import { AbuserBanService } from './abuser-ban.service';
import { FeatureQuotaConfig } from './entities/feature-quota-config.entity';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { LlmService } from './llm.service';
import { ModerationService } from './moderation.service';
import {
  NOTE_SUMMARY_LIMITS,
  NoteSummaryService,
} from './note-summary.service';
import { QuotaCheckService } from './quota-check.service';

describe('NoteSummaryService', () => {
  let service: NoteSummaryService;
  let llm: jest.Mocked<LlmService>;
  let moderation: jest.Mocked<ModerationService>;
  let quotaCheck: jest.Mocked<QuotaCheckService>;
  let abuserBan: { checkAndBan: jest.Mock; getActiveOverride: jest.Mock };
  let configRepo: jest.Mocked<Repository<FeatureQuotaConfig>>;
  let emFindOne: jest.Mock;
  let emCount: jest.Mock;
  let emSave: jest.Mock;

  const longText = '가'.repeat(100);
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
    emCount = jest.fn().mockResolvedValue(0);
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
    const mockConfigRepo = mock<Repository<FeatureQuotaConfig>>();
    // 5.6.8 — default: per-note 한도 5 (seed 값)
    mockConfigRepo.findOne.mockResolvedValue({
      feature: 'note_summary',
      tier: 'free',
      perResourceDayLimit: 5,
    } as FeatureQuotaConfig);
    const mockLlm = mock<LlmService>();
    const mockMod = mock<ModerationService>();
    abuserBan = {
      getActiveOverride: jest.fn().mockResolvedValue(null),
      checkAndBan: jest.fn().mockResolvedValue({ banned: false }),
    };
    const mockQuotaCheck = mock<QuotaCheckService>();
    // default: 통과
    mockQuotaCheck.checkAndPrepare.mockResolvedValue({ blocked: false });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NoteSummaryService,
        { provide: getRepositoryToken(ActivityLog), useValue: mockLogRepo },
        { provide: getRepositoryToken(LlmCallLog), useValue: mockLlmLogRepo },
        {
          provide: getRepositoryToken(FeatureQuotaConfig),
          useValue: mockConfigRepo,
        },
        { provide: LlmService, useValue: mockLlm },
        { provide: ModerationService, useValue: mockMod },
        { provide: DataSource, useValue: dataSource },
        { provide: AbuserBanService, useValue: abuserBan },
        { provide: QuotaCheckService, useValue: mockQuotaCheck },
      ],
    }).compile();

    service = module.get<NoteSummaryService>(NoteSummaryService);
    llm = module.get(LlmService);
    moderation = module.get(ModerationService);
    quotaCheck = module.get(QuotaCheckService);
    configRepo = module.get(getRepositoryToken(FeatureQuotaConfig));

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
        outputRedacted: false,
      });

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('ok');
      expect(result.summary).toBe('요약된 내용');
      expect(result.cached).toBe(false);
      expect(result.remainingPerNote).toBe(
        NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H - 1,
      );
      expect(quotaCheck.checkAndPrepare).toHaveBeenCalledWith(
        'user-1',
        'note_summary',
      );
      expect(emSave).toHaveBeenCalledWith(
        ActivityLog,
        expect.objectContaining({
          noteSummary: '요약된 내용',
          noteSummaryHash: expect.any(String),
        }),
      );
    });

    it('같은 hash + force=false → LLM 호출 없이 캐시 반환 (quota check 도 skip)', async () => {
      const fakeLog = makeLog();
      fakeLog.noteSummary = '예전 요약';
      const text = NoteSummaryService.extractPlainText(fakeLog.note);
      fakeLog.noteSummaryHash = createHash('sha256').update(text).digest('hex');
      emFindOne.mockResolvedValue(fakeLog);

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('cached');
      expect(result.summary).toBe('예전 요약');
      expect(llm.call).not.toHaveBeenCalled();
      // 캐시 hit → quota check 도 호출 안 됨 (admin 통제 외, LLM 호출 0)
      expect(quotaCheck.checkAndPrepare).not.toHaveBeenCalled();
    });

    // memory `feedback_test_real_user_flows` — note 수정 후 첫 summarize 흐름
    it('기존 noteSummary 가 있어도 hash 가 다르면 (note 수정 후) 캐시 무효 + 새 LLM 호출', async () => {
      const fakeLog = makeLog();
      fakeLog.noteSummary = '예전 요약';
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
        outputRedacted: false,
      });

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('ok');
      expect(result.cached).toBe(false);
      expect(result.summary).toBe('새 요약');
      expect(llm.call).toHaveBeenCalled();
      expect(emSave).toHaveBeenCalledWith(
        ActivityLog,
        expect.objectContaining({
          noteSummary: '새 요약',
          noteSummaryHash: expect.not.stringMatching(/STALE_HASH/),
        }),
      );
    });

    it('force=true → 캐시 무시하고 다시 호출 (quota check 통과 필요)', async () => {
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
        outputRedacted: false,
      });

      const result = await service.summarize('user-1', 'log-1', {
        force: true,
      });

      expect(result.summary).toBe('새 요약');
      expect(llm.call).toHaveBeenCalled();
      expect(quotaCheck.checkAndPrepare).toHaveBeenCalled();
    });

    it('노트당 24h 한도 초과 → blocked + 0회 남음 + audit 로그 (quota check 도달 안 함)', async () => {
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
      // per-note 가 먼저 → quota check 호출 안 됨
      expect(quotaCheck.checkAndPrepare).not.toHaveBeenCalled();
    });

    it('QuotaCheck DAY_LIMIT → blocked + reason 전파 + abuser ban 트리거', async () => {
      emFindOne.mockResolvedValue(makeLog());
      quotaCheck.checkAndPrepare.mockResolvedValue({
        blocked: true,
        code: 'DAY_LIMIT',
        reason: '오늘 사용 한도 30회를 모두 사용했어요.',
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'day',
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('오늘');
      expect(llm.call).toHaveBeenCalledWith(
        expect.objectContaining({
          preBlockedStatus: 'blocked_quota',
          preBlockedReason: expect.stringContaining('DAY_LIMIT'),
        }),
      );
      // DAY_LIMIT → abuser ban 평가 트리거
      expect(abuserBan.checkAndBan).toHaveBeenCalledWith(
        'user-1',
        'note_summary',
        1,
      );
    });

    it('QuotaCheck MONTH_LIMIT → blocked + "이번 달" reason + abuser ban 미트리거', async () => {
      emFindOne.mockResolvedValue(makeLog());
      quotaCheck.checkAndPrepare.mockResolvedValue({
        blocked: true,
        code: 'MONTH_LIMIT',
        reason: '이번 달 사용 한도 300회를 모두 사용했어요.',
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'month',
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('이번 달');
      // MONTH_LIMIT 은 abuser ban 미트리거 (day 도달 패턴만 ban)
      expect(abuserBan.checkAndBan).not.toHaveBeenCalled();
    });

    it('QuotaCheck FEATURE_DISABLED (kill switch) → blocked + reason + abuser ban 미트리거', async () => {
      emFindOne.mockResolvedValue(makeLog());
      quotaCheck.checkAndPrepare.mockResolvedValue({
        blocked: true,
        code: 'FEATURE_DISABLED',
        reason: '관리자에 의해 일시 중단된 기능이에요. 곧 복구돼요.',
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'disabled',
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('관리자');
      expect(abuserBan.checkAndBan).not.toHaveBeenCalled();
      // moderation, 실제 LLM call 안 됨 — 단 audit row 는 생성
      expect(moderation.check).not.toHaveBeenCalled();
    });

    it('QuotaCheck COOLDOWN → blocked + nextAvailableAt ISO 전파', async () => {
      emFindOne.mockResolvedValue(makeLog());
      const next = new Date(Date.now() + 20_000);
      quotaCheck.checkAndPrepare.mockResolvedValue({
        blocked: true,
        code: 'COOLDOWN',
        reason: '다음 사용까지 20초 남았어요.',
        nextAvailableAt: next,
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'cooldown',
        callLogId: 'c',
      });

      const result = await service.summarize('user-1', 'log-1');

      expect(result.status).toBe('blocked');
      expect(result.nextAvailableAt).toBe(next.toISOString());
      expect(abuserBan.checkAndBan).not.toHaveBeenCalled();
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
        outputRedacted: false,
      });

      const result = await service.summarize('user-1', 'log-1');
      expect(result.status).toBe('ok');
      expect(result.summary).toBe('fail-open 요약');
    });

    it('알려진 quota race leak (문서화): 동시 호출 시 락 없음 — 양쪽 ok 가능 (수용)', async () => {
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
        outputRedacted: false,
      });

      const [r1, r2] = await Promise.all([
        service.summarize('user-1', 'log-A'),
        service.summarize('user-1', 'log-B'),
      ]);
      expect(r1.status).toBe('ok');
      expect(r2.status).toBe('ok');
    });
  });

  // ── 5.6.8 — per_resource_day_limit admin 통제 ──
  describe('5.6.8 per-note 한도 admin 통제', () => {
    it('1) admin config perResourceDayLimit=3 → 같은 노트 3회 호출 후 blocked (5 hardcoded 무시)', async () => {
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: 3,
      } as FeatureQuotaConfig);
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValueOnce(3); // 이미 3회 사용
      llm.call.mockResolvedValueOnce({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'blocked_quota',
        callLogId: 'l-pre',
      });
      const r = await service.summarize('user-1', 'log-1');
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('3회');
      expect(r.perNoteLimit).toBe(3);
    });

    it('2) admin config perResourceDayLimit=10 → 같은 노트 9회 사용도 통과', async () => {
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: 10,
      } as FeatureQuotaConfig);
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValueOnce(9);
      llm.call.mockResolvedValueOnce({
        status: 'ok',
        text: '요약',
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'l-1',
        outputRedacted: false,
      });
      const r = await service.summarize('user-1', 'log-1');
      expect(r.status).toBe('ok');
      expect(r.perNoteLimit).toBe(10);
      expect(r.remainingPerNote).toBe(0); // 10 - 9 - 1
    });

    it('3) config row 없음 → fallback NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H (5) 적용', async () => {
      configRepo.findOne.mockResolvedValue(null);
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValueOnce(4);
      llm.call.mockResolvedValueOnce({
        status: 'ok',
        text: '요약',
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'l-1',
        outputRedacted: false,
      });
      const r = await service.summarize('user-1', 'log-1');
      expect(r.status).toBe('ok');
      expect(r.perNoteLimit).toBe(NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H);
    });

    it('4) config perResourceDayLimit=NULL → fallback 5', async () => {
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: null,
      } as FeatureQuotaConfig);
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValueOnce(0);
      llm.call.mockResolvedValueOnce({
        status: 'ok',
        text: '요약',
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'l-1',
        outputRedacted: false,
      });
      const r = await service.summarize('user-1', 'log-1');
      expect(r.perNoteLimit).toBe(5);
      expect(r.remainingPerNote).toBe(4);
    });

    it('5-regression) per-note count 쿼리는 status IN (ok, retry_parsing) 필터 (8/7 같은 limit 초과 표시 방지)', async () => {
      // blocked_quota preBlock row 가 누적돼도 카운트 X
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: 5,
      } as FeatureQuotaConfig);
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValueOnce(2);
      llm.call.mockResolvedValueOnce({
        status: 'ok',
        text: '요약',
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'l-1',
        outputRedacted: false,
      });
      await service.summarize('user-1', 'log-1');
      const callArgs = emCount.mock.calls[0];
      // billableCallWhere 배열 — [0] ok·retry / [1] 토큰 소모된 error
      const whereCondition = callArgs[1].where[0];
      expect(whereCondition.status).toBeDefined();
    });

    it('6) 응답에 perNoteLimit 항상 포함 (ok·blocked 둘 다, UI 가 "N/M" 표시)', async () => {
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: 7,
      } as FeatureQuotaConfig);
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValueOnce(2);
      llm.call.mockResolvedValueOnce({
        status: 'ok',
        text: '요약',
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'l-1',
        outputRedacted: false,
      });
      const r = await service.summarize('user-1', 'log-1');
      expect(r.perNoteLimit).toBe(7);
    });
  });

  // ── 5.6.8 — getStatus (mount 시 잔여 표시용 read-only) ──
  describe('5.6.8 getStatus (read-only)', () => {
    let logFindOne: jest.Mock;
    let llmLogCount: jest.Mock;

    beforeEach(() => {
      const repoMock = module ?? null;
      void repoMock;
      // logRepo / llmLogRepo 의 메서드 mock 접근
      const logRepo = (
        service as unknown as { logRepo: jest.Mocked<Repository<ActivityLog>> }
      ).logRepo;
      const llmLogRepo = (
        service as unknown as {
          llmLogRepo: jest.Mocked<Repository<LlmCallLog>>;
        }
      ).llmLogRepo;
      logFindOne = logRepo.findOne as jest.Mock;
      llmLogCount = llmLogRepo.count as jest.Mock;
      logFindOne.mockReset();
      llmLogCount.mockReset();
    });

    it('1) 정상 — log 본인 소유 + 24h 카운트 + admin limit 반환', async () => {
      logFindOne.mockResolvedValue(makeLog());
      llmLogCount.mockResolvedValue(2);
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: 5,
      } as FeatureQuotaConfig);
      const r = await service.getStatus('user-1', 'log-1');
      expect(r).toEqual({
        perNoteUsed: 2,
        perNoteLimit: 5,
        remainingPerNote: 3,
      });
    });

    it('2) log 없음 → NotFoundException', async () => {
      logFindOne.mockResolvedValue(null);
      await expect(service.getStatus('user-1', 'log-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(llmLogCount).not.toHaveBeenCalled();
    });

    it('3) 다른 user 의 log → ForbiddenException', async () => {
      logFindOne.mockResolvedValue(makeLog({ userId: 'other-user' }));
      await expect(service.getStatus('user-1', 'log-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('4) config NULL → fallback NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H', async () => {
      logFindOne.mockResolvedValue(makeLog());
      llmLogCount.mockResolvedValue(0);
      configRepo.findOne.mockResolvedValue(null);
      const r = await service.getStatus('user-1', 'log-1');
      expect(r.perNoteLimit).toBe(NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H);
    });

    it('5) status 필터 — blocked/error row 카운트 X (where.status defined)', async () => {
      logFindOne.mockResolvedValue(makeLog());
      llmLogCount.mockResolvedValue(0);
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: 5,
      } as FeatureQuotaConfig);
      await service.getStatus('user-1', 'log-1');
      const where = llmLogCount.mock.calls[0][0].where[0]; // billableCallWhere 배열
      expect(where.status).toBeDefined();
    });

    it('6) remainingPerNote 음수 안 나옴 (이미 한도 초과 시 0)', async () => {
      logFindOne.mockResolvedValue(makeLog());
      llmLogCount.mockResolvedValue(9); // 한도 5 초과
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: 5,
      } as FeatureQuotaConfig);
      const r = await service.getStatus('user-1', 'log-1');
      expect(r.perNoteUsed).toBe(9);
      expect(r.remainingPerNote).toBe(0); // Math.max(0, ...)
    });

    // ── 5.6.9 — quota_reset_at 적용 (QuotaCheckService.resolveSince24h 위임) ──
    it('5.6.9-a) getStatus → quotaCheck.resolveSince24h 호출 (single source of truth)', async () => {
      logFindOne.mockResolvedValue(makeLog());
      llmLogCount.mockResolvedValue(0);
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: 5,
      } as FeatureQuotaConfig);
      // 1시간 전 반환 시 reset 효과
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      quotaCheck.resolveSince24h.mockResolvedValueOnce(oneHourAgo);
      await service.getStatus('user-1', 'log-1');
      expect(quotaCheck.resolveSince24h).toHaveBeenCalledWith('user-1');
      const where = llmLogCount.mock.calls[0][0].where[0]; // billableCallWhere 배열
      // Between 의 시작 시각이 oneHourAgo 와 같아야 함
      const between = where.createdAt as { _value: Date[] };
      expect(between._value[0]).toBe(oneHourAgo);
    });

    it('5.6.9-b) summarize 도 동일 — perNoteCount 쿼리가 resolveSince24h 사용', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      quotaCheck.resolveSince24h.mockResolvedValueOnce(oneHourAgo);
      configRepo.findOne.mockResolvedValue({
        feature: 'note_summary',
        tier: 'free',
        perResourceDayLimit: 5,
      } as FeatureQuotaConfig);
      emFindOne.mockResolvedValue(makeLog());
      emCount.mockResolvedValueOnce(0);
      llm.call.mockResolvedValueOnce({
        status: 'ok',
        text: '요약',
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'l-1',
        outputRedacted: false,
      });
      await service.summarize('user-1', 'log-1');
      expect(quotaCheck.resolveSince24h).toHaveBeenCalledWith('user-1');
      const where = emCount.mock.calls[0][1].where[0]; // billableCallWhere 배열
      const between = where.createdAt as { _value: Date[] };
      expect(between._value[0]).toBe(oneHourAgo);
    });
  });
});
