import { ConfigService } from '@nestjs/config';
import { LlmJsonParseError } from './llm-provider.interface';
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
