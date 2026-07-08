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
import { CoinService } from './coin.service';
import { CostGuardService } from './cost-guard.service';
import { calcCostUsd } from './llm-pricing';
import { buildMockLlmResponse } from './mock-llm-responses';
import { getFallbackConfig, getModelConfig } from './model-config';
import { scrubJsonOutputPii, scrubOutputPii, scrubPii } from './pii-scrubber';
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
  /** 프롬프트 캐시 세그먼트 — 턴 간 불변 블록 (조사·문항 등). PII 스크럽·토큰 캡·해시 모두 포함됨 */
  cachedContext?: string;
  userPrompt: string;
  /** @deprecated PR 0 — getModelConfig.maxOutputTokens 로 박제. 무시됨 */
  maxTokens?: number;
  /** @deprecated PR 0 — getModelConfig.temperature 로 박제. 무시됨 */
  temperature?: number;
  resourceType?: string;
  resourceId?: string;
  preBlockedStatus?: Extract<
    LlmCallStatus,
    'blocked_moderation' | 'blocked_quota' | 'blocked_cost_quota'
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
  /** PR Phase 3 — 1차 provider 실패 후 fallback provider 로 retry 성공한 경우 true */
  wasFallback?: boolean;
  /** PR_B1 — Anthropic prompt cache write 토큰 */
  cacheCreationTokens?: number;
  /** PR_B1 — Anthropic prompt cache hit 토큰 (90% 할인) */
  cacheReadTokens?: number;
  /** PR_B1 — Anthropic web_search tool 사용 횟수 */
  webSearchCount?: number;
  /** PR_B1 — 차감된 코인 (0 = 차감 X — charges_coins=false 또는 COIN_SYSTEM_ENABLED=false) */
  coinCost?: number;
}

/**
 * PR Phase 4 — Streaming JSON call 의 chunk event (Anthropic tool_use 전용).
 * - 'partial': chunk 도착 시. json 은 buffer 누적의 partial parse 결과 (예: { reply: "안녕..." } 진행 중)
 * - 'done': stream 종료. final json + audit row 저장 후 callLogId 포함
 * - 'error': provider 실패. error message
 */
export type LlmStreamEvent<T = unknown> =
  | { type: 'partial'; json: Partial<T> }
  | {
      type: 'done';
      json: T;
      text: string;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      latencyMs: number;
      callLogId: string;
      outputRedacted: boolean;
    }
  | { type: 'error'; message: string };

export interface LlmCallBlocked {
  status: Extract<
    LlmCallStatus,
    | 'blocked_moderation'
    | 'blocked_quota'
    | 'blocked_cost_quota'
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
  // 'mock' 은 LlmProviderName union 에 있으나 실제 provider 객체 없음 (mock 분기는 buildMockLlmResponse 가 처리).
  // FEATURE_MATRIX 는 cfg.provider 로 mock 반환 안 함 → providers map 은 real 2개만.
  private readonly providers: Record<'openai' | 'anthropic', LlmProvider>;

  constructor(
    private readonly openai: OpenAIProvider,
    private readonly anthropic: AnthropicProvider,
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly config: ConfigService,
    private readonly coinService: CoinService, // PR_B1 — canCharge + charge
    private readonly costGuard: CostGuardService, // AI cost guard — per-user/per-feature daily USD cap
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
    if (cfg.provider === 'mock') {
      throw new Error(
        `getModelConfig 가 cfg.provider='mock' 반환 — FEATURE_MATRIX 점검 필요 (feature=${input.feature})`,
      );
    }
    const provider = this.providers[cfg.provider];

    // ── 0. Phase 4 dev-only mock — 모든 gate 우회 (UI 테스트 전용) ──
    // 조건: NODE_ENV === 'development' + API key 미설정 + preBlocked 아님
    // 의도: 동의·quota·moderation 전부 skip 하고 UI 흐름 통째로 테스트.
    // 안전장치: production 환경에선 key 빠져도 mock 안 나감 (사용자에게 가짜 답변 노출 차단).
    if (
      !input.preBlockedStatus &&
      process.env.NODE_ENV === 'development' &&
      !provider.isAvailable
    ) {
      this.logger.warn(
        `[MOCK MODE] ${cfg.provider}.${cfg.model} 호출 (feature=${input.feature}) — API key 미설정, 모든 gate 우회. 실제 호출 원하면 .env 에 ${cfg.provider.toUpperCase()}_API_KEY 추가 후 재시작.`,
      );
      const mock = buildMockLlmResponse(input.feature, !!input.jsonSchema);
      // audit row insert — provider='mock', costUsd=0 (실제 LLM 미호출이지만 감사 가시화 필수)
      const log = await this.saveAudit({
        input,
        model: cfg.model,
        provider: 'mock',
        promptHash: null,
        promptExcerpt: null,
        status: 'ok',
        errorMessage: null,
        promptTokens: mock.promptTokens,
        completionTokens: mock.completionTokens,
        costUsd: '0',
        latencyMs: 0,
        outputRedacted: false,
        attempts: 1,
      });
      return {
        status: 'ok',
        text: mock.text,
        json: mock.json,
        promptTokens: mock.promptTokens,
        completionTokens: mock.completionTokens,
        costUsd: 0,
        latencyMs: 0,
        callLogId: log.id,
        outputRedacted: false,
      };
    }

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

    // ── 2.5. PR_B1 — 코인 잔여 추정 check (평균 × 1.2 잔여 ≥ 진행) ──
    //   COIN_SYSTEM_ENABLED=false 또는 charges_coins=false feature → 항상 통과
    const coinCheck = await this.coinService.canCharge(
      input.userId,
      input.feature,
    );
    if (!coinCheck.ok) {
      return this.saveBlocked(
        input,
        cfg.model,
        cfg.provider,
        'blocked_quota',
        coinCheck.reason ?? '코인이 부족해요',
        startedAt,
      );
    }

    // ── 2.7. AI cost guard — per-user / per-feature daily USD cap ──
    //   코인 차단 외 hard USD cap. 모델 비용이 예상보다 비싸지면 코인 부족 가드만으로 부족.
    //   alert_thresholds 단일 row 미설정 또는 enabled=false → guard skip (kill switch)
    const costGuardResult = await this.costGuard.check(
      input.userId,
      input.feature,
    );
    if (costGuardResult.blocked) {
      return this.saveBlocked(
        input,
        cfg.model,
        cfg.provider,
        'blocked_cost_quota',
        costGuardResult.reason,
        startedAt,
      );
    }

    // ── 3. provider 가용성 ──
    // (dev mock 은 위 0단계에서 이미 처리. 여기 도달 = prod/test 또는 preBlocked 케이스)
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
    const scrubbedCached = input.cachedContext
      ? scrubPii(input.cachedContext, { blacklistedNames })
      : null;
    const systemPrompt = scrubbedSystem.text;
    const userPrompt = scrubbedUser.text;
    const cachedContext = scrubbedCached?.text;

    // ── 5. input token cap (캐시 세그먼트 포함 — 캐시돼도 첫 호출은 정가) ──
    const inputTokensEst =
      estimateTokens(systemPrompt) +
      estimateTokens(userPrompt) +
      (cachedContext ? estimateTokens(cachedContext) : 0);
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
    const promptHash = this.hashPrompt(
      systemPrompt + (cachedContext ?? ''),
      userPrompt,
    );
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
          cacheCreationTokens?: number;
          cacheReadTokens?: number;
          webSearchCount?: number;
          json?: unknown;
        };
        if (input.jsonSchema) {
          result = await provider.callJson({
            model: cfg.model,
            systemPrompt,
            cachedContext,
            userPrompt,
            maxTokens: cfg.maxOutputTokens,
            temperature: cfg.temperature,
            jsonSchema: input.jsonSchema,
          });
        } else {
          result = await provider.complete({
            model: cfg.model,
            systemPrompt,
            cachedContext,
            userPrompt,
            maxTokens: cfg.maxOutputTokens,
            temperature: cfg.temperature,
          });
        }

        // ── 7. 응답 PII 역방향 스크럼 (hallucination 차단) ──
        // text 채널 + 구조화 json 채널 모두 스크럽. json 은 DB 저장 경로
        // (chat suggestedUpdates·심층 점검 lastFeedback 등)가 있어 동일 방어 필요.
        const outputScrub = scrubOutputPii(result.text);
        const jsonScrub =
          result.json !== undefined
            ? scrubJsonOutputPii(result.json)
            : { value: undefined, hasPii: false };
        const finalText = outputScrub.text;
        const finalJson = jsonScrub.value;
        const outputRedacted = outputScrub.hasPii || jsonScrub.hasPii;

        // ── 8. audit + return ──
        const costUsd = calcCostUsd(
          cfg.model,
          result.promptTokens,
          result.completionTokens,
          {
            cacheCreationTokens: result.cacheCreationTokens,
            cacheReadTokens: result.cacheReadTokens,
            webSearchCount: result.webSearchCount,
          },
        );
        const latencyMs = Date.now() - startedAt;

        // 이전 시도가 retry_parsing 이었으면 그 row 도 별도 저장 (audit 분리)
        if (attempts > 1 && lastJsonParseError) {
          // cost hardening 🔴1 — parse 실패도 provider 는 전액 과금.
          // 실측 usage 기록 (cost guard·quota·admin 추적이 실패 비용을 보게)
          const failedUsage = lastJsonParseError.usage;
          await this.saveAudit({
            input,
            model: cfg.model,
            provider: cfg.provider,
            promptHash,
            promptExcerpt,
            status: 'retry_parsing',
            errorMessage: lastJsonParseError.reason,
            promptTokens: failedUsage?.promptTokens ?? 0,
            completionTokens: failedUsage?.completionTokens ?? 0,
            costUsd: failedUsage
              ? String(
                  calcCostUsd(
                    cfg.model,
                    failedUsage.promptTokens,
                    failedUsage.completionTokens,
                    {
                      cacheCreationTokens: failedUsage.cacheCreationTokens,
                      cacheReadTokens: failedUsage.cacheReadTokens,
                      webSearchCount: failedUsage.webSearchCount,
                    },
                  ),
                )
              : '0',
            latencyMs: 0,
            outputRedacted: false,
            attempts: 1,
          });
        }

        // ── 8.5. PR_B1 — 코인 차감 (status='ok' 만) ──
        const chargeResult = await this.coinService.charge(
          input.userId,
          input.feature,
          {
            inputTokens: result.promptTokens,
            outputTokens: result.completionTokens,
            cacheCreationTokens: result.cacheCreationTokens,
            cacheReadTokens: result.cacheReadTokens,
            webSearchCount: result.webSearchCount,
          },
        );

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
          cacheCreationTokens: result.cacheCreationTokens ?? 0,
          cacheReadTokens: result.cacheReadTokens ?? 0,
          webSearchCount: result.webSearchCount ?? 0,
          coinCost: chargeResult.coinCost.toString(),
          costBreakdown: chargeResult.breakdown,
          costUsd: costUsd.toString(),
          latencyMs,
          outputRedacted,
          attempts,
        });

        return {
          status: 'ok',
          text: finalText,
          json: finalJson,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          cacheReadTokens: result.cacheReadTokens,
          webSearchCount: result.webSearchCount,
          coinCost: chargeResult.coinCost,
          costUsd,
          latencyMs,
          callLogId: log.id,
          outputRedacted,
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

        // === PR Phase 3 — fallback provider retry ===
        // 5xx · timeout · network error 만 fallback. 429/400/401/403 은 fallback X (비용·버그·인증 문제).
        // cost hardening 🟡2 — JsonParseError 도 fallback X: 이미 유료 응답 2회를
        // 받은 뒤의 형식 문제라, 3번째 유료 호출로 이어지면 요청 1건 = 과금 3건.
        const errStatus = (err as { status?: number })?.status;
        const isRecoverable =
          !(err instanceof LlmJsonParseError) &&
          (!errStatus ||
            errStatus >= 500 ||
            errStatus === 408 ||
            /timeout/i.test(message));
        const fallbackCfg = getFallbackConfig(cfg, this.config);
        if (isRecoverable && fallbackCfg) {
          const fbProvider =
            this.providers[fallbackCfg.provider as 'openai' | 'anthropic'];
          if (fbProvider?.isAvailable) {
            // 1차 실패 audit row 먼저 저장 (관측성).
            // 5xx/timeout 은 응답 자체가 없어 usage 0 이 실측값 (cost hardening 🔴1 주석)
            await this.saveAudit({
              input,
              model: cfg.model,
              provider: cfg.provider,
              promptHash,
              promptExcerpt,
              status: 'error',
              errorMessage: `[FALLBACK_TRIGGERED] ${message}`,
              promptTokens: 0,
              completionTokens: 0,
              costUsd: '0',
              latencyMs: Date.now() - startedAt,
              outputRedacted: false,
              attempts,
            });
            try {
              this.logger.warn(
                `Fallback ${cfg.provider} → ${fallbackCfg.provider} (feature=${input.feature})`,
              );
              const fbStart = Date.now();
              let fbResult: {
                text: string;
                promptTokens: number;
                completionTokens: number;
                json?: unknown;
              };
              if (input.jsonSchema) {
                fbResult = await fbProvider.callJson({
                  model: fallbackCfg.model,
                  systemPrompt,
                  cachedContext,
                  userPrompt,
                  maxTokens: cfg.maxOutputTokens,
                  temperature: cfg.temperature,
                  jsonSchema: input.jsonSchema,
                });
              } else {
                fbResult = await fbProvider.complete({
                  model: fallbackCfg.model,
                  systemPrompt,
                  cachedContext,
                  userPrompt,
                  maxTokens: cfg.maxOutputTokens,
                  temperature: cfg.temperature,
                });
              }
              const fbScrub = scrubOutputPii(fbResult.text);
              const fbJsonScrub =
                fbResult.json !== undefined
                  ? scrubJsonOutputPii(fbResult.json)
                  : { value: undefined, hasPii: false };
              const fbOutputRedacted = fbScrub.hasPii || fbJsonScrub.hasPii;
              const fbCost = calcCostUsd(
                fallbackCfg.model,
                fbResult.promptTokens,
                fbResult.completionTokens,
              );
              const fbLatency = Date.now() - fbStart;

              // PR_B1c CTO 검토 C1 — fallback 도 코인 차감 (silent leak 차단).
              //   정상 경로 (line 354) 만 charge → fallback 분기에서 빠져있었음.
              //   fixed_coin_cost feature 면 token 무관 차감 (company_research = 50).
              const fbChargeResult = await this.coinService.charge(
                input.userId,
                input.feature,
                {
                  inputTokens: fbResult.promptTokens,
                  outputTokens: fbResult.completionTokens,
                  // fallback (openai) 는 cache_creation·cache_read·web_search 없음
                },
              );

              const fbLog = await this.saveAudit({
                input,
                model: fallbackCfg.model,
                provider: fallbackCfg.provider,
                promptHash,
                promptExcerpt,
                status: 'ok',
                errorMessage: `[FALLBACK_FROM:${cfg.provider}]`,
                promptTokens: fbResult.promptTokens,
                completionTokens: fbResult.completionTokens,
                costUsd: fbCost.toString(),
                latencyMs: fbLatency,
                outputRedacted: fbOutputRedacted,
                attempts: attempts + 1,
                coinCost: fbChargeResult.coinCost.toString(),
                costBreakdown: fbChargeResult.breakdown,
              });
              return {
                status: 'ok',
                text: fbScrub.text,
                json: fbJsonScrub.value,
                promptTokens: fbResult.promptTokens,
                completionTokens: fbResult.completionTokens,
                coinCost: fbChargeResult.coinCost,
                costUsd: fbCost,
                latencyMs: fbLatency,
                callLogId: fbLog.id,
                outputRedacted: fbOutputRedacted,
                wasFallback: true,
              };
            } catch (fbErr) {
              const fbMsg =
                fbErr instanceof Error ? fbErr.message : 'fallback unknown';
              this.logger.error(
                `Fallback ALSO failed (${fallbackCfg.provider}): ${fbMsg}`,
              );
              // 양쪽 다 실패 → 원래 error path 로 (아래 saveAudit + return)
            }
          }
        }
        // === end fallback ===

        // cost hardening 🔴1 — parse 실패(2회차)는 응답을 받은 뒤의 실패라
        // provider 가 전액 과금함. 실측 usage 기록 (5xx/timeout 은 usage 없음 → 0)
        const parseUsage =
          err instanceof LlmJsonParseError ? err.usage : undefined;
        const log = await this.saveAudit({
          input,
          model: cfg.model,
          provider: cfg.provider,
          promptHash,
          promptExcerpt,
          status: 'error',
          errorMessage: message,
          promptTokens: parseUsage?.promptTokens ?? 0,
          completionTokens: parseUsage?.completionTokens ?? 0,
          costUsd: parseUsage
            ? String(
                calcCostUsd(
                  cfg.model,
                  parseUsage.promptTokens,
                  parseUsage.completionTokens,
                  {
                    cacheCreationTokens: parseUsage.cacheCreationTokens,
                    cacheReadTokens: parseUsage.cacheReadTokens,
                    webSearchCount: parseUsage.webSearchCount,
                  },
                ),
              )
            : '0',
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

  /**
   * PR Phase 4 — Streaming JSON call.
   *
   * **흐름:**
   * 1. consent gate (call 과 동일)
   * 2. getModelConfig → anthropic 만 지원 (provider != 'anthropic' 면 즉시 error event yield)
   * 3. PII 스크럽 + input cap check
   * 4. AnthropicProvider.callJsonStream — async iterable
   *    - 'partial' event 마다 yield (caller 가 SSE 로 forward)
   *    - 'done' event 시 audit row + done event yield (callLogId 포함)
   * 5. provider error → 'error' event + audit
   *
   * **Phase 3 fallback 비적용** — streaming 중 실패는 caller 가 non-stream fallback 으로 별도 처리 가능.
   * 단순화 위해 우선 anthropic 만, recoverable error 발생 시 'error' event.
   *
   * **사용 예 (controller):**
   * ```ts
   * for await (const event of llm.callStream({...})) {
   *   res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
   * }
   * res.end()
   * ```
   */
  async *callStream<T = unknown>(
    input: LlmCallInput,
  ): AsyncGenerator<LlmStreamEvent<T>> {
    if (!input.jsonSchema) {
      yield { type: 'error', message: 'callStream 은 jsonSchema 필수' };
      return;
    }
    const startedAt = Date.now();

    // 1. consent gate
    const consentResult = await this.checkConsent(input.userId);
    if (consentResult) {
      yield { type: 'error', message: consentResult };
      return;
    }

    // 1.5. PR_B1 — 코인 잔여 추정 check
    const coinCheck = await this.coinService.canCharge(
      input.userId,
      input.feature,
    );
    if (!coinCheck.ok) {
      yield { type: 'error', message: coinCheck.reason ?? '코인이 부족해요' };
      return;
    }

    // 1.7. cost hardening 🔴2 — AI cost guard (call 경로와 동일한 USD hard cap).
    //   스트림 채팅이 주력 UX 인데 이 경로만 캡 밖이었음. blocked 는 audit 도 남김.
    const streamCostGuard = await this.costGuard.check(
      input.userId,
      input.feature,
    );
    if (streamCostGuard.blocked) {
      const cfgForAudit = getModelConfig(input.feature, this.config);
      await this.saveBlocked(
        input,
        cfgForAudit.model,
        cfgForAudit.provider,
        'blocked_cost_quota',
        streamCostGuard.reason,
        startedAt,
      );
      yield {
        type: 'error',
        message: streamCostGuard.reason,
      };
      return;
    }

    // 2. provider 결정 — anthropic 만 streaming 지원
    const cfg = getModelConfig(input.feature, this.config);
    if (cfg.provider !== 'anthropic') {
      yield {
        type: 'error',
        message: `streaming 은 anthropic 전용 (현재 ${cfg.provider})`,
      };
      return;
    }
    if (!this.anthropic.isAvailable) {
      yield { type: 'error', message: 'ANTHROPIC_API_KEY 미설정' };
      return;
    }

    // 3. PII 스크럽 + 본인 이름 블랙리스트
    const nicknames = await this.getUserNameBlacklist(input.userId);
    const systemPrompt = scrubPii(input.systemPrompt, {
      blacklistedNames: nicknames,
    }).text;
    const userPrompt = scrubPii(input.userPrompt, {
      blacklistedNames: nicknames,
    }).text;
    const cachedContext = input.cachedContext
      ? scrubPii(input.cachedContext, { blacklistedNames: nicknames }).text
      : undefined;

    // 4. input cap (캐시 세그먼트 포함)
    const inputTokens = estimateTokens(
      systemPrompt + '\n' + (cachedContext ?? '') + '\n' + userPrompt,
    );
    if (inputTokens > cfg.maxInputTokens) {
      yield {
        type: 'error',
        message: `입력 길이 초과 (${inputTokens} > ${cfg.maxInputTokens})`,
      };
      return;
    }

    const promptHash = this.hashPrompt(
      systemPrompt + (cachedContext ?? ''),
      userPrompt,
    );
    const promptExcerpt = userPrompt.slice(0, 200);

    // 5. streaming
    try {
      for await (const event of this.anthropic.callJsonStream<T>({
        model: cfg.model,
        systemPrompt,
        cachedContext,
        userPrompt,
        maxTokens: cfg.maxOutputTokens,
        temperature: cfg.temperature,
        jsonSchema: input.jsonSchema,
      })) {
        if (event.type === 'partial') {
          // partial 은 스크럽하지 않음 — 일시 표시용이고 chunk 경계에서 PII 패턴이
          // 쪼개져 실효 없음. 저장·반환은 done json 경유로만 스크럽된다.
          yield { type: 'partial', json: event.json };
        } else {
          // done — final json + audit + PR_B1 coin charge
          // text 채널 + 구조화 json 채널 모두 스크럽 (json 이 DB 저장 경로라 동일 방어).
          const outputScrub = scrubOutputPii(event.response.text);
          const jsonScrub = scrubJsonOutputPii(event.json);
          const outputRedacted = outputScrub.hasPii || jsonScrub.hasPii;
          const costUsd = calcCostUsd(
            cfg.model,
            event.response.promptTokens,
            event.response.completionTokens,
            {
              cacheCreationTokens: event.response.cacheCreationTokens,
              cacheReadTokens: event.response.cacheReadTokens,
              webSearchCount: event.response.webSearchCount,
            },
          );
          const latencyMs = Date.now() - startedAt;

          // PR_B1 — 코인 차감 (status='ok' 만, cache_*·web_search 포함 정확 합산)
          const chargeResult = await this.coinService.charge(
            input.userId,
            input.feature,
            {
              inputTokens: event.response.promptTokens,
              outputTokens: event.response.completionTokens,
              cacheCreationTokens: event.response.cacheCreationTokens,
              cacheReadTokens: event.response.cacheReadTokens,
              webSearchCount: event.response.webSearchCount,
            },
          );

          const log = await this.saveAudit({
            input,
            model: cfg.model,
            provider: cfg.provider,
            promptHash,
            promptExcerpt,
            status: 'ok',
            errorMessage: '[STREAMING]',
            promptTokens: event.response.promptTokens,
            completionTokens: event.response.completionTokens,
            cacheCreationTokens: event.response.cacheCreationTokens ?? 0,
            cacheReadTokens: event.response.cacheReadTokens ?? 0,
            webSearchCount: event.response.webSearchCount ?? 0,
            coinCost: chargeResult.coinCost.toString(),
            costBreakdown: chargeResult.breakdown,
            costUsd: costUsd.toString(),
            latencyMs,
            outputRedacted,
            attempts: 1,
          });
          yield {
            type: 'done',
            json: jsonScrub.value,
            text: outputScrub.text,
            promptTokens: event.response.promptTokens,
            completionTokens: event.response.completionTokens,
            costUsd,
            latencyMs,
            callLogId: log.id,
            outputRedacted,
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'streaming unknown';
      this.logger.error(
        `Streaming failed (feature=${input.feature}): ${message}`,
      );
      // cost hardening 🔴1 — 스트림 parse 실패도 완주 후 실패라 전액 과금됨 → 실측 기록
      const streamParseUsage =
        err instanceof LlmJsonParseError ? err.usage : undefined;
      await this.saveAudit({
        input,
        model: cfg.model,
        provider: cfg.provider,
        promptHash,
        promptExcerpt,
        status: 'error',
        errorMessage: `[STREAMING_ERROR] ${message}`,
        promptTokens: streamParseUsage?.promptTokens ?? 0,
        completionTokens: streamParseUsage?.completionTokens ?? 0,
        costUsd: streamParseUsage
          ? String(
              calcCostUsd(
                cfg.model,
                streamParseUsage.promptTokens,
                streamParseUsage.completionTokens,
                {
                  cacheCreationTokens: streamParseUsage.cacheCreationTokens,
                  cacheReadTokens: streamParseUsage.cacheReadTokens,
                  webSearchCount: streamParseUsage.webSearchCount,
                },
              ),
            )
          : '0',
        latencyMs: Date.now() - startedAt,
        outputRedacted: false,
        attempts: 1,
      });
      yield { type: 'error', message };
    }
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
      | 'blocked_consent'
      | 'blocked_input_cap'
      | 'blocked_quota'
      | 'blocked_cost_quota'
      | 'error'
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

  /**
   * cost hardening 🟡7 — LLM 을 거치지 않는 결과-캐시 hit 과금도 audit.
   * (원칙: 모든 AI 과금은 llm_call_logs 에서 추적 가능해야 함 — cache-hit 수동
   * charge 가 유일한 무흔적 과금 경로였음. errorMessage 마커로 구분.)
   */
  async auditCacheHitCharge(args: {
    userId: string;
    feature: LlmFeature;
    coinCost: string;
    resourceType?: string;
    resourceId?: string;
  }): Promise<void> {
    const cfg = getModelConfig(args.feature, this.config);
    try {
      await this.saveAudit({
        input: {
          userId: args.userId,
          feature: args.feature,
          systemPrompt: '',
          userPrompt: '',
          resourceType: args.resourceType,
          resourceId: args.resourceId,
        },
        model: cfg.model,
        provider: cfg.provider,
        promptHash: null,
        promptExcerpt: null,
        status: 'ok',
        errorMessage: '[CACHE_HIT_CHARGE] LLM 미호출 — 결과 캐시 과금',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: '0',
        latencyMs: 0,
        outputRedacted: false,
        attempts: 0,
        coinCost: args.coinCost,
      });
    } catch (err) {
      // audit 은 best-effort — 과금 흐름을 막지 않음
      this.logger.warn(`cache-hit audit 실패: ${(err as Error).message}`);
    }
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
    /** PR_B1 — Anthropic prompt cache write 토큰 */
    cacheCreationTokens?: number;
    /** PR_B1 — Anthropic prompt cache hit 토큰 */
    cacheReadTokens?: number;
    /** PR_B1 — Anthropic web_search tool 호출 횟수 */
    webSearchCount?: number;
    /** PR_B1 — 차감된 코인 (NUMERIC, string) */
    coinCost?: string;
    /** PR_B1 — cost USD 분해 5 키 (input/output/cache_creation/cache_read/web_search) */
    costBreakdown?: Record<string, number>;
  }): Promise<LlmCallLog> {
    return this.logRepo.save(
      this.logRepo.create({
        userId: args.input.userId,
        feature: args.input.feature,
        provider: args.provider,
        model: args.model,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        cacheCreationTokens: args.cacheCreationTokens ?? 0,
        cacheReadTokens: args.cacheReadTokens ?? 0,
        webSearchCount: args.webSearchCount ?? 0,
        coinCost: args.coinCost ?? '0',
        costBreakdown: args.costBreakdown ?? null,
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
