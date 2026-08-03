import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { parse as parsePartialJson, Allow } from 'partial-json';
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

/**
 * 스트리밍 이벤트 — Anthropic 쪽 `AnthropicStreamEvent` 와 **같은 모양**이어야 한다.
 * LlmService 가 provider 를 갈아끼우며 같은 루프로 소비하기 때문이다.
 */
export type OpenAiStreamEvent<T> =
  | { type: 'partial'; json: Partial<T> }
  | { type: 'done'; json: T; response: LlmProviderResponse };

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

  /**
   * Structured output streaming — `response_format: json_schema` + `stream: true`.
   * content delta 를 누적해 partial JSON parse 후 yield, 종료 시 최종 결과.
   *
   * **Anthropic 과 다른 점 두 가지** (실측 2026-08-03):
   *
   * 1. 🔴 **`stream_options.include_usage` 없이는 usage 가 아예 안 온다.**
   *    Anthropic 은 스트리밍에도 `finalMessage().usage` 가 항상 있어 이 함정이 없다.
   *    빼먹으면 토큰 0 → **비용 0 · 코인 미차감** 이 되고, 아무 에러도 안 난다.
   *    (실측: 옵션 있음 → usage 수신 / 없음 → 전 이벤트에 usage 부재)
   * 2. delta 가 **평문 JSON 문자열**이다 (Anthropic 은 tool_use `input_json_delta`).
   *
   * web_search 는 streaming 에서 미지원 — 호출자가 webSearch 옵션 X 보장.
   */
  async *callJsonStream<T = unknown>(
    req: LlmProviderJsonRequest,
  ): AsyncGenerator<OpenAiStreamEvent<T>> {
    this.assertAvailable();
    const stream = await this.client!.chat.completions.create({
      model: req.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        {
          role: 'user',
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
      stream: true,
      // 🔴 이 줄이 없으면 과금이 0 으로 기록된다. 위 주석 참조.
      stream_options: { include_usage: true },
    });

    let buffer = '';
    let usage: OpenAI.CompletionUsage | undefined;
    let finishReason: string | null | undefined;

    for await (const chunk of stream) {
      // usage 는 **마지막 chunk 에만** 실려 온다 (choices 가 빈 chunk)
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (!delta) continue;
      buffer += delta;
      try {
        yield {
          type: 'partial',
          json: parsePartialJson(buffer, Allow.ALL) as Partial<T>,
        };
      } catch {
        // 아직 파싱 불가 — 다음 chunk 를 기다린다
      }
    }

    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const response: LlmProviderResponse = {
      text: buffer.trim(),
      // 캐시분 제외 — 비동기 경로와 같은 규약 (toResponse 주석 참조)
      promptTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cachedTokens),
      completionTokens: usage?.completion_tokens ?? 0,
      cacheReadTokens: cachedTokens,
      finishReason: this.mapFinishReason(finishReason),
    };

    let json: T;
    try {
      json = JSON.parse(buffer) as T;
    } catch (err) {
      throw new LlmJsonParseError(
        this.name,
        buffer,
        err instanceof Error ? err.message : 'unknown JSON parse error',
        {
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          cacheReadTokens: response.cacheReadTokens,
          finishReason: response.finishReason,
        },
      );
    }
    // partial parse 로 화면에 흘러간 뒤라도 최종이 스키마를 어기면
    // 저장·차감으로 넘기지 않는다 (Anthropic 스트리밍과 동일 정책).
    const violation = findSchemaViolation(json, req.jsonSchema.schema);
    if (violation) {
      throw new LlmJsonParseError(
        this.name,
        buffer,
        `schema violation — ${violation}`,
        {
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          cacheReadTokens: response.cacheReadTokens,
          finishReason: response.finishReason,
        },
      );
    }

    yield { type: 'done', json, response };
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
