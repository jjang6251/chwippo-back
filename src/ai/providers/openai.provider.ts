import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { LlmProviderName } from '../entities/llm-call-log.entity';
import { temperatureArg } from '../model-registry';
import { findSchemaViolation } from './json-schema-guard';
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
        {
          role: 'user',
          // cachedContext 는 user 앞부분에 — 사용자 입력을 system 권한으로 승격 금지.
          // OpenAI 자동 prefix 캐싱(50% 할인)은 메시지 포함 앞부분 전체에 적용됨
          content: req.cachedContext
            ? `${req.cachedContext}\n\n${req.userPrompt}`
            : req.userPrompt,
        },
      ],
      max_tokens: req.maxTokens,
      ...temperatureArg(req.model, req.temperature),
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
        {
          role: 'user',
          // cachedContext 는 user 앞부분에 — 사용자 입력을 system 권한으로 승격 금지.
          // OpenAI 자동 prefix 캐싱(50% 할인)은 메시지 포함 앞부분 전체에 적용됨
          content: req.cachedContext
            ? `${req.cachedContext}\n\n${req.userPrompt}`
            : req.userPrompt,
        },
      ],
      max_tokens: req.maxTokens,
      ...temperatureArg(req.model, req.temperature),
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
      // 응답은 이미 수신·과금됨 — 실측 usage 동봉 (cost hardening 🔴1)
      throw new LlmJsonParseError(
        this.name,
        res.text,
        err instanceof Error ? err.message : 'unknown JSON parse error',
        {
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          finishReason: res.finishReason, // D0 — 'length' 면 잘림이 실패 원인
        },
      );
    }
    // D0 — 필수 필드 검증. `strict: true` 로도 잘림(finish_reason='length')은 못 막는다.
    //   throw → LlmService 재시도(attempts<2) → 2회 실패 시 status='error' → 코인 미차감.
    const violation = findSchemaViolation(json, req.jsonSchema.schema);
    if (violation) {
      throw new LlmJsonParseError(
        this.name,
        res.text,
        `schema violation — ${violation}`,
        {
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          finishReason: res.finishReason, // D0 — 'length' 면 잘림이 실패 원인
        },
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

    /**
     * G-1 — OpenAI 자동 프롬프트 캐싱 집계.
     *
     * 🔴 **토큰 회계 규약이 provider 마다 반대다.**
     *   - Anthropic: `input_tokens` 는 캐시분을 **제외**한 값 (캐시는 별도 필드)
     *   - OpenAI:    `prompt_tokens` 는 캐시분을 **포함**한 총량
     *
     * 그대로 두 값을 다 보고하면 캐시된 토큰이 **정가로 한 번 + 할인가로 또 한 번**
     * 계산된다. 우리 비용식은 Anthropic 규약(= 서로 겹치지 않음)을 전제하므로,
     * OpenAI 쪽에서 캐시분을 빼서 규약을 맞춘다.
     *
     * 이 변경 전에는 캐시 토큰이 아예 안 보여서 **정가로만 계산**되고 있었다
     * (실제보다 비싸게 기록 → 모델 비교에서 OpenAI 가 불리했다).
     */
    const usage = completion.usage;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const totalPrompt = usage?.prompt_tokens ?? 0;

    return {
      text,
      // 캐시분을 뺀 "정가로 과금되는" 입력 토큰
      promptTokens: Math.max(0, totalPrompt - cachedTokens),
      completionTokens: usage?.completion_tokens ?? 0,
      // OpenAI 는 캐시 쓰기 비용이 없다 (자동·프리미엄 없음) → creation 은 항상 0
      cacheReadTokens: cachedTokens,
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
