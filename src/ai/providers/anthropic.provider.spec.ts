import { ConfigService } from '@nestjs/config';
import { AnthropicProvider } from './anthropic.provider';
import { LlmJsonParseError } from './llm-provider.interface';

const mockCreate = jest.fn();
const mockAnthropicCtor = jest.fn().mockImplementation(() => ({
  messages: { create: mockCreate },
}));

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest
    .fn()
    .mockImplementation((args: unknown) => mockAnthropicCtor(args)),
}));

describe('AnthropicProvider', () => {
  const NO_KEY = Symbol('no-key');
  const makeProvider = (
    apiKey: string | undefined | typeof NO_KEY = 'sk-ant-test',
  ): AnthropicProvider => {
    const effective =
      apiKey === NO_KEY ? undefined : (apiKey as string | undefined);
    const config = {
      get: jest.fn((key: string) =>
        key === 'ANTHROPIC_API_KEY' ? effective : undefined,
      ),
    } as unknown as ConfigService;
    return new AnthropicProvider(config);
  };
  const noKey = (): AnthropicProvider => makeProvider(NO_KEY);

  beforeEach(() => {
    mockCreate.mockReset();
    mockAnthropicCtor.mockClear();
  });

  describe('isAvailable', () => {
    it('API key 있음 → isAvailable=true + SDK 인스턴스 생성 (maxRetries=0)', () => {
      const p = makeProvider('sk-ant-real');
      expect(p.isAvailable).toBe(true);
      expect(mockAnthropicCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'sk-ant-real',
          maxRetries: 0,
          timeout: 90_000,
        }),
      );
    });

    it('API key 없음 → isAvailable=false', () => {
      const p = noKey();
      expect(p.isAvailable).toBe(false);
      expect(mockAnthropicCtor).not.toHaveBeenCalled();
    });

    it('isAvailable=false 에서 complete() → "ANTHROPIC_API_KEY 미설정" 에러', async () => {
      const p = noKey();
      await expect(
        p.complete({
          model: 'claude-sonnet-4-6',
          systemPrompt: 's',
          userPrompt: 'u',
          maxTokens: 100,
          temperature: 0.3,
        }),
      ).rejects.toThrow('ANTHROPIC_API_KEY 미설정');
    });
  });

  describe('complete()', () => {
    it('정상: content 배열에서 text 블록만 추출 → text 합치기', async () => {
      mockCreate.mockResolvedValue({
        content: [
          { type: 'text', text: '안녕' },
          { type: 'text', text: ' 하세요' },
        ],
        usage: { input_tokens: 30, output_tokens: 10 },
        stop_reason: 'end_turn',
      });
      const p = makeProvider('sk');
      const r = await p.complete({
        model: 'claude-sonnet-4-6',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 500,
        temperature: 0.5,
      });
      expect(r).toEqual({
        text: '안녕 하세요',
        promptTokens: 30,
        completionTokens: 10,
        cacheCreationTokens: 0, // PR_B1 — usage 누락 시 0
        cacheReadTokens: 0,
        webSearchCount: 0,
        finishReason: 'stop',
      });
      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages: [{ role: 'user', content: 'user' }],
        max_tokens: 500,
        temperature: 0.5,
      });
    });

    it('stop_reason 매핑 (end_turn → stop / max_tokens → length / tool_use → tool_use / stop_sequence → stop / 그 외 → other)', async () => {
      const cases: Array<[string, string]> = [
        ['end_turn', 'stop'],
        ['max_tokens', 'length'],
        ['tool_use', 'tool_use'],
        ['stop_sequence', 'stop'],
        ['unknown_reason', 'other'],
      ];
      for (const [raw, mapped] of cases) {
        mockCreate.mockResolvedValueOnce({
          content: [{ type: 'text', text: 'x' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: raw,
        });
        const p = makeProvider('sk');
        const r = await p.complete({
          model: 'claude-sonnet-4-6',
          systemPrompt: 's',
          userPrompt: 'u',
          maxTokens: 10,
          temperature: 0,
        });
        expect(r.finishReason).toBe(mapped);
      }
    });

    it('usage 없음 → tokens=0', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
      });
      const p = makeProvider('sk');
      const r = await p.complete({
        model: 'claude-sonnet-4-6',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 10,
        temperature: 0,
      });
      expect(r.promptTokens).toBe(0);
      expect(r.completionTokens).toBe(0);
    });

    it('SDK 에러 → 그대로 throw', async () => {
      mockCreate.mockRejectedValue(new Error('overloaded_error'));
      const p = makeProvider('sk');
      await expect(
        p.complete({
          model: 'claude-sonnet-4-6',
          systemPrompt: 's',
          userPrompt: 'u',
          maxTokens: 10,
          temperature: 0,
        }),
      ).rejects.toThrow('overloaded_error');
    });
  });

  describe('callJson<T>()', () => {
    const schema = {
      name: 'cover_letter',
      schema: { type: 'object', properties: { paragraphs: { type: 'array' } } },
    };

    it('tool_use 강제 + tool.input 을 json 으로 반환', async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'cover_letter',
            input: { paragraphs: ['abc', 'def'] },
          },
        ],
        usage: { input_tokens: 80, output_tokens: 30 },
        stop_reason: 'tool_use',
      });
      const p = makeProvider('sk');
      const r = await p.callJson<{ paragraphs: string[] }>({
        model: 'claude-sonnet-4-6',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 500,
        temperature: 0.5,
        jsonSchema: schema,
      });
      expect(r.json).toEqual({ paragraphs: ['abc', 'def'] });
      // tool_choice 로 강제 호출 검증
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            expect.objectContaining({
              name: 'cover_letter',
              input_schema: schema.schema,
            }),
          ],
          tool_choice: { type: 'tool', name: 'cover_letter' },
        }),
      );
    });

    it('tool_use 블록 없음 → LlmJsonParseError throw', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'tool 안 씀' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      });
      const p = makeProvider('sk');
      await expect(
        p.callJson({
          model: 'claude-sonnet-4-6',
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
