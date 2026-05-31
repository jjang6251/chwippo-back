import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { CURRENT_AI_CONSENT_VERSION, LlmService } from './llm.service';
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
  };
  let openai: MutableProvider;
  let anthropic: MutableProvider;

  const makeUser = (overrides: Partial<User> = {}): User => ({
    id: 'u-1',
    kakaoId: 'k-1',
    nickname: '장성원',
    email: null,
    refreshToken: null,
    role: 'user',
    createdAt: new Date(),
    lastActiveAt: null,
    termsAgreedAt: new Date(),
    dashboardConfig: null,
    onboardedAt: new Date(),
    suspendedAt: null,
    aiConsentAt: new Date(),
    aiConsentVersion: CURRENT_AI_CONSENT_VERSION,
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmService,
        { provide: OpenAIProvider, useValue: openai },
        { provide: AnthropicProvider, useValue: anthropic },
        { provide: getRepositoryToken(LlmCallLog), useValue: mockLogRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: ConfigService, useValue: config },
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
      anthropic.isAvailable = false; // company_research = anthropic provider
      const r = await service.call({
        userId: 'u-1',
        feature: 'company_research',
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
      // mock-llm-responses 가 company_research feature 일 때 json 객체 반환
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
});
