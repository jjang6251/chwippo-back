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

  /**
   * 캐시 breakpoint 2개: system 지침(코드 상수) | user 첫 콘텐츠 블록(cachedContext).
   * ⚠️ cachedContext 는 사용자 입력(문항·답변)을 포함하므로 **절대 system 역할에 넣지 않는다**
   * (prompt injection 방어 원칙 — system 은 코드 상수만). user 콘텐츠 블록에도 cache_control
   * 이 동일하게 작동하므로 캐시 효과는 같고 권한 승격만 제거된다.
   */
  private buildSystemBlocks(req: LlmProviderRequest): Array<{
    type: 'text';
    text: string;
    cache_control: { type: 'ephemeral' };
  }> {
    return [
      {
        type: 'text',
        text: req.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }

  /** user 메시지 콘텐츠 — cachedContext 있으면 [캐시 블록, 변동 블록] 2블록 */
  private buildUserContent(
    req: LlmProviderRequest,
  ):
    | string
    | Array<
        | { type: 'text'; text: string; cache_control: { type: 'ephemeral' } }
        | { type: 'text'; text: string }
      > {
    if (!req.cachedContext) return req.userPrompt;
    return [
      {
        type: 'text',
        text: req.cachedContext,
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: req.userPrompt },
    ];
  }

  async complete(req: LlmProviderRequest): Promise<LlmProviderResponse> {
    this.assertAvailable();
    const message = await this.client!.messages.create({
      model: req.model,
      // PR 보강 — Anthropic prompt caching (system prompt cache_read 90% 할인).
      //   5분 TTL ephemeral. company_research 같은 동일 system prompt 반복 호출 시 input token ↓↓
      system: this.buildSystemBlocks(req),
      messages: [{ role: 'user', content: this.buildUserContent(req) }],
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

    // web_search tool 은 2026-07-09 완전 철거 (CEO 결정 — 회사 조사 = pre-seed 공급으로 전환).
    // structured output schema tool 단일 구성.
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

    const message = await this.client!.messages.create({
      model: req.model,
      // PR 보강 — Anthropic prompt caching (system prompt cache_read 90% 할인).
      //   5분 TTL ephemeral. company_research 같은 동일 system prompt 반복 호출 시 input token ↓↓
      system: this.buildSystemBlocks(req),
      messages: [{ role: 'user', content: this.buildUserContent(req) }],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      tools,
      tool_choice: { type: 'tool', name: toolName },
    });

    // tool_use 블록 추출 — structured output schema tool 만 (web_search 결과 X)
    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === toolName,
    );
    if (!toolUseBlock) {
      // 응답은 이미 수신·과금됨 (web_search 포함) — 실측 usage 동봉 (cost hardening 🔴1)
      const billed = this.toResponse(message);
      throw new LlmJsonParseError(
        this.name,
        JSON.stringify(message.content),
        'no tool_use block in response',
        {
          promptTokens: billed.promptTokens,
          completionTokens: billed.completionTokens,
          cacheCreationTokens: billed.cacheCreationTokens,
          cacheReadTokens: billed.cacheReadTokens,
          webSearchCount: billed.webSearchCount,
        },
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
      // PR 보강 — Anthropic prompt caching (system prompt cache_read 90% 할인).
      //   5분 TTL ephemeral. company_research 같은 동일 system prompt 반복 호출 시 input token ↓↓
      system: this.buildSystemBlocks(req),
      messages: [{ role: 'user', content: this.buildUserContent(req) }],
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
      const billed = this.toResponse(finalMessage);
      throw new LlmJsonParseError(
        this.name,
        JSON.stringify(finalMessage.content),
        'no tool_use block in streaming response',
        {
          promptTokens: billed.promptTokens,
          completionTokens: billed.completionTokens,
          cacheCreationTokens: billed.cacheCreationTokens,
          cacheReadTokens: billed.cacheReadTokens,
          webSearchCount: billed.webSearchCount,
        },
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

    // PR_B1 — usage 전체 필드 정확 추출 (token 계산 critical, 마진 보호)
    const usage = message.usage;
    // server_tool_use 의 web_search_requests 합산. SDK 타입 누락 가능성 대비 unknown cast
    const serverToolUse = (
      usage as unknown as {
        server_tool_use?: { web_search_requests?: number };
      }
    )?.server_tool_use;
    const webSearchCount = serverToolUse?.web_search_requests ?? 0;

    return {
      text,
      promptTokens: usage?.input_tokens ?? 0,
      completionTokens: usage?.output_tokens ?? 0,
      cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      webSearchCount,
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
