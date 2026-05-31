import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { LlmProviderName } from '../entities/llm-call-log.entity';
import {
  LlmJsonParseError,
  LlmProvider,
  LlmProviderJsonRequest,
  LlmProviderRequest,
  LlmProviderResponse,
} from './llm-provider.interface';

@Injectable()
export class OpenAIProvider implements LlmProvider {
  readonly name: LlmProviderName = 'openai';
  readonly isAvailable: boolean;
  private readonly client: OpenAI | null;
  private readonly logger = new Logger(OpenAIProvider.name);

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (apiKey) {
      // PR 0 — maxRetries=0 강제: SDK transport retry 차단 (callJson retry 와 곱셈 방지)
      // 면접 질문 생성 등 large output (5000+ 토큰) 응답이 30초 초과 가능 → 90초.
      this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 90_000 });
      this.isAvailable = true;
    } else {
      this.client = null;
      this.isAvailable = false;
    }
  }

  async complete(req: LlmProviderRequest): Promise<LlmProviderResponse> {
    this.assertAvailable();
    const completion = await this.client!.chat.completions.create({
      model: req.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    });
    return this.toResponse(completion);
  }

  async callJson<T = unknown>(
    req: LlmProviderJsonRequest,
  ): Promise<LlmProviderResponse & { json: T }> {
    this.assertAvailable();
    const completion = await this.client!.chat.completions.create({
      model: req.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: req.jsonSchema.name,
          schema: req.jsonSchema.schema,
          strict: true,
        },
      },
    });

    const res = this.toResponse(completion);
    let json: T;
    try {
      json = JSON.parse(res.text) as T;
    } catch (err) {
      throw new LlmJsonParseError(
        this.name,
        res.text,
        err instanceof Error ? err.message : 'unknown JSON parse error',
      );
    }
    return { ...res, json };
  }

  private toResponse(
    completion: OpenAI.Chat.ChatCompletion,
  ): LlmProviderResponse {
    const choice = completion.choices?.[0];
    const text = choice?.message?.content?.trim() ?? '';
    const finish = choice?.finish_reason;
    return {
      text,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      finishReason: this.mapFinishReason(finish),
    };
  }

  private mapFinishReason(
    finish: string | null | undefined,
  ): LlmProviderResponse['finishReason'] {
    switch (finish) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      case 'tool_calls':
        return 'tool_use';
      default:
        return 'other';
    }
  }

  private assertAvailable(): void {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY 미설정');
    }
  }
}
