import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import {
  LlmCallLog,
  LlmCallStatus,
  LlmFeature,
  LlmProviderName,
} from './entities/llm-call-log.entity';
import { calcCostUsd } from './llm-pricing';
import { getModelConfig } from './model-config';
import { scrubOutputPii, scrubPii } from './pii-scrubber';
import {
  LlmJsonParseError,
  LlmProvider,
  LlmProviderJsonRequest,
} from './providers/llm-provider.interface';
import { OpenAIProvider } from './providers/openai.provider';
import { AnthropicProvider } from './providers/anthropic.provider';

export type LlmModelTier = 'light' | 'heavy'; // deprecated — 호환 유지 (NoteSummaryService 가 인자 안 보냄)

export interface LlmCallInput {
  userId: string;
  feature: LlmFeature;
  /** @deprecated PR 0 — getModelConfig(feature) 로 자동 결정. 무시됨 */
  modelTier?: LlmModelTier;
  systemPrompt: string;
  userPrompt: string;
  /** @deprecated PR 0 — getModelConfig.maxOutputTokens 로 박제. 무시됨 */
  maxTokens?: number;
  /** @deprecated PR 0 — getModelConfig.temperature 로 박제. 무시됨 */
  temperature?: number;
  resourceType?: string;
  resourceId?: string;
  preBlockedStatus?: Extract<
    LlmCallStatus,
    'blocked_moderation' | 'blocked_quota'
  >;
  preBlockedReason?: string;
  /** PR 0 — structured JSON output 필요 시 schema 전달. callJson 경로 활성화 */
  jsonSchema?: LlmProviderJsonRequest['jsonSchema'];
}

export interface LlmCallOk {
  status: 'ok';
  text: string;
  json?: unknown;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  callLogId: string;
  outputRedacted: boolean;
}

export interface LlmCallBlocked {
  status: Extract<
    LlmCallStatus,
    | 'blocked_moderation'
    | 'blocked_quota'
    | 'blocked_consent'
    | 'blocked_input_cap'
    | 'error'
  >;
  text: null;
  errorMessage: string;
  callLogId: string;
}

export type LlmCallResult = LlmCallOk | LlmCallBlocked;

/** input prompt 토큰 추정 (정확한 tiktoken 대신 chars/3 휴리스틱 — 한국어·영문 평균치) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** AI 사용 동의 현재 버전 — 약관 갱신 시 bump 하면 강제 재동의 */
export const CURRENT_AI_CONSENT_VERSION = 'v1';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly providers: Record<LlmProviderName, LlmProvider>;

  constructor(
    private readonly openai: OpenAIProvider,
    private readonly anthropic: AnthropicProvider,
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly config: ConfigService,
  ) {
    this.providers = {
      openai: this.openai,
      anthropic: this.anthropic,
    };
  }

  /**
   * 모든 LLM 호출의 단일 진입점.
   *
   * **흐름** (PR 0):
   * 1. consent gate — ai_consent_at NULL/version 불일치 → `blocked_consent`
   * 2. preBlockedStatus 있으면 audit 만 + 차단 결과 (quota/moderation 사전 차단)
   * 3. getModelConfig(feature) — provider/model/cap 결정
   * 4. PII 스크럽 (system + user prompt) + 사용자 본인 이름 블랙리스트
   * 5. input token cap 체크 — 초과 시 `blocked_input_cap`
   * 6. provider.complete() 또는 callJson() (jsonSchema 있을 시)
   *    - callJson 실패 시 1회 재시도 + `retry_parsing` audit row
   * 7. 응답 PII 역방향 스크럽 → output_redacted flag
   * 8. audit: prompt_hash + prompt_excerpt(200자) + attempts + provider + status
   */
  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const startedAt = Date.now();
    const cfg = getModelConfig(input.feature, this.config);
    const provider = this.providers[cfg.provider];

    // ── 1. preBlockedStatus 분기 (quota/moderation 사전 차단) ──
    // consent gate 보다 우선 — preBlocked 가 명시되면 그대로 audit (caller 가 결정한 상태)
    if (input.preBlockedStatus) {
      return this.savePreBlocked(input, cfg.model, cfg.provider);
    }

    // ── 2. consent gate ──
    const consentResult = await this.checkConsent(input.userId);
    if (consentResult) {
      return this.saveBlocked(
        input,
        cfg.model,
        cfg.provider,
        'blocked_consent',
        consentResult,
        startedAt,
      );
    }

    // ── 3. provider 가용성 ──
    if (!provider.isAvailable) {
      const errMsg = `${cfg.provider.toUpperCase()}_API_KEY 미설정`;
      return this.saveBlocked(
        input,
        cfg.model,
        cfg.provider,
        'error',
        errMsg,
        startedAt,
      );
    }

    // ── 4. 사용자 본인 이름 블랙리스트 + PII 스크럽 ──
    const blacklistedNames = await this.getUserNameBlacklist(input.userId);
    const scrubbedSystem = scrubPii(input.systemPrompt, { blacklistedNames });
    const scrubbedUser = scrubPii(input.userPrompt, { blacklistedNames });
    const systemPrompt = scrubbedSystem.text;
    const userPrompt = scrubbedUser.text;

    // ── 5. input token cap ──
    const inputTokensEst =
      estimateTokens(systemPrompt) + estimateTokens(userPrompt);
    if (inputTokensEst > cfg.maxInputTokens) {
      const errMsg = `입력 토큰 ${inputTokensEst} 초과 (한도 ${cfg.maxInputTokens})`;
      return this.saveBlocked(
        input,
        cfg.model,
        cfg.provider,
        'blocked_input_cap',
        errMsg,
        startedAt,
      );
    }

    // ── 6. provider 호출 (jsonSchema 있으면 callJson, 없으면 complete) ──
    const promptHash = this.hashPrompt(systemPrompt, userPrompt);
    const promptExcerpt = userPrompt.slice(0, 200);

    let attempts = 0;
    let lastJsonParseError: LlmJsonParseError | null = null;

    while (attempts < 2) {
      attempts++;
      try {
        let result: {
          text: string;
          promptTokens: number;
          completionTokens: number;
          json?: unknown;
        };
        if (input.jsonSchema) {
          result = await provider.callJson({
            model: cfg.model,
            systemPrompt,
            userPrompt,
            maxTokens: cfg.maxOutputTokens,
            temperature: cfg.temperature,
            jsonSchema: input.jsonSchema,
          });
        } else {
          result = await provider.complete({
            model: cfg.model,
            systemPrompt,
            userPrompt,
            maxTokens: cfg.maxOutputTokens,
            temperature: cfg.temperature,
          });
        }

        // ── 7. 응답 PII 역방향 스크럼 (hallucination 차단) ──
        const outputScrub = scrubOutputPii(result.text);
        const finalText = outputScrub.text;

        // ── 8. audit + return ──
        const costUsd = calcCostUsd(
          cfg.model,
          result.promptTokens,
          result.completionTokens,
        );
        const latencyMs = Date.now() - startedAt;

        // 이전 시도가 retry_parsing 이었으면 그 row 도 별도 저장 (audit 분리)
        if (attempts > 1 && lastJsonParseError) {
          await this.saveAudit({
            input,
            model: cfg.model,
            provider: cfg.provider,
            promptHash,
            promptExcerpt,
            status: 'retry_parsing',
            errorMessage: lastJsonParseError.reason,
            promptTokens: 0,
            completionTokens: 0,
            costUsd: '0',
            latencyMs: 0,
            outputRedacted: false,
            attempts: 1,
          });
        }

        const log = await this.saveAudit({
          input,
          model: cfg.model,
          provider: cfg.provider,
          promptHash,
          promptExcerpt,
          status: 'ok',
          errorMessage: null,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costUsd: costUsd.toString(),
          latencyMs,
          outputRedacted: outputScrub.hasPii,
          attempts,
        });

        return {
          status: 'ok',
          text: finalText,
          json: result.json,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costUsd,
          latencyMs,
          callLogId: log.id,
          outputRedacted: outputScrub.hasPii,
        };
      } catch (err) {
        if (err instanceof LlmJsonParseError && attempts < 2) {
          // parsing 실패 — 1회 재시도 (audit row 는 성공 시 함께 저장)
          lastJsonParseError = err;
          this.logger.warn(
            `JSON parse failed (feature=${input.feature}, provider=${cfg.provider}, attempt=${attempts}), retrying...`,
          );
          continue;
        }

        const message =
          err instanceof Error ? err.message : 'unknown provider error';
        this.logger.error(
          `LLM call failed (feature=${input.feature}, provider=${cfg.provider}): ${message}`,
        );
        const log = await this.saveAudit({
          input,
          model: cfg.model,
          provider: cfg.provider,
          promptHash,
          promptExcerpt,
          status: 'error',
          errorMessage: message,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: '0',
          latencyMs: Date.now() - startedAt,
          outputRedacted: false,
          attempts,
        });
        return {
          status: 'error',
          text: null,
          errorMessage: message,
          callLogId: log.id,
        };
      }
    }
    // 도달 불가 (while attempts<2 안에서 항상 return 또는 throw)
    throw new Error('LlmService.call unreachable');
  }

  // ── private helpers ──

  /**
   * AI 사용 동의 체크 — NULL 또는 version 불일치면 차단 사유 반환.
   * 동의 OK 면 null 반환.
   */
  private async checkConsent(userId: string): Promise<string | null> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'aiConsentAt', 'aiConsentVersion'],
    });
    if (!user) return '사용자를 찾을 수 없습니다.';
    if (!user.aiConsentAt) {
      return 'AI 사용 동의가 필요합니다. (개인정보 외부 처리 위탁)';
    }
    if (user.aiConsentVersion !== CURRENT_AI_CONSENT_VERSION) {
      return `약관이 갱신됐어요. 다시 동의해 주세요. (현재: ${CURRENT_AI_CONSENT_VERSION})`;
    }
    return null;
  }

  /** 사용자 본인 nickname (User entity 의 nickname 컬럼) — PII 블랙리스트 */
  private async getUserNameBlacklist(userId: string): Promise<string[]> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'nickname'],
    });
    if (!user?.nickname) return [];
    return [user.nickname];
  }

  private hashPrompt(systemPrompt: string, userPrompt: string): string {
    return createHash('sha256')
      .update(`${systemPrompt}\n---\n${userPrompt}`)
      .digest('hex');
  }

  private async savePreBlocked(
    input: LlmCallInput,
    model: string,
    provider: LlmProviderName,
  ): Promise<LlmCallBlocked> {
    const log = await this.saveAudit({
      input,
      model,
      provider,
      promptHash: null,
      promptExcerpt: null,
      status: input.preBlockedStatus!,
      errorMessage: input.preBlockedReason ?? null,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: '0',
      latencyMs: 0,
      outputRedacted: false,
      attempts: 1,
    });
    return {
      status: input.preBlockedStatus!,
      text: null,
      errorMessage: input.preBlockedReason ?? input.preBlockedStatus!,
      callLogId: log.id,
    };
  }

  private async saveBlocked(
    input: LlmCallInput,
    model: string,
    provider: LlmProviderName,
    status: Extract<
      LlmCallStatus,
      'blocked_consent' | 'blocked_input_cap' | 'error'
    >,
    errorMessage: string,
    startedAt: number,
  ): Promise<LlmCallBlocked> {
    const log = await this.saveAudit({
      input,
      model,
      provider,
      promptHash: null,
      promptExcerpt: null,
      status,
      errorMessage,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: '0',
      latencyMs: Date.now() - startedAt,
      outputRedacted: false,
      attempts: 1,
    });
    return {
      status,
      text: null,
      errorMessage,
      callLogId: log.id,
    };
  }

  private async saveAudit(args: {
    input: LlmCallInput;
    model: string;
    provider: LlmProviderName;
    promptHash: string | null;
    promptExcerpt: string | null;
    status: LlmCallStatus;
    errorMessage: string | null;
    promptTokens: number;
    completionTokens: number;
    costUsd: string;
    latencyMs: number;
    outputRedacted: boolean;
    attempts: number;
  }): Promise<LlmCallLog> {
    return this.logRepo.save(
      this.logRepo.create({
        userId: args.input.userId,
        feature: args.input.feature,
        provider: args.provider,
        model: args.model,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        costUsd: args.costUsd,
        latencyMs: args.latencyMs,
        status: args.status,
        errorMessage: args.errorMessage,
        resourceType: args.input.resourceType ?? null,
        resourceId: args.input.resourceId ?? null,
        promptHash: args.promptHash,
        promptExcerpt: args.promptExcerpt,
        outputRedacted: args.outputRedacted,
        attempts: args.attempts,
      }),
    );
  }
}
