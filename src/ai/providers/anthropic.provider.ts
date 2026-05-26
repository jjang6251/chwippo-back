import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type { LlmProviderName } from '../entities/llm-call-log.entity';
import {
  LlmJsonParseError,
  LlmProvider,
  LlmProviderJsonRequest,
  LlmProviderRequest,
  LlmProviderResponse,
} from './llm-provider.interface';

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
        timeout: 30_000,
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
    const message = await this.client!.messages.create({
      model: req.model,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      tools: [
        {
          name: toolName,
          description: `Structured output schema for ${toolName}`,
          input_schema: req.jsonSchema.schema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: toolName },
    });

    // tool_use 블록 추출
    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
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
      // tool_use 응답이므로 text 는 빈 문자열 (또는 tool_use 직전 text 블록)
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
