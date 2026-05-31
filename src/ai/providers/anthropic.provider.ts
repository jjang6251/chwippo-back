import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { parse as parsePartialJson, Allow } from 'partial-json';
import type { LlmProviderName } from '../entities/llm-call-log.entity';
import {
  LlmJsonParseError,
  LlmProvider,
  LlmProviderJsonRequest,
  LlmProviderRequest,
  LlmProviderResponse,
} from './llm-provider.interface';

/**
 * Streaming JSON 응답 event.
 * - partial: chunk 도착마다 누적 buffer 의 partial JSON parse 결과. reply 가 진행 중 partial string.
 * - done: stream 종료. 최종 parse 결과 + token usage.
 */
export type AnthropicStreamEvent<T> =
  | { type: 'partial'; json: Partial<T> }
  | { type: 'done'; json: T; response: LlmProviderResponse };

/**
 * Anthropic Claude provider.
 *
 * **OpenAI 와의 응답 구조 차이 정규화**:
 * - `content` 가 배열 (text/tool_use 블록) — `[{type:'text', text}]` 만 추출
 * - `stop_reason` enum 이 다름 — finishReason 매핑
 * - structured output 은 native JSON schema 없음 → `tool_use` 강제로 schema 보장
 */
@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly name: LlmProviderName = 'anthropic';
  readonly isAvailable: boolean;
  private readonly client: Anthropic | null;
  private readonly logger = new Logger(AnthropicProvider.name);

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({
        apiKey,
        maxRetries: 0, // OpenAI 와 동일 — SDK retry 차단
        // 자소서 chat 의 multi-question 응답 (output ~5000 토큰) 이 30초 초과 가능 → 90초.
        // 향후 streaming 도입 시 (Phase 4) 단일 chunk 대기 무한이므로 이 값 무관.
        timeout: 90_000,
      });
      this.isAvailable = true;
    } else {
      this.client = null;
      this.isAvailable = false;
    }
  }

  async complete(req: LlmProviderRequest): Promise<LlmProviderResponse> {
    this.assertAvailable();
    const message = await this.client!.messages.create({
      model: req.model,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    });
    return this.toResponse(message);
  }

  async callJson<T = unknown>(
    req: LlmProviderJsonRequest,
  ): Promise<LlmProviderResponse & { json: T }> {
    this.assertAvailable();
    // Anthropic 의 structured output 패턴: tool_use 강제
    // 단일 tool 정의 + tool_choice 로 강제 호출 → tool.input 이 JSON schema 매칭 보장
    const toolName = req.jsonSchema.name;

    // Phase 4 단계 B — web_search tool 활성화 (옵션)
    // Anthropic web_search_20250305: allowed_domains 화이트리스트 + max_uses 비용 통제
    // schema tool 과 함께 등록 — Claude 가 검색 후 결과를 structured output 으로 반환
    type AnthropicTool = NonNullable<
      Parameters<Anthropic['messages']['create']>[0]['tools']
    >[number];
    const tools: AnthropicTool[] = [
      {
        name: toolName,
        description: `Structured output schema for ${toolName}`,
        input_schema: req.jsonSchema.schema as Anthropic.Tool.InputSchema,
      },
    ];
    if (req.webSearch) {
      tools.push({
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: req.webSearch.maxUses,
        allowed_domains: [...req.webSearch.allowedDomains],
      } as unknown as AnthropicTool);
    }

    const message = await this.client!.messages.create({
      model: req.model,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      tools,
      // web_search 있으면 tool_choice 강제 안 함 (Claude 가 자율적으로 web_search → schema)
      tool_choice: req.webSearch
        ? { type: 'auto' }
        : { type: 'tool', name: toolName },
    });

    // tool_use 블록 추출 — structured output schema tool 만 (web_search 결과 X)
    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === toolName,
    );
    if (!toolUseBlock) {
      throw new LlmJsonParseError(
        this.name,
        JSON.stringify(message.content),
        'no tool_use block in response',
      );
    }

    const json = toolUseBlock.input as T;
    return {
      ...this.toResponse(message),
      json,
    };
  }

  /**
   * Structured output streaming — Claude 의 tool_use input_json_delta event 를 chunk 단위로 받아
   * partial JSON parse 후 yield. complete 시 final 결과.
   *
   * **사용 예 (caller):**
   * ```ts
   * for await (const event of provider.callJsonStream({...})) {
   *   if (event.type === 'partial') {
   *     // event.json.reply 등 부분 표시 — SSE 로 forward
   *   } else {
   *     // event.json 정식 완성 — DB save + audit
   *   }
   * }
   * ```
   * web_search 는 streaming 에서 미지원 — 호출자가 webSearch 옵션 X 보장.
   */
  async *callJsonStream<T = unknown>(
    req: LlmProviderJsonRequest,
  ): AsyncGenerator<AnthropicStreamEvent<T>> {
    this.assertAvailable();
    const toolName = req.jsonSchema.name;
    type AnthropicTool = NonNullable<
      Parameters<Anthropic['messages']['create']>[0]['tools']
    >[number];
    const tools: AnthropicTool[] = [
      {
        name: toolName,
        description: `Structured output schema for ${toolName}`,
        input_schema: req.jsonSchema.schema as Anthropic.Tool.InputSchema,
      },
    ];

    const stream = this.client!.messages.stream({
      model: req.model,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      tools,
      tool_choice: { type: 'tool', name: toolName },
    });

    let buffer = '';
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'input_json_delta'
      ) {
        buffer += event.delta.partial_json;
        // partial JSON parse — invalid 면 skip (다음 chunk 기다림)
        try {
          const partial = parsePartialJson(buffer, Allow.ALL) as Partial<T>;
          yield { type: 'partial', json: partial };
        } catch {
          // not yet parseable
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    const toolUseBlock = finalMessage.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === toolName,
    );
    if (!toolUseBlock) {
      throw new LlmJsonParseError(
        this.name,
        JSON.stringify(finalMessage.content),
        'no tool_use block in streaming response',
      );
    }
    yield {
      type: 'done',
      json: toolUseBlock.input as T,
      response: this.toResponse(finalMessage),
    };
  }

  private toResponse(message: Anthropic.Message): LlmProviderResponse {
    // text 블록만 추출 (tool_use 블록은 제외)
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    return {
      text,
      promptTokens: message.usage?.input_tokens ?? 0,
      completionTokens: message.usage?.output_tokens ?? 0,
      finishReason: this.mapStopReason(message.stop_reason),
    };
  }

  private mapStopReason(
    stop: Anthropic.Message['stop_reason'],
  ): LlmProviderResponse['finishReason'] {
    switch (stop) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_use';
      case 'stop_sequence':
        return 'stop';
      default:
        return 'other';
    }
  }

  private assertAvailable(): void {
    if (!this.client) {
      throw new Error('ANTHROPIC_API_KEY 미설정');
    }
  }
}
