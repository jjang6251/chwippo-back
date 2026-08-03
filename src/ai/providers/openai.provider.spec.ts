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
        max_completion_tokens: 300,
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

  /**
   * 🔴 **스트리밍 — Anthropic 과 다른 함정이 하나 있다.**
   *
   * OpenAI 는 `stream_options.include_usage` 를 안 붙이면 **usage 가 아예 안 온다**
   * (실측 2026-08-03: 붙임 → 수신 / 안 붙임 → 전 이벤트에 부재).
   * Anthropic 은 `finalMessage().usage` 가 항상 있어 이 함정이 없다.
   *
   * 빠뜨리면 토큰 0 → **비용 0 · 코인 미차감**. 에러도 안 나고 응답도 정상이라
   * **아무도 모른 채 과금만 사라진다.** 그래서 요청 인자 자체를 spec 으로 박는다.
   */
  /**
   * 🔴 **`max_tokens` 는 gpt-5.6 에서 400 이다** (실측 2026-08-03:
   * `Unsupported parameter: 'max_tokens' is not supported with this model`).
   * gpt-4o 계열은 둘 다 되므로 **새 이름 하나로 통일**했다 — 세 경로가 갈리면
   * "비스트리밍만 되고 스트리밍은 죽는" 식으로 어긋난다.
   */
  describe('출력 한도 파라미터 — 전 경로 통일', () => {
    const okCompletion = {
      choices: [{ message: { content: '{"r":"x"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const SCHEMA_MIN = {
      name: 'a',
      schema: {
        type: 'object',
        properties: { r: { type: 'string' } },
        required: ['r'],
        additionalProperties: false,
      },
    };

    it.each([
      [
        'complete',
        (p: OpenAIProvider) =>
          p.complete({
            model: 'gpt-4o-mini',
            systemPrompt: 's',
            userPrompt: 'u',
            maxTokens: 777,
            temperature: 0.3,
          }),
      ],
      [
        'callJson',
        (p: OpenAIProvider) =>
          p.callJson({
            model: 'gpt-4o-mini',
            systemPrompt: 's',
            userPrompt: 'u',
            maxTokens: 777,
            temperature: 0.3,
            jsonSchema: SCHEMA_MIN,
          }),
      ],
    ])(
      '%s 는 max_completion_tokens 를 쓴다 (max_tokens 금지)',
      async (_l, call) => {
        mockCreate.mockResolvedValue(okCompletion);
        await call(makeProvider());
        const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.max_completion_tokens).toBe(777);
        expect(arg).not.toHaveProperty('max_tokens');
      },
    );
  });

  describe('callJsonStream()', () => {
    const SCHEMA = {
      name: 'chat',
      schema: {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply'],
        additionalProperties: false,
      },
    };
    const REQ_JSON = {
      model: 'gpt-4o-mini',
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 500,
      temperature: 0.3,
      jsonSchema: SCHEMA,
    };

    /** delta 조각 + 마지막 usage chunk 로 SSE 를 흉내낸다 */
    const streamOf = (chunks: string[], usage?: unknown) => ({
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) {
          yield { choices: [{ delta: { content: c } }] };
        }
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        if (usage !== undefined) yield { choices: [], usage };
      },
    });

    const USAGE = {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 40 },
    };

    const collect = async (gen: AsyncGenerator<unknown>) => {
      const out: Array<Record<string, unknown>> = [];
      for await (const e of gen) out.push(e as Record<string, unknown>);
      return out;
    };

    it('🔴 stream_options.include_usage 를 반드시 보낸다 (없으면 과금 0)', async () => {
      mockCreate.mockResolvedValue(streamOf(['{"reply":"hi"}'], USAGE));
      await collect(makeProvider().callJsonStream(REQ_JSON));
      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.stream).toBe(true);
      expect(arg.stream_options).toEqual({ include_usage: true });
    });

    /**
     * cap 이 안 실리면 SDK default 까지 출력돼 **비용 surprise** 가 난다.
     * temperature 는 모델 선언에 따라 조립되므로(`temperatureArg`) 비스트리밍과
     * **같은 규칙**이어야 한다 — 경로마다 다르면 같은 feature 가 다르게 동작한다.
     */
    it('maxTokens·temperature 를 비스트리밍과 같은 규칙으로 전달한다', async () => {
      mockCreate.mockResolvedValue(streamOf(['{"reply":"x"}'], USAGE));
      await collect(makeProvider().callJsonStream(REQ_JSON));
      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.max_completion_tokens).toBe(REQ_JSON.maxTokens);
      expect(arg.temperature).toBe(REQ_JSON.temperature);
      expect(arg.model).toBe(REQ_JSON.model);
      // strict 스키마도 비스트리밍과 동일하게 실려야 한다
      expect(arg.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { strict: true, name: SCHEMA.name },
      });
    });

    /**
     * 🔴 **gpt-5.6 은 temperature 를 기본값 1 외에는 400 으로 거부한다** (실측 2026-08-03).
     * 우리 8개 feature 가 전부 temperature 를 지정하므로, 보내면 **전 호출이 죽는다.**
     * 레지스트리가 `supportsTemperature: false` 로 선언해 아예 안 실리는지 고정한다.
     */
    it('gpt-5.6 에는 temperature 를 아예 싣지 않는다', async () => {
      mockCreate.mockResolvedValue(streamOf(['{"reply":"x"}'], USAGE));
      await collect(
        makeProvider().callJsonStream({ ...REQ_JSON, model: 'gpt-5.6-terra' }),
      );
      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(arg).not.toHaveProperty('temperature');
      expect(arg.model).toBe('gpt-5.6-terra');
    });

    /** 🔴 사용자 입력이 system 으로 승격되면 프롬프트 인젝션 + cap 우회가 동시에 열린다 */
    it('사용자 입력은 user 역할로만 간다 (cachedContext 도 user 앞부분)', async () => {
      mockCreate.mockResolvedValue(streamOf(['{"reply":"x"}'], USAGE));
      await collect(
        makeProvider().callJsonStream({
          ...REQ_JSON,
          cachedContext: 'CACHED',
        }),
      );
      const arg = mockCreate.mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(arg.messages[0]).toEqual({ role: 'system', content: 'sys' });
      expect(arg.messages[0].content).not.toContain('user');
      expect(arg.messages[1].role).toBe('user');
      expect(arg.messages[1].content).toBe('CACHED\n\nuser');
    });

    it('partial 을 조각마다 흘리고 마지막에 done 을 준다', async () => {
      mockCreate.mockResolvedValue(
        streamOf(['{"rep', 'ly":"안', '녕"}'], USAGE),
      );
      const events = await collect(makeProvider().callJsonStream(REQ_JSON));
      const done = events.at(-1)!;
      expect(done.type).toBe('done');
      expect(done.json).toEqual({ reply: '안녕' });
      // 중간 조각들이 partial 로 나갔는지 (파싱 가능한 시점부터)
      expect(events.filter((e) => e.type === 'partial').length).toBeGreaterThan(
        0,
      );
    });

    /** 비스트리밍 경로와 **같은 규약** — 캐시분을 뺀 값이 정가 과금 대상이다 */
    it('캐시 토큰을 prompt 에서 빼서 보고한다 (Anthropic 규약 정렬)', async () => {
      mockCreate.mockResolvedValue(streamOf(['{"reply":"x"}'], USAGE));
      const events = await collect(makeProvider().callJsonStream(REQ_JSON));
      const res = (events.at(-1) as { response: Record<string, number> })
        .response;
      expect(res.promptTokens).toBe(60); // 100 - 40
      expect(res.cacheReadTokens).toBe(40);
      expect(res.completionTokens).toBe(20);
    });

    /** partial 로 화면에 흘러간 뒤라도 최종이 스키마를 어기면 저장·차감으로 못 넘긴다 */
    it('최종 결과가 스키마를 어기면 throw (부분 표시와 무관)', async () => {
      mockCreate.mockResolvedValue(streamOf(['{"wrong":"field"}'], USAGE));
      await expect(
        collect(makeProvider().callJsonStream(REQ_JSON)),
      ).rejects.toThrow(/schema violation/);
    });

    it('JSON 이 깨져 있으면 throw + 실측 usage 동봉 (과금은 이미 발생)', async () => {
      mockCreate.mockResolvedValue(streamOf(['{"reply":'], USAGE));
      await expect(
        collect(makeProvider().callJsonStream(REQ_JSON)),
      ).rejects.toMatchObject({ usage: { promptTokens: 60 } });
    });

    it('usage chunk 가 없어도 크래시하지 않는다 (토큰 0 으로 보고)', async () => {
      mockCreate.mockResolvedValue(streamOf(['{"reply":"x"}']));
      const events = await collect(makeProvider().callJsonStream(REQ_JSON));
      const res = (events.at(-1) as { response: Record<string, number> })
        .response;
      expect(res.promptTokens).toBe(0);
    });

    it('API key 없으면 즉시 실패', async () => {
      await expect(collect(noKey().callJsonStream(REQ_JSON))).rejects.toThrow(
        /OPENAI_API_KEY/,
      );
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
