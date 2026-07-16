import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { CoinService } from './coin.service';
import { CostGuardService } from './cost-guard.service';
import {
  CURRENT_AI_CONSENT_VERSION,
  LlmService,
  type LlmCallBlocked,
} from './llm.service';
import {
  LlmJsonParseError,
  LlmProvider,
} from './providers/llm-provider.interface';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAIProvider } from './providers/openai.provider';

/**
 * LlmService 단위 spec — PR 0 신규 아키텍처 검증.
 *
 * 검증 축:
 * - consent gate (NULL / version mismatch / 통과)
 * - provider 라우팅 (openai vs anthropic feature 별 분기)
 * - PII 스크럽 (system + user prompt 양쪽)
 * - 본인 이름 블랙리스트
 * - input token cap (chars/3 추정)
 * - 출력 PII 역방향 (outputRedacted flag)
 * - retry_parsing (callJson 1회 재시도 + 별도 audit row)
 * - audit 행 신규 필드 (provider, promptHash, promptExcerpt, attempts, outputRedacted)
 * - preBlocked 분기 (consent 보다 우선)
 */
describe('LlmService', () => {
  let service: LlmService;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;
  let userRepo: jest.Mocked<Repository<User>>;
  // 테스트용 mutable fixture — LlmProvider 의 isAvailable 는 readonly 지만 spec 에선 토글 필요
  type MutableProvider = {
    -readonly [K in keyof LlmProvider]: LlmProvider[K];
  } & {
    complete: jest.Mock;
    callJson: jest.Mock;
    /** cost hardening 🔴2 — 스트림 경로 테스트용 (AnthropicProvider 전용 메서드) */
    callJsonStream?: jest.Mock;
  };
  let openai: MutableProvider;
  let anthropic: MutableProvider;
  let costGuardMock: { check: jest.Mock; invalidate: jest.Mock };
  let coinServiceMock: {
    canCharge: jest.Mock;
    charge: jest.Mock;
    chargesCoins: jest.Mock;
  };

  const makeUser = (overrides: Partial<User> = {}): User => ({
    id: 'u-1',
    kakaoId: 'k-1',
    appleSub: null,
    appleEmail: null,
    appleRefreshToken: null,
    nickname: '장성원',
    email: null,
    role: 'user',
    createdAt: new Date(),
    lastActiveAt: null,
    termsAgreedAt: new Date(),
    dashboardConfig: null,
    alarmConfig: null,
    alarmPromptedAt: null,
    alarmPermissionGranted: false,
    onboardedAt: new Date(),
    suspendedAt: null,
    aiConsentAt: new Date(),
    aiConsentVersion: CURRENT_AI_CONSENT_VERSION,
    onboardedCoinAt: null,
    suspendReason: null,
    suspendExpiresAt: null,
    pendingNotification: null,
    signupJobCategories: null,
    signupOtherText: null,
    sampleCardsDismissedAt: null,
    calendarHomeIntroDismissedAt: null,
    sessionExpiredNotifiedAt: null,
    tier: 'free',
    ...overrides,
  });

  const makeLog = (overrides: Partial<LlmCallLog> = {}): LlmCallLog => ({
    id: 'log-' + Math.random().toString(36).slice(2, 8),
    userId: 'u-1',
    feature: 'note_summary',
    provider: 'openai',
    model: 'gpt-4o-mini',
    promptTokens: 0,
    completionTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchCount: 0,
    coinCost: '0',
    costBreakdown: null,
    costUsd: '0',
    latencyMs: 0,
    status: 'ok',
    errorMessage: null,
    resourceType: null,
    resourceId: null,
    promptHash: null,
    promptExcerpt: null,
    outputRedacted: false,
    attempts: 1,
    createdAt: new Date(),
    user: undefined as unknown as User,
    ...overrides,
  });

  const buildProvider = (available = true) => {
    const p = {
      name: 'openai' as const,
      isAvailable: available,
      complete: jest.fn(),
      callJson: jest.fn(),
    };
    return p;
  };

  beforeEach(async () => {
    openai = { ...buildProvider(true), name: 'openai' };
    anthropic = { ...buildProvider(true), name: 'anthropic' };

    const mockLogRepo = mock<Repository<LlmCallLog>>();
    mockLogRepo.create.mockImplementation((d) => d as LlmCallLog);
    mockLogRepo.save.mockImplementation(async (d) =>
      makeLog(d as Partial<LlmCallLog>),
    );

    const mockUserRepo = mock<Repository<User>>();
    mockUserRepo.findOne.mockResolvedValue(makeUser());

    const config = mock<ConfigService>();
    config.get.mockImplementation((key: string) => {
      if (key === 'OPENAI_MODEL_LIGHT') return 'gpt-4o-mini';
      if (key === 'OPENAI_MODEL_HEAVY') return 'gpt-4o';
      if (key === 'ANTHROPIC_MODEL_LIGHT') return 'claude-haiku-4-5-20251001';
      if (key === 'ANTHROPIC_MODEL_HEAVY') return 'claude-sonnet-4-6';
      return undefined;
    });

    // PR_B1 — CoinService mock (canCharge 항상 통과, charge 0 코인)
    // 웨이브 C — chargesCoins 기본 false → in-flight lock 미개입 (기존 테스트 동작 보존).
    //   lock 테스트는 coinServiceMock.chargesCoins.mockResolvedValue(true) 로 전환.
    const coinService = (coinServiceMock = {
      canCharge: jest.fn().mockResolvedValue({ ok: true }),
      charge: jest.fn().mockResolvedValue({
        coinCost: 0,
        costUsd: 0,
        breakdown: {
          input: 0,
          output: 0,
          cache_creation: 0,
          cache_read: 0,
          web_search: 0,
        },
      }),
      chargesCoins: jest.fn().mockResolvedValue(false),
    });

    // AI cost guard — 기본 통과 mock (개별 spec 가 mockReturnValueOnce 로 차단 케이스 가능)
    const costGuard = (costGuardMock = {
      check: jest.fn().mockResolvedValue({
        blocked: false,
        currentUserTotal: 0,
        currentFeatureTotal: 0,
        perUserCap: 0.5,
        perFeatureCap: 5,
      }),
      invalidate: jest.fn(),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmService,
        { provide: OpenAIProvider, useValue: openai },
        { provide: AnthropicProvider, useValue: anthropic },
        { provide: getRepositoryToken(LlmCallLog), useValue: mockLogRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: ConfigService, useValue: config },
        { provide: CoinService, useValue: coinService },
        { provide: CostGuardService, useValue: costGuard },
      ],
    }).compile();

    service = module.get<LlmService>(LlmService);
    logRepo = module.get(getRepositoryToken(LlmCallLog));
    userRepo = module.get(getRepositoryToken(User));
  });

  // ── 1. preBlocked 분기 ──
  describe('preBlocked', () => {
    it('preBlockedStatus=blocked_quota → provider 미호출, audit row 만', async () => {
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: '일일 한도 초과',
      });
      expect(openai.complete).not.toHaveBeenCalled();
      expect(r.status).toBe('blocked_quota');
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'blocked_quota',
          provider: 'openai',
          attempts: 1,
          outputRedacted: false,
        }),
      );
    });

    it('preBlockedStatus=blocked_moderation → 동일', async () => {
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
        preBlockedStatus: 'blocked_moderation',
        preBlockedReason: 'flagged',
      });
      expect(r.status).toBe('blocked_moderation');
      expect(openai.complete).not.toHaveBeenCalled();
    });

    it('preBlockedReason 없으면 errorMessage 가 status 값 fallback', async () => {
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
        preBlockedStatus: 'blocked_quota',
      });
      if (r.status === 'ok') throw new Error('expected blocked');
      expect(r.errorMessage).toBe('blocked_quota');
    });

    it('preBlocked 일 때는 consent 체크 안 함 (preBlocked 우선)', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ aiConsentAt: null }));
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
        preBlockedStatus: 'blocked_quota',
      });
      expect(r.status).toBe('blocked_quota');
      // consent NULL 임에도 quota 우선 → blocked_consent 아님
    });
  });

  // ── 2. consent gate ──
  describe('consent gate', () => {
    it('ai_consent_at NULL → blocked_consent + provider 미호출', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ aiConsentAt: null }));
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('blocked_consent');
      expect(openai.complete).not.toHaveBeenCalled();
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'blocked_consent' }),
      );
    });

    it('aiConsentVersion 이 CURRENT 와 다르면 blocked_consent', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({
          aiConsentAt: new Date(),
          aiConsentVersion: 'v0-legacy',
        }),
      );
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('blocked_consent');
      if (r.status === 'ok') throw new Error('not expected');
      expect(r.errorMessage).toContain(CURRENT_AI_CONSENT_VERSION);
    });

    it('사용자 없음 → blocked_consent + 안내 메시지', async () => {
      userRepo.findOne.mockResolvedValue(null);
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('blocked_consent');
    });

    it('동의 완료 + version 일치 → 정상 진입 (consent gate 통과)', async () => {
      openai.complete.mockResolvedValue({
        text: 'ok',
        promptTokens: 10,
        completionTokens: 5,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('ok');
    });
  });

  // ── 3. provider 가용성 + 라우팅 ──
  describe('provider 라우팅 + 가용성', () => {
    it('note_summary → openai provider 호출', async () => {
      openai.complete.mockResolvedValue({
        text: 'r',
        promptTokens: 1,
        completionTokens: 1,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(openai.complete).toHaveBeenCalled();
      expect(anthropic.complete).not.toHaveBeenCalled();
    });

    it('coverletter_draft_v2 → anthropic provider 호출 (light claude-haiku-4-5)', async () => {
      anthropic.complete.mockResolvedValue({
        text: '자소서 초안',
        promptTokens: 100,
        completionTokens: 50,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'coverletter_draft_v2',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(anthropic.complete).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      );
      expect(openai.complete).not.toHaveBeenCalled();
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          status: 'ok',
        }),
      );
    });

    it('interview_prep_session → openai light gpt-4o-mini (모든 feature light 강제)', async () => {
      openai.complete.mockResolvedValue({
        text: 'q',
        promptTokens: 50,
        completionTokens: 30,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'interview_prep_session',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(openai.complete).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o-mini' }),
      );
    });

    it('provider isAvailable=false → status=error ("..._API_KEY 미설정")', async () => {
      openai.isAvailable = false;
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('error');
      if (r.status === 'ok') throw new Error('not expected');
      expect(r.errorMessage).toContain('OPENAI_API_KEY');
      expect(openai.complete).not.toHaveBeenCalled();
    });

    it('anthropic provider 미가용 (key 없음) → coverletter_draft_v2 호출 시 error', async () => {
      anthropic.isAvailable = false;
      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_draft_v2',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('error');
      if (r.status === 'ok') throw new Error('not expected');
      expect(r.errorMessage).toContain('ANTHROPIC_API_KEY');
    });
  });

  // ── 4. PII 스크럽 ──
  describe('PII 스크럽 + 본인 이름 블랙리스트', () => {
    it('system + user prompt 양쪽에 PII 정규식 적용', async () => {
      openai.complete.mockResolvedValue({
        text: 'r',
        promptTokens: 5,
        completionTokens: 5,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: '시스템 메일 admin@chwippo.com',
        userPrompt: '내 번호 010-1234-5678',
      });
      const passed = openai.complete.mock.calls[0][0] as {
        systemPrompt: string;
        userPrompt: string;
      };
      expect(passed.systemPrompt).toContain('[REDACTED_EMAIL]');
      expect(passed.systemPrompt).not.toContain('admin@chwippo.com');
      expect(passed.userPrompt).toContain('[REDACTED_PHONE]');
      expect(passed.userPrompt).not.toContain('010-1234-5678');
    });

    it('User.nickname 이 prompt 안에 있으면 [REDACTED_NAME] 치환 후 provider 로 전달', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ nickname: '박은빈' }));
      openai.complete.mockResolvedValue({
        text: 'r',
        promptTokens: 5,
        completionTokens: 5,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: '박은빈 이라고 합니다',
      });
      const passed = openai.complete.mock.calls[0][0] as {
        userPrompt: string;
      };
      expect(passed.userPrompt).toContain('[REDACTED_NAME]');
      expect(passed.userPrompt).not.toContain('박은빈');
    });

    it('응답에 PII (hallucination) 검출 시 outputRedacted=true 로 audit + 응답 본문 치환', async () => {
      openai.complete.mockResolvedValue({
        text: '담당자 010-9999-8888 로 연락하세요',
        promptTokens: 5,
        completionTokens: 10,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      if (r.status !== 'ok') throw new Error('expected ok');
      expect(r.text).toContain('[REDACTED_PHONE]');
      expect(r.text).not.toContain('010-9999-8888');
      expect(r.outputRedacted).toBe(true);
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ outputRedacted: true }),
      );
    });

    it('응답에 PII 없음 → outputRedacted=false', async () => {
      openai.complete.mockResolvedValue({
        text: '정상 요약 텍스트',
        promptTokens: 5,
        completionTokens: 5,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      if (r.status !== 'ok') throw new Error('expected ok');
      expect(r.outputRedacted).toBe(false);
    });

    it('구조화 json 응답에 PII(전화번호) 포함 → 반환 json 마스킹 + outputRedacted=true', async () => {
      anthropic.callJson.mockResolvedValue({
        text: '',
        json: { reply: '담당자 010-9999-8888 로 연락하세요', score: 7 },
        promptTokens: 50,
        completionTokens: 20,
        finishReason: 'tool_use',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_feedback',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: {
          name: 'fb',
          schema: { type: 'object', properties: { score: { type: 'number' } } },
        },
      });
      if (r.status !== 'ok') throw new Error('expected ok');
      expect(r.json).toEqual({
        reply: expect.stringContaining('[REDACTED_PHONE]'),
        score: 7,
      });
      expect(JSON.stringify(r.json)).not.toContain('010-9999-8888');
      expect(r.outputRedacted).toBe(true);
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ outputRedacted: true }),
      );
    });
  });

  // ── 프롬프트 캐시 세그먼트 (2026-07-09) ──
  describe('cachedContext — 캐시 세그먼트', () => {
    it('provider 호출에 cachedContext 전달 + PII 스크럽 적용', async () => {
      openai.complete.mockResolvedValue({
        text: 'ok',
        promptTokens: 10,
        completionTokens: 5,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        cachedContext: '고정 블록 — 연락처 010-1234-5678 포함',
        userPrompt: 'u',
      });
      expect(r.status).toBe('ok');
      const arg = openai.complete.mock.calls[0][0] as {
        cachedContext?: string;
      };
      expect(arg.cachedContext).toBeDefined();
      expect(arg.cachedContext).toContain('고정 블록');
      expect(arg.cachedContext).not.toContain('010-1234-5678'); // PII 스크럽
    });

    it('cachedContext 토큰이 input cap 계산에 포함 → 초과 시 blocked_input_cap', async () => {
      const huge = '가'.repeat(30_000); // 단독으로 8K 초과
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        cachedContext: huge,
        userPrompt: '짧은 메시지',
      });
      expect(r.status).toBe('blocked_input_cap');
      expect(openai.complete).not.toHaveBeenCalled();
    });

    it('cachedContext 미전달 → provider 인자 undefined (기존 동작 불변)', async () => {
      openai.complete.mockResolvedValue({
        text: 'ok',
        promptTokens: 10,
        completionTokens: 5,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      const arg = openai.complete.mock.calls[0][0] as {
        cachedContext?: string;
      };
      expect(arg.cachedContext).toBeUndefined();
    });
  });

  // ── 5. input token cap ──
  describe('input token cap', () => {
    it('cap 초과 시 blocked_input_cap (note_summary 8K 한도) — provider 미호출', async () => {
      // chars/3 추정: 30,000자 → 약 10,000 토큰 > 8,000
      const hugeText = '가'.repeat(30_000);
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: hugeText,
      });
      expect(r.status).toBe('blocked_input_cap');
      if (r.status === 'ok') throw new Error('not expected');
      expect(r.errorMessage).toContain('입력 토큰');
      expect(r.errorMessage).toContain('한도');
      expect(openai.complete).not.toHaveBeenCalled();
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'blocked_input_cap' }),
      );
    });

    it('cap 안쪽 길이 → 정상 호출', async () => {
      openai.complete.mockResolvedValue({
        text: 'r',
        promptTokens: 1,
        completionTokens: 1,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: '짧은 시스템',
        userPrompt: '짧은 사용자 입력',
      });
      expect(r.status).toBe('ok');
    });
  });

  // ── 6. retry_parsing ──
  describe('callJson retry_parsing', () => {
    const schema = {
      name: 'feedback',
      schema: { type: 'object', properties: { score: { type: 'number' } } },
    };

    it('callJson 1차 LlmJsonParseError → 1회 재시도 → 성공 시 별도 retry_parsing audit row + ok audit row', async () => {
      anthropic.callJson
        .mockRejectedValueOnce(
          new LlmJsonParseError('anthropic', 'raw garbage', 'parse fail'),
        )
        .mockResolvedValueOnce({
          text: '',
          json: { score: 7 },
          promptTokens: 50,
          completionTokens: 20,
          finishReason: 'tool_use',
        });

      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_feedback',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: schema,
      });

      expect(r.status).toBe('ok');
      if (r.status !== 'ok') throw new Error('expected ok');
      expect(r.json).toEqual({ score: 7 });
      expect(anthropic.callJson).toHaveBeenCalledTimes(2);

      // 별도 retry_parsing audit row + 성공 audit row 둘 다 저장됨
      const saveCalls = logRepo.save.mock.calls.map((c) => c[0]);
      const statuses = saveCalls.map((s) => (s as Partial<LlmCallLog>).status);
      expect(statuses).toContain('retry_parsing');
      expect(statuses).toContain('ok');

      // ok 행의 attempts=2
      const okRow = saveCalls.find(
        (s) => (s as Partial<LlmCallLog>).status === 'ok',
      ) as Partial<LlmCallLog>;
      expect(okRow.attempts).toBe(2);

      // retry_parsing 행은 tokens=0, cost=0 (quota 이중 카운트 방지)
      const retryRow = saveCalls.find(
        (s) => (s as Partial<LlmCallLog>).status === 'retry_parsing',
      ) as Partial<LlmCallLog>;
      expect(retryRow.promptTokens).toBe(0);
      expect(retryRow.completionTokens).toBe(0);
      expect(retryRow.costUsd).toBe('0');
    });

    it('callJson 2회 모두 실패 → status=error + LlmJsonParseError.message 보존', async () => {
      anthropic.callJson
        .mockRejectedValueOnce(
          new LlmJsonParseError('anthropic', 'r1', 'fail1'),
        )
        .mockRejectedValueOnce(
          new LlmJsonParseError('anthropic', 'r2', 'fail2'),
        );

      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_feedback',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: schema,
      });
      expect(r.status).toBe('error');
      expect(anthropic.callJson).toHaveBeenCalledTimes(2);
    });

    it('jsonSchema 없으면 complete() 사용 (callJson 미호출)', async () => {
      openai.complete.mockResolvedValue({
        text: 'plain',
        promptTokens: 5,
        completionTokens: 5,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(openai.complete).toHaveBeenCalled();
      expect(openai.callJson).not.toHaveBeenCalled();
    });
  });

  // ── 7. provider 일반 에러 ──
  describe('provider error', () => {
    it('complete() 에러 → status=error + errorMessage 보존 + audit row', async () => {
      openai.complete.mockRejectedValue(new Error('rate limit exceeded'));
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('error');
      if (r.status === 'ok') throw new Error('not expected');
      expect(r.errorMessage).toContain('rate limit');
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          promptTokens: 0,
          completionTokens: 0,
          costUsd: '0',
        }),
      );
    });
  });

  // ── 8. audit row 신규 필드 ──
  describe('audit row 신규 필드', () => {
    it('정상 호출 → provider/promptHash/promptExcerpt/attempts 기록', async () => {
      openai.complete.mockResolvedValue({
        text: '응답',
        promptTokens: 50,
        completionTokens: 20,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: '시스템',
        userPrompt: '사용자 prompt 내용',
      });
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          promptHash: expect.stringMatching(/^[a-f0-9]{64}$/), // SHA256 64자
          promptExcerpt: expect.any(String),
          attempts: 1,
          outputRedacted: false,
        }),
      );
    });

    it('promptExcerpt 는 200자 이내 (잘림)', async () => {
      openai.complete.mockResolvedValue({
        text: 'r',
        promptTokens: 1,
        completionTokens: 1,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'A'.repeat(500),
      });
      const saved = logRepo.save.mock.calls[0][0] as Partial<LlmCallLog>;
      expect(saved.promptExcerpt?.length).toBeLessThanOrEqual(200);
    });

    it('동일 prompt → promptHash 동일 (재호출 추적용)', async () => {
      openai.complete.mockResolvedValue({
        text: 'r',
        promptTokens: 1,
        completionTokens: 1,
        finishReason: 'stop',
      });
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 'same',
        userPrompt: 'same',
      });
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 'same',
        userPrompt: 'same',
      });
      const hash1 = (logRepo.save.mock.calls[0][0] as Partial<LlmCallLog>)
        .promptHash;
      const hash2 = (logRepo.save.mock.calls[1][0] as Partial<LlmCallLog>)
        .promptHash;
      expect(hash1).toBe(hash2);
    });

    it('blocked_consent / blocked_input_cap / preBlocked 행은 promptHash=null (정책)', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ aiConsentAt: null }));
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'blocked_consent',
          promptHash: null,
          promptExcerpt: null,
        }),
      );
    });
  });

  // ── 9. cost 계산 ──
  describe('cost 계산', () => {
    it('정상 호출 → costUsd 가 0 보다 큼 (llm-pricing 매트릭스 적용)', async () => {
      openai.complete.mockResolvedValue({
        text: 'r',
        promptTokens: 10_000,
        completionTokens: 5_000,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      if (r.status !== 'ok') throw new Error('expected ok');
      expect(r.costUsd).toBeGreaterThan(0);
    });
  });

  // ── 5.6.소급 — Mock LLM 분기 (NODE_ENV='development' + provider 미가용) ──
  describe('Mock LLM 분기 (dev only)', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      if (originalEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalEnv;
    });

    it('1) NODE_ENV=development + provider 미가용 → mock 응답 + audit (provider=mock, status=ok, costUsd=0)', async () => {
      process.env.NODE_ENV = 'development';
      openai.isAvailable = false;
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') throw new Error('expected ok');
      expect(r.costUsd).toBe(0);
      expect(openai.complete).not.toHaveBeenCalled();
      // audit row insert 검증 — provider='mock'
      expect(logRepo.save).toHaveBeenCalled();
      const saved = (logRepo.save as jest.Mock).mock.calls[0][0];
      expect(saved.provider).toBe('mock');
      expect(saved.status).toBe('ok');
      expect(saved.userId).toBe('u-1');
      expect(saved.feature).toBe('note_summary');
      expect(saved.attempts).toBe(1);
      expect(saved.outputRedacted).toBe(false);
      expect(saved.costUsd).toBe('0');
    });

    it('2) NODE_ENV=production + provider 미가용 → status=error (mock 안 탐, fail-safe)', async () => {
      process.env.NODE_ENV = 'production';
      openai.isAvailable = false;
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('error');
      // mock audit row 들어가지 않음 (provider='openai' 로 error audit)
      const saved = (logRepo.save as jest.Mock).mock.calls[0]?.[0];
      expect(saved?.provider).not.toBe('mock');
    });

    it('3) NODE_ENV=development + provider 가용 → 실제 호출 (mock 안 탐)', async () => {
      process.env.NODE_ENV = 'development';
      openai.isAvailable = true;
      openai.complete.mockResolvedValue({
        text: 'real',
        promptTokens: 5,
        completionTokens: 5,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('ok');
      expect(openai.complete).toHaveBeenCalled();
      const saved = (logRepo.save as jest.Mock).mock.calls[0][0];
      expect(saved.provider).toBe('openai');
    });

    it('4) NODE_ENV=development + provider 미가용 + preBlockedStatus → preBlock 우선 (mock 안 탐)', async () => {
      process.env.NODE_ENV = 'development';
      openai.isAvailable = false;
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: 'day limit',
      });
      expect(r.status).toBe('blocked_quota');
      const saved = (logRepo.save as jest.Mock).mock.calls[0][0];
      expect(saved.provider).not.toBe('mock');
      expect(saved.status).toBe('blocked_quota');
    });

    it('5) mock 분기 + jsonSchema 있음 → mock 응답에 json 필드 (callJson 흐름)', async () => {
      process.env.NODE_ENV = 'development';
      openai.isAvailable = false;
      anthropic.isAvailable = false; // coverletter_chat = anthropic provider
      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_chat',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: {
          name: 'noop',
          schema: {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        },
      });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') throw new Error('expected ok');
      // mock-llm-responses 가 jsonSchema 요청일 때 json 객체 반환
      expect(r.json).toBeDefined();
    });

    it('6) mock 분기 audit 의 model 은 FEATURE_MATRIX 의 model name (real provider 동일)', async () => {
      process.env.NODE_ENV = 'development';
      openai.isAvailable = false;
      await service.call({
        userId: 'u-1',
        feature: 'note_summary',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      const saved = (logRepo.save as jest.Mock).mock.calls[0][0];
      // FEATURE_MATRIX.note_summary.model = 'gpt-4o-mini' (light 강제)
      expect(saved.model).toMatch(/gpt-4o-mini|gpt-4o/);
    });
  });

  // ── Phase 3 — provider fallback (5xx · timeout · network) ──
  describe('fallback path', () => {
    /**
     * 사전 조건: 두 provider 모두 available. anthropic feature (coverletter_draft_v2) 사용 →
     * 1차 anthropic 실패 시 자동 openai retry.
     */
    const setupRecoverable = (status?: number) => {
      const err = new Error(
        status ? `${status} server error` : 'timeout',
      ) as Error & {
        status?: number;
      };
      if (status) err.status = status;
      anthropic.callJson = jest.fn().mockRejectedValue(err);
      anthropic.complete = jest.fn().mockRejectedValue(err);
    };

    it('anthropic 500 → openai retry → ok + wasFallback=true', async () => {
      setupRecoverable(500);
      openai.complete.mockResolvedValue({
        text: 'fallback ok',
        promptTokens: 10,
        completionTokens: 5,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_draft_v2', // anthropic feature
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        expect(r.wasFallback).toBe(true);
        expect(r.text).toBe('fallback ok');
      }
      // audit row 2건: 1차 실패 + 2차 success
      const calls = (logRepo.save as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const lastSave = calls[calls.length - 1][0];
      expect(lastSave.status).toBe('ok');
      expect(lastSave.errorMessage).toMatch(/FALLBACK_FROM/);
    });

    it('timeout (status 없음) → openai retry → ok', async () => {
      setupRecoverable(); // no status, message='timeout'
      openai.complete.mockResolvedValue({
        text: 'ok',
        promptTokens: 1,
        completionTokens: 1,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_draft_v2',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.wasFallback).toBe(true);
    });

    it('anthropic 429 (rate limit) → fallback X (raw error)', async () => {
      setupRecoverable(429);
      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_draft_v2',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('error');
      expect(openai.complete).not.toHaveBeenCalled();
    });

    it('anthropic 400 (bad request) → fallback X', async () => {
      setupRecoverable(400);
      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_draft_v2',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('error');
      expect(openai.complete).not.toHaveBeenCalled();
    });

    it('anthropic 500 + openai 500 → 둘 다 fail → error', async () => {
      setupRecoverable(500);
      const openaiErr = new Error('500 openai') as Error & { status?: number };
      openaiErr.status = 500;
      openai.complete.mockRejectedValue(openaiErr);
      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_draft_v2',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('error');
    });

    it('fallback provider isAvailable=false → fallback skip', async () => {
      setupRecoverable(500);
      openai.isAvailable = false;
      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_draft_v2',
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('error');
      expect(openai.complete).not.toHaveBeenCalled();
    });

    it('openai feature (note_summary) 500 → anthropic 으로 fallback', async () => {
      const err = new Error('500') as Error & { status?: number };
      err.status = 500;
      openai.complete.mockRejectedValue(err);
      anthropic.complete.mockResolvedValue({
        text: 'cross-provider fallback',
        promptTokens: 5,
        completionTokens: 5,
        finishReason: 'stop',
      });
      const r = await service.call({
        userId: 'u-1',
        feature: 'note_summary', // openai feature
        systemPrompt: 's',
        userPrompt: 'u',
      });
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.wasFallback).toBe(true);
    });
  });
  // ── cost hardening (2026-07-06) — 실패 비용 실측 기록 · fallback 연쇄 차단 · 스트림 cost guard ──
  describe('cost hardening', () => {
    const schema = {
      name: 'hardening',
      schema: { type: 'object', properties: { v: { type: 'number' } } },
    };
    const USAGE = { promptTokens: 1000, completionTokens: 500 };

    it('🔴1 parse 실패(usage 동봉) 1회 → 재시도 성공: retry_parsing row 에 실측 tokens·cost 기록', async () => {
      anthropic.callJson = jest
        .fn()
        .mockRejectedValueOnce(
          new LlmJsonParseError('anthropic', 'garbage', 'bad json', USAGE),
        )
        .mockResolvedValueOnce({
          text: '',
          json: { v: 1 },
          promptTokens: 50,
          completionTokens: 20,
          finishReason: 'tool_use',
        });

      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_feedback',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: schema,
      });
      expect(r.status).toBe('ok');

      const retryRow = logRepo.save.mock.calls
        .map((c) => c[0] as Partial<LlmCallLog>)
        .find((row) => row.status === 'retry_parsing');
      expect(retryRow).toBeDefined();
      expect(retryRow!.promptTokens).toBe(1000);
      expect(retryRow!.completionTokens).toBe(500);
      expect(Number(retryRow!.costUsd)).toBeGreaterThan(0);
    });

    it('🔴1+🟡2 parse 실패(usage) 2회 → error row 실측 기록 + fallback 미발동 (유료 3연쇄 차단)', async () => {
      anthropic.callJson = jest
        .fn()
        .mockRejectedValue(
          new LlmJsonParseError('anthropic', 'garbage', 'bad json', USAGE),
        );
      openai.callJson = jest.fn();
      openai.complete = jest.fn();

      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_draft_v2', // fallback 매핑이 있는 anthropic feature
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: schema,
      });

      expect(r.status).toBe('error');
      // 🟡2 — JsonParseError 는 recoverable 아님: 3번째 유료 호출 없음
      expect(openai.callJson).not.toHaveBeenCalled();
      expect(openai.complete).not.toHaveBeenCalled();

      // 🔴1 — 최종 error row 에 실측 tokens·cost
      const errorRow = logRepo.save.mock.calls
        .map((c) => c[0] as Partial<LlmCallLog>)
        .find((row) => row.status === 'error');
      expect(errorRow).toBeDefined();
      expect(errorRow!.promptTokens).toBe(1000);
      expect(errorRow!.completionTokens).toBe(500);
      expect(Number(errorRow!.costUsd)).toBeGreaterThan(0);
    });

    it('🔴1 usage 없는 parse 실패 (구형 throw) → 0 기록 유지 (하위 호환)', async () => {
      anthropic.callJson = jest
        .fn()
        .mockRejectedValue(
          new LlmJsonParseError('anthropic', 'garbage', 'bad json'),
        );

      const r = await service.call({
        userId: 'u-1',
        feature: 'coverletter_feedback',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: schema,
      });
      expect(r.status).toBe('error');
      const errorRow = logRepo.save.mock.calls
        .map((c) => c[0] as Partial<LlmCallLog>)
        .find((row) => row.status === 'error');
      expect(errorRow!.promptTokens).toBe(0);
      expect(errorRow!.costUsd).toBe('0');
    });

    describe('🔴2 callStream cost guard', () => {
      const collect = async (gen: AsyncGenerator<unknown>) => {
        const events: Array<{ type: string; message?: string }> = [];
        for await (const e of gen) {
          events.push(e as { type: string; message?: string });
        }
        return events;
      };

      it('cost guard 차단 → error event + blocked_cost_quota audit + provider 미호출', async () => {
        costGuardMock.check.mockResolvedValueOnce({
          blocked: true,
          reason: '오늘 AI 사용 비용 한도를 초과했어요.',
        });
        anthropic.callJsonStream = jest.fn();

        const events = await collect(
          service.callStream({
            userId: 'u-1',
            feature: 'coverletter_chat',
            systemPrompt: 's',
            userPrompt: 'u',
            jsonSchema: schema,
          }),
        );

        expect(events).toEqual([
          {
            type: 'error',
            message: '오늘 AI 사용 비용 한도를 초과했어요.',
          },
        ]);
        expect(anthropic.callJsonStream).not.toHaveBeenCalled();
        const blockedRow = logRepo.save.mock.calls
          .map((c) => c[0] as Partial<LlmCallLog>)
          .find((row) => row.status === 'blocked_cost_quota');
        expect(blockedRow).toBeDefined();
      });

      it('cost guard 통과 → check 호출 확인 + 정상 스트림 완주 (차감 포함)', async () => {
        anthropic.callJsonStream = jest
          .fn()
          .mockImplementation(async function* () {
            yield { type: 'partial', json: { v: 1 } };
            yield {
              type: 'done',
              json: { v: 1 },
              response: {
                text: '{"v":1}',
                promptTokens: 30,
                completionTokens: 10,
                finishReason: 'tool_use',
              },
            };
          });

        const events = await collect(
          service.callStream({
            userId: 'u-1',
            feature: 'coverletter_chat',
            systemPrompt: 's',
            userPrompt: 'u',
            jsonSchema: schema,
          }),
        );

        expect(costGuardMock.check).toHaveBeenCalledWith(
          'u-1',
          'coverletter_chat',
        );
        expect(events.at(-1)?.type).toBe('done');
      });

      it('done json 에 PII(이메일) 포함 → done json 마스킹 + outputRedacted=true', async () => {
        anthropic.callJsonStream = jest
          .fn()
          .mockImplementation(async function* () {
            yield {
              type: 'done',
              json: { reply: '메일 fake@x.com 로 문의하세요' },
              response: {
                text: 'raw',
                promptTokens: 30,
                completionTokens: 10,
                finishReason: 'tool_use',
              },
            };
          });

        const events = (await collect(
          service.callStream({
            userId: 'u-1',
            feature: 'coverletter_chat',
            systemPrompt: 's',
            userPrompt: 'u',
            jsonSchema: schema,
          }),
        )) as Array<{
          type: string;
          json?: { reply: string };
          outputRedacted?: boolean;
        }>;

        const done = events.at(-1)!;
        expect(done.type).toBe('done');
        expect(done.json?.reply).toContain('[REDACTED_EMAIL]');
        expect(done.json?.reply).not.toContain('fake@x.com');
        expect(done.outputRedacted).toBe(true);
        const okRow = logRepo.save.mock.calls
          .map((c) => c[0] as Partial<LlmCallLog>)
          .find((row) => row.status === 'ok');
        expect(okRow?.outputRedacted).toBe(true);
      });
    });
  });

  // ── 웨이브 C — in-flight lock (코인 차감 feature 동시 중복 진입 차단) ──
  describe('웨이브 C — in-flight lock', () => {
    const OK_RESULT = {
      text: 'ok',
      promptTokens: 10,
      completionTokens: 5,
      finishReason: 'stop',
    };
    const CALL_INPUT = {
      userId: 'u-1',
      feature: 'note_summary' as const,
      systemPrompt: 's',
      userPrompt: 'u',
    };

    it('동시 2요청 → 1 ok + 1 ALREADY_RUNNING (provider 미호출·audit row)', async () => {
      coinServiceMock.chargesCoins.mockResolvedValue(true);
      let resolveProvider!: (v: unknown) => void;
      openai.complete.mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveProvider = (val) => res(val);
          }),
      );
      openai.complete.mockResolvedValue(OK_RESULT);

      const p1 = service.call({ ...CALL_INPUT });
      // p1 이 lock 획득 + provider 진입할 때까지 microtask/macrotask drain
      await new Promise((r) => setImmediate(r));

      const r2 = await service.call({ ...CALL_INPUT });
      expect(r2.status).toBe('blocked_quota');
      expect((r2 as LlmCallBlocked).code).toBe('ALREADY_RUNNING');
      // 두 번째는 provider 미호출 (p1 의 1회만)
      expect(openai.complete).toHaveBeenCalledTimes(1);
      // ALREADY_RUNNING audit row
      const blockedRow = logRepo.save.mock.calls
        .map((c) => c[0] as Partial<LlmCallLog>)
        .find((row) => row.errorMessage?.includes('ALREADY_RUNNING'));
      expect(blockedRow).toBeDefined();
      expect(blockedRow!.status).toBe('blocked_quota');

      resolveProvider(OK_RESULT);
      const r1 = await p1;
      expect(r1.status).toBe('ok');
    });

    it('finally 해제 후 재요청 ok (lock 회수)', async () => {
      coinServiceMock.chargesCoins.mockResolvedValue(true);
      openai.complete.mockResolvedValue(OK_RESULT);
      const r1 = await service.call({ ...CALL_INPUT });
      expect(r1.status).toBe('ok');
      const r2 = await service.call({ ...CALL_INPUT });
      expect(r2.status).toBe('ok');
      expect(openai.complete).toHaveBeenCalledTimes(2);
    });

    it('TTL 2분 초과 항목은 stale 로 회수 (재획득 허용)', async () => {
      coinServiceMock.chargesCoins.mockResolvedValue(true);
      const t0 = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      let resolveFirst!: (v: unknown) => void;
      openai.complete.mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = (val) => res(val);
          }),
      );
      openai.complete.mockResolvedValue(OK_RESULT);

      const p1 = service.call({ ...CALL_INPUT }); // t0 에 lock 획득 (hang)
      await new Promise((r) => setImmediate(r));

      // 2분 초과 경과 → 다음 획득 시도에서 stale 회수
      nowSpy.mockReturnValue(t0 + 2 * 60 * 1000 + 1000);
      const r2 = await service.call({ ...CALL_INPUT });
      expect(r2.status).toBe('ok'); // stale → 재획득 성공

      resolveFirst(OK_RESULT);
      await p1;
      nowSpy.mockRestore();
    });

    it('코인 미차감 feature (chargesCoins=false) → lock 미적용, 동시 2요청 모두 진입', async () => {
      coinServiceMock.chargesCoins.mockResolvedValue(false);
      openai.complete.mockResolvedValue(OK_RESULT);
      const [r1, r2] = await Promise.all([
        service.call({ ...CALL_INPUT }),
        service.call({ ...CALL_INPUT }),
      ]);
      expect(r1.status).toBe('ok');
      expect(r2.status).toBe('ok');
      expect(openai.complete).toHaveBeenCalledTimes(2);
    });

    it('preBlocked 는 lock 대상 아님 (audit-only, chargesCoins 조회 skip)', async () => {
      coinServiceMock.chargesCoins.mockResolvedValue(true);
      const r = await service.call({
        ...CALL_INPUT,
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: '일일 한도 초과',
      });
      expect(r.status).toBe('blocked_quota');
      expect((r as LlmCallBlocked).code).toBeUndefined(); // ALREADY_RUNNING 아님
      expect(coinServiceMock.chargesCoins).not.toHaveBeenCalled();
    });

    it('스트림 — lock 보유 중 동일 user+feature callStream → ALREADY_RUNNING error event + audit', async () => {
      coinServiceMock.chargesCoins.mockResolvedValue(true);
      const schema = {
        name: 'chat',
        schema: { type: 'object', properties: { reply: { type: 'string' } } },
      };
      const collect = async (gen: AsyncGenerator<unknown>) => {
        const events: Array<{ type: string; message?: string }> = [];
        for await (const e of gen) {
          events.push(e as { type: string; message?: string });
        }
        return events;
      };
      let releaseDone!: () => void;
      const donePromise = new Promise<void>((res) => {
        releaseDone = res;
      });
      anthropic.callJsonStream = jest
        .fn()
        .mockImplementation(async function* () {
          yield { type: 'partial', json: { reply: '진행' } };
          await donePromise; // done 전까지 lock 유지
          yield {
            type: 'done',
            json: { reply: '완료' },
            response: {
              text: '{"reply":"완료"}',
              promptTokens: 30,
              completionTokens: 10,
              finishReason: 'tool_use',
            },
          };
        });

      const gen1 = service.callStream({
        userId: 'u-1',
        feature: 'coverletter_chat',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: schema,
      });
      const first = await gen1.next(); // partial — lock 획득 + provider 진입
      expect(first.value).toMatchObject({ type: 'partial' });

      const events2 = await collect(
        service.callStream({
          userId: 'u-1',
          feature: 'coverletter_chat',
          systemPrompt: 's',
          userPrompt: 'u',
          jsonSchema: schema,
        }),
      );
      expect(events2).toEqual([
        { type: 'error', message: '이미 처리 중이에요. 잠시만 기다려 주세요.' },
      ]);
      const blockedRow = logRepo.save.mock.calls
        .map((c) => c[0] as Partial<LlmCallLog>)
        .find((row) => row.errorMessage?.includes('ALREADY_RUNNING'));
      expect(blockedRow).toBeDefined();
      expect(blockedRow!.status).toBe('blocked_quota');

      releaseDone();
      await collect(gen1); // 첫 스트림 완료 → lock 해제
    });
  });
});
