import { ConfigService } from '@nestjs/config';
import { LlmJsonParseError } from './llm-provider.interface';
import * as registry from '../model-registry';
import { OpenAIProvider } from './openai.provider';

// OpenAI SDK 전체 mock — constructor 내부 new OpenAI() 가 mockCreate 를 가진 stub 반환
const mockCreate = jest.fn();
const mockOpenAICtor = jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
}));

jest.mock('openai', () => ({
  __esModule: true,
  default: jest
    .fn()
    .mockImplementation((args: unknown) => mockOpenAICtor(args)),
}));

describe('OpenAIProvider', () => {
  const NO_KEY = Symbol('no-key');
  const makeProvider = (
    apiKey: string | undefined | typeof NO_KEY = 'sk-test',
  ): OpenAIProvider => {
    // NO_KEY sentinel — undefined 를 명시 전달하면 default 가 발동되므로 별도 sentinel 사용
    const effective =
      apiKey === NO_KEY ? undefined : (apiKey as string | undefined);
    const config = {
      get: jest.fn((key: string) =>
        key === 'OPENAI_API_KEY' ? effective : undefined,
      ),
    } as unknown as ConfigService;
    return new OpenAIProvider(config);
  };
  const noKey = (): OpenAIProvider => makeProvider(NO_KEY);

  beforeEach(() => {
    mockCreate.mockReset();
    mockOpenAICtor.mockClear();
  });

  describe('isAvailable', () => {
    it('API key 있음 → isAvailable=true + SDK 인스턴스 생성', () => {
      const p = makeProvider('sk-real');
      expect(p.isAvailable).toBe(true);
      expect(mockOpenAICtor).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'sk-real',
          maxRetries: 0,
          timeout: 90_000,
        }),
      );
    });

    it('API key 없음 → isAvailable=false + SDK 생성 안 함', () => {
      const p = noKey();
      expect(p.isAvailable).toBe(false);
      expect(mockOpenAICtor).not.toHaveBeenCalled();
    });

    it('isAvailable=false 상태에서 complete() 호출 → "OPENAI_API_KEY 미설정" 에러', async () => {
      const p = noKey();
      await expect(
        p.complete({
          model: 'gpt-4o-mini',
          systemPrompt: 's',
          userPrompt: 'u',
          maxTokens: 100,
          temperature: 0.3,
        }),
      ).rejects.toThrow('OPENAI_API_KEY 미설정');
    });
  });

  describe('complete()', () => {
    it('정상 응답 → text/promptTokens/completionTokens/finishReason 반환', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          { message: { content: '응답 텍스트' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 50 },
      });
      const p = makeProvider('sk');
      const r = await p.complete({
        model: 'gpt-4o-mini',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 300,
        temperature: 0.5,
      });
      expect(r).toEqual({
        text: '응답 텍스트',
        promptTokens: 120,
        completionTokens: 50,
        // G-1 — 캐시 집계 신설. 캐시가 없으면 0
        cacheReadTokens: 0,
        finishReason: 'stop',
      });
      expect(mockCreate).toHaveBeenCalledWith({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'user' },
        ],
        max_tokens: 300,
        temperature: 0.5,
      });
    });

    it('usage 없음 → tokens=0 안전 처리', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      });
      const p = makeProvider('sk');
      const r = await p.complete({
        model: 'gpt-4o-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 100,
        temperature: 0.3,
      });
      expect(r.promptTokens).toBe(0);
      expect(r.completionTokens).toBe(0);
    });

    it('finish_reason 매핑 (length / content_filter / tool_calls / 그 외)', async () => {
      const cases: Array<[string, string]> = [
        ['stop', 'stop'],
        ['length', 'length'],
        ['content_filter', 'content_filter'],
        ['tool_calls', 'tool_use'],
        ['function_call', 'other'],
      ];
      for (const [raw, mapped] of cases) {
        mockCreate.mockResolvedValueOnce({
          choices: [{ message: { content: 'x' }, finish_reason: raw }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
        const p = makeProvider('sk');
        const r = await p.complete({
          model: 'gpt-4o-mini',
          systemPrompt: 's',
          userPrompt: 'u',
          maxTokens: 10,
          temperature: 0,
        });
        expect(r.finishReason).toBe(mapped);
      }
    });

    it('SDK 에러 → 그대로 throw', async () => {
      mockCreate.mockRejectedValue(new Error('rate limit exceeded'));
      const p = makeProvider('sk');
      await expect(
        p.complete({
          model: 'gpt-4o-mini',
          systemPrompt: 's',
          userPrompt: 'u',
          maxTokens: 10,
          temperature: 0,
        }),
      ).rejects.toThrow('rate limit exceeded');
    });

    it('빈 응답 content → text=""', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 0 },
      });
      const p = makeProvider('sk');
      const r = await p.complete({
        model: 'gpt-4o-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 10,
        temperature: 0,
      });
      expect(r.text).toBe('');
    });
  });

  describe('callJson<T>()', () => {
    const schema = {
      name: 'cover_letter',
      schema: { type: 'object', properties: { paragraphs: { type: 'array' } } },
    };

    it('response_format=json_schema strict=true 로 호출 + JSON 파싱', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: { content: '{"paragraphs":["abc","def"]}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 80, completion_tokens: 30 },
      });
      const p = makeProvider('sk');
      const r = await p.callJson<{ paragraphs: string[] }>({
        model: 'gpt-4o',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 500,
        temperature: 0.5,
        jsonSchema: schema,
      });
      expect(r.json).toEqual({ paragraphs: ['abc', 'def'] });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'cover_letter',
              schema: schema.schema,
              strict: true,
            },
          },
        }),
      );
    });

    it('JSON 파싱 실패 → LlmJsonParseError throw (rawText/reason 포함)', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          { message: { content: '이건 JSON 아님' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const p = makeProvider('sk');
      await expect(
        p.callJson({
          model: 'gpt-4o',
          systemPrompt: 's',
          userPrompt: 'u',
          maxTokens: 100,
          temperature: 0,
          jsonSchema: schema,
        }),
      ).rejects.toBeInstanceOf(LlmJsonParseError);
    });
  });
});

/**
 * G-1 (2026-08-02) — OpenAI 자동 프롬프트 캐싱 집계 + capability 기반 파라미터 조립.
 */
describe('OpenAIProvider — G-1 결합 해체', () => {
  let provider: OpenAIProvider;
  let create: jest.Mock;

  const makeCompletion = (usage: Record<string, unknown>) => ({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage,
  });

  beforeEach(() => {
    provider = new OpenAIProvider({
      get: () => 'test-key',
    } as never);
    create = jest.fn();
    (provider as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };
  });

  const REQ = {
    model: 'gpt-4o-mini',
    systemPrompt: 's',
    userPrompt: 'u',
    maxTokens: 100,
    temperature: 0.3,
  };

  describe('🔴 캐시 토큰 회계 — provider 간 규약 통일', () => {
    /**
     * OpenAI `prompt_tokens` 는 캐시분을 **포함**하고, Anthropic `input_tokens` 는 **제외**한다.
     * 빼주지 않으면 캐시된 토큰이 정가 + 할인가로 **이중 계산**된다.
     */
    it('cached_tokens 를 promptTokens 에서 빼서 보고한다', async () => {
      create.mockResolvedValue(
        makeCompletion({
          prompt_tokens: 10_000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 8_000 },
        }),
      );

      const r = await provider.complete(REQ);

      expect(r.promptTokens).toBe(2_000); // 10,000 − 8,000
      expect(r.cacheReadTokens).toBe(8_000);
      // 두 값을 더하면 원래 총량 — 겹치지 않는다
      expect(r.promptTokens + r.cacheReadTokens!).toBe(10_000);
    });

    it('캐시 필드가 없으면 전액이 정가 입력 (기존 동작)', async () => {
      create.mockResolvedValue(
        makeCompletion({ prompt_tokens: 10_000, completion_tokens: 500 }),
      );

      const r = await provider.complete(REQ);
      expect(r.promptTokens).toBe(10_000);
      expect(r.cacheReadTokens).toBe(0);
    });

    it('전부 캐시여도 음수가 되지 않는다', async () => {
      create.mockResolvedValue(
        makeCompletion({
          prompt_tokens: 5_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 5_000 },
        }),
      );

      const r = await provider.complete(REQ);
      expect(r.promptTokens).toBe(0);
      expect(r.cacheReadTokens).toBe(5_000);
    });
  });

  describe('temperature — 모델 선언에 따라 조립', () => {
    beforeEach(() =>
      create.mockResolvedValue(
        makeCompletion({ prompt_tokens: 1, completion_tokens: 1 }),
      ),
    );

    it('지원 모델이면 전송한다', async () => {
      await provider.complete(REQ);
      expect(create.mock.calls[0][0]).toHaveProperty('temperature', 0.3);
    });

    /**
     * 🔴 이전에는 무조건 실어 보냈다. temperature 를 거부하는 모델을 고르면 400 —
     * 벤치 대상이 그러면 비교 자체가 불가능해진다.
     */
    /**
     * 실제 경로로 검증하려면 `supportsTemperature: false` 인 등록 모델이 필요하다.
     * 현재 4개는 전부 true 라, 테스트 동안만 레지스트리에 넣고 정리한다.
     * (spy 는 안 통한다 — `temperatureArg` 가 같은 모듈 안에서 `getModelSpec` 을 직접 호출)
     */
    const NO_TEMP = 'test-only-no-temperature';
    afterEach(() => {
      delete registry.MODEL_REGISTRY[NO_TEMP];
    });

    it('미지원 모델이면 인자를 아예 넣지 않는다', async () => {
      registry.MODEL_REGISTRY[NO_TEMP] = {
        ...registry.MODEL_REGISTRY['gpt-4o-mini'],
        supportsTemperature: false,
      };

      await provider.complete({ ...REQ, model: NO_TEMP });
      expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
    });

    it('미등록 모델은 기존 동작 유지 (전송) — 갑자기 달라지지 않게', async () => {
      await provider.complete({ ...REQ, model: 'gpt-9-ultra' });
      expect(create.mock.calls[0][0]).toHaveProperty('temperature', 0.3);
    });
  });
});
