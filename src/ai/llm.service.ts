import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type OpenAI from 'openai';
import { Repository } from 'typeorm';
import { LlmCallLog, LlmFeature, LlmCallStatus } from './entities/llm-call-log.entity';
import { OPENAI_CLIENT } from './openai-client.provider';
import { calcCostUsd } from './llm-pricing';

export type LlmModelTier = 'light' | 'heavy';

export interface LlmCallInput {
  userId: string;
  feature: LlmFeature;
  modelTier?: LlmModelTier;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  resourceType?: string;
  resourceId?: string;
  preBlockedStatus?: Extract<
    LlmCallStatus,
    'blocked_moderation' | 'blocked_quota'
  >;
  preBlockedReason?: string;
}

export interface LlmCallOk {
  status: 'ok';
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  callLogId: string;
}

export interface LlmCallBlocked {
  status: 'blocked_moderation' | 'blocked_quota' | 'error';
  text: null;
  errorMessage: string;
  callLogId: string;
}

export type LlmCallResult = LlmCallOk | LlmCallBlocked;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(OPENAI_CLIENT) private readonly openai: OpenAI | null,
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
    private readonly config: ConfigService,
  ) {}

  private resolveModel(tier: LlmModelTier = 'light'): string {
    if (tier === 'heavy') {
      return this.config.get<string>('OPENAI_MODEL_HEAVY') ?? 'gpt-4o';
    }
    return this.config.get<string>('OPENAI_MODEL_LIGHT') ?? 'gpt-4o-mini';
  }

  /**
   * 모든 AI 호출의 단일 진입점.
   * - preBlockedStatus 가 주어지면 OpenAI 호출 없이 audit 만 기록하고 차단 결과 반환
   *   (호출 측에서 quota/moderation 결정 후 위임)
   * - 그 외에는 OpenAI chat completion 호출 + 토큰·비용·latency 측정 후 audit
   * - 실패 시도 status='error' 로 기록
   */
  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const model = this.resolveModel(input.modelTier);
    const startedAt = Date.now();

    if (input.preBlockedStatus) {
      const log = await this.logRepo.save(
        this.logRepo.create({
          userId: input.userId,
          feature: input.feature,
          model,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: '0',
          latencyMs: 0,
          status: input.preBlockedStatus,
          errorMessage: input.preBlockedReason ?? null,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
        }),
      );
      return {
        status: input.preBlockedStatus,
        text: null,
        errorMessage: input.preBlockedReason ?? input.preBlockedStatus,
        callLogId: log.id,
      };
    }

    if (!this.openai) {
      const log = await this.logRepo.save(
        this.logRepo.create({
          userId: input.userId,
          feature: input.feature,
          model,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: '0',
          latencyMs: Date.now() - startedAt,
          status: 'error',
          errorMessage: 'OPENAI_API_KEY 미설정',
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
        }),
      );
      return {
        status: 'error',
        text: null,
        errorMessage: 'OPENAI_API_KEY 미설정',
        callLogId: log.id,
      };
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
        max_tokens: input.maxTokens ?? 512,
        temperature: input.temperature ?? 0.3,
      });

      const text = completion.choices?.[0]?.message?.content?.trim() ?? '';
      const promptTokens = completion.usage?.prompt_tokens ?? 0;
      const completionTokens = completion.usage?.completion_tokens ?? 0;
      const costUsd = calcCostUsd(model, promptTokens, completionTokens);
      const latencyMs = Date.now() - startedAt;

      const log = await this.logRepo.save(
        this.logRepo.create({
          userId: input.userId,
          feature: input.feature,
          model,
          promptTokens,
          completionTokens,
          costUsd: costUsd.toString(),
          latencyMs,
          status: 'ok',
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
        }),
      );

      return {
        status: 'ok',
        text,
        promptTokens,
        completionTokens,
        costUsd,
        latencyMs,
        callLogId: log.id,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'unknown OpenAI error';
      this.logger.error(`LLM call failed (feature=${input.feature}): ${message}`);
      const log = await this.logRepo.save(
        this.logRepo.create({
          userId: input.userId,
          feature: input.feature,
          model,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: '0',
          latencyMs: Date.now() - startedAt,
          status: 'error',
          errorMessage: message,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
        }),
      );
      return {
        status: 'error',
        text: null,
        errorMessage: message,
        callLogId: log.id,
      };
    }
  }
}
