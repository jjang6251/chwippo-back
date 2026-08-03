/**
 * G-1 (2026-08-02) — **모델을 코드가 아니라 데이터로 다룬다.**
 *
 * 새 모델 추가 = 이 파일에 한 줄. 어댑터·서비스·비용 계산 코드 변경 0.
 *
 * **왜 만들었나** — 모델이 코드 곳곳에 박혀 있었다:
 *   - 코인 계산이 Haiku 단가로 하드코딩 (`coin.service.ts` COST_PER_M) → 모델을 올리면 마진만 무너짐
 *   - `temperature` 를 무조건 전송 → 이를 거부하는 모델은 400
 *   - 캐시 배율이 Anthropic 값(1.25/0.1)을 provider 무관 상수로 사용 → OpenAI 비용이 틀리게 계산
 *   - 최대 출력·컨텍스트를 아무 데도 안 갖고 있어 cap 검증 불가
 *
 * **핵심 원칙 — 느슨한 결합은 엄격한 계약과 짝이다.**
 * "아무 모델이나 되게" 가 아니라 **"모델이 자기 능력을 선언하고, 코드는 그 선언만 본다"**.
 * 선언에 없는 조합(예: strict 스키마 비호환, 스트리밍 미지원)은 **막는다**.
 *
 * **특정 모델을 전제하지 않는다.** 단가 유효기간도 "어느 모델의 프로모션이 언제 끝난다" 는
 * 개별 사실이 아니라 "단가에는 유효기간이 있을 수 있다" 는 일반 속성으로 모델링한다.
 */

import { LlmProviderName } from './entities/llm-call-log.entity';

/**
 * 구조화 출력을 강제하는 방식. **provider 마다 규격이 다르다.**
 * - `tool_use`            — Anthropic. optional 필드 허용
 * - `json_schema_strict`  — OpenAI. 🔴 **모든 property 가 required 에 있어야 함**
 * - `json_mode`           — JSON 이라는 것만 보장, 스키마 강제 X (현재 미사용)
 */
export type StructuredOutputMode =
  | 'tool_use'
  | 'json_schema_strict'
  | 'json_mode';

/**
 * 추론 파라미터 방식. **실제 API 로 payload 를 던져 확인한 값**(2026-08-02) —
 * models 엔드포인트의 capabilities 이름과 실제 요청 형태가 다르다.
 *
 * | mode | payload | 확인 |
 * |---|---|---|
 * | `thinking_budget`   | `thinking: { type:'enabled', budget_tokens:N }` | Haiku 4.5 ✅ |
 * | `thinking_adaptive` | `thinking: { type:'adaptive' }`                 | Sonnet 4.6 ✅ · Haiku 4.5 **400** |
 * | `effort`            | `output_config: { effort:'low'\|'medium'\|'high' }` | Sonnet 4.6 ✅ |
 *
 * 🔴 `effort` 는 **top-level 이 아니다** — `{effort:'low'}` 로 보내면
 * `400 Extra inputs are not permitted`. `output_config` 안에 들어간다.
 */
export type ReasoningMode = 'thinking_budget' | 'thinking_adaptive' | 'effort';

export interface ModelPricingTier {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

export interface ModelPricing extends ModelPricingTier {
  /**
   * 캐시 **쓰기** 단가 배율 (input 대비).
   * Anthropic 5m TTL = 1.25 (프리미엄) · OpenAI 자동 캐시 = 1.0 (추가 비용 없음)
   */
  cacheWriteRatio: number;
  /**
   * 캐시 **읽기** 단가 배율 (input 대비).
   * 🔴 **provider 마다 다르다** — Anthropic 0.1(90% 할인) · OpenAI 0.5(50% 할인).
   * 이걸 상수로 두면 OpenAI 비용이 5배 부풀어 모델 비교가 왜곡된다.
   */
  cacheReadRatio: number;
  /** web_search 1회당 USD. 미지원이면 null */
  webSearchUsdPerCall: number | null;
  /**
   * 이 단가가 유효한 마지막 날 (`YYYY-MM-DD`, KST). 프로모션·인트로 가격용.
   * 지나면 `next` 로 자동 전환된다 — 사람이 날짜를 기억하지 않아도 되게.
   */
  validUntil?: string;
  /** `validUntil` 경과 후 적용할 단가 */
  next?: ModelPricingTier;
}

export interface ModelSpec {
  provider: Exclude<LlmProviderName, 'mock'>;
  /** admin UI 표시명 */
  label: string;
  /**
   * 같은 모델을 가리키는 다른 문자열 (버전 별칭 등).
   * 🔴 이게 없으면 `defaultModel: 'claude-haiku-4-5'` 처럼 **호출은 되는데 단가표에는 없는**
   * 문자열이 생겨, 조용히 FALLBACK 단가로 계산된다 (출력 원가 20% 과소 기록).
   */
  aliases?: string[];
  pricing: ModelPricing;
  /** 이 모델이 한 번에 낼 수 있는 최대 출력 토큰. feature cap 이 이걸 넘으면 API 400 */
  maxOutputTokens: number;
  contextWindow: number;
  /** false 면 어댑터가 `temperature` 를 **아예 전송하지 않는다** */
  supportsTemperature: boolean;
  structuredOutputMode: StructuredOutputMode;
  supportsPromptCache: boolean;
  /** 미지원이면 null. 🔴 벤치에서 상위 모델을 불리하게 평가하지 않으려면 이게 필요하다 */
  reasoning: { mode: ReasoningMode } | null;
  /**
   * **우리 어댑터 기준** end-to-end 가능 여부.
   * API 가 지원해도 우리 provider 어댑터에 구현이 없으면 false —
   * 소비자가 알고 싶은 건 "실제로 스트리밍이 되는가" 이지 "API 스펙상 되는가" 가 아니다.
   */
  supportsStreaming: boolean;
  /**
   * 한국어 1자당 평균 토큰 수. 입력 한도 역산에 쓴다.
   * **실측 전에는 null** — 추정값을 넣으면 그게 또 근거 없는 상수가 된다 (Phase 0 `0-1` 에서 채움).
   */
  koreanTokensPerChar: number | null;
  /** 폐기 예정 — admin UI 에서 경고 표시, 신규 선택 비권장 */
  deprecated?: boolean;
}

/** Anthropic 프롬프트 캐시 배율 — 5m TTL write 1.25× · read 0.1× */
const ANTHROPIC_CACHE = { cacheWriteRatio: 1.25, cacheReadRatio: 0.1 };
/**
 * OpenAI gpt-4o 계열 자동 프롬프트 캐싱 — 쓰기 프리미엄 없음(1.0), 캐시된 input 50% 할인(0.5).
 * Anthropic 과 달리 명시적 파라미터가 없고 prefix 가 맞으면 자동 적용된다.
 * (실측 2026-08-03: 4o $2.50→$1.25 · 4o-mini $0.15→$0.075 = 정확히 0.5)
 */
const OPENAI_4O_CACHE = { cacheWriteRatio: 1.0, cacheReadRatio: 0.5 };
/**
 * 🔴 **gpt-5.6 계열은 0.1 이다** (실측 2026-08-03: terra $2→$0.20 · luna $0.20→$0.02).
 * "OpenAI = 0.5" 로 뭉뚱그리면 캐시 원가가 **5배 과다 계상**돼 모델 비교가 왜곡된다.
 * 캐시 배율은 provider 가 아니라 **모델**의 속성이다.
 */
const OPENAI_GPT56_CACHE = { cacheWriteRatio: 1.0, cacheReadRatio: 0.1 };

/** Anthropic web_search — $10 / 1,000회 */
const ANTHROPIC_WEB_SEARCH_USD = 0.01;

/**
 * 등록된 모델만 선택할 수 있다 (화이트리스트).
 *
 * 🔴 **단가가 없는 모델은 여기 못 들어온다** — 즉 "단가표에 없어서 조용히 FALLBACK 으로
 * 계산되는" 경로가 구조적으로 사라진다.
 *
 * 출처:
 * - Anthropic — `GET /v1/models/{id}` 실측 (2026-08-02). max_input·max_tokens·capabilities
 * - OpenAI — 공식 문서 기준값. models 엔드포인트가 한계값을 노출하지 않는다
 */
export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  'claude-haiku-4-5-20251001': {
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    // 'claude-haiku-4-5' 로 호출해도 API 는 이 모델로 해석한다 (실측 확인).
    // FEATURE_MATRIX.defaultModel 이 이 별칭을 쓰고 있어 반드시 등록해야 한다.
    aliases: ['claude-haiku-4-5'],
    pricing: {
      input: 1.0,
      output: 5.0,
      ...ANTHROPIC_CACHE,
      webSearchUsdPerCall: ANTHROPIC_WEB_SEARCH_USD,
    },
    maxOutputTokens: 64_000,
    contextWindow: 200_000,
    supportsTemperature: true,
    structuredOutputMode: 'tool_use',
    supportsPromptCache: true,
    // 실측: adaptive 는 400 ("not supported on this model") → budget 방식만 가능.
    // 🔴 `max_tokens > budget_tokens` 가 강제된다 — 어댑터가 이걸 어기면 400.
    reasoning: { mode: 'thinking_budget' },
    supportsStreaming: true, // anthropic.provider 에 callJsonStream 구현됨
    koreanTokensPerChar: 1.011, // 실측 2026-08-03 (한국어 736자 표본)
  },

  'claude-sonnet-4-6': {
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    pricing: {
      input: 3.0,
      output: 15.0,
      ...ANTHROPIC_CACHE,
      webSearchUsdPerCall: ANTHROPIC_WEB_SEARCH_USD,
    },
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    supportsTemperature: true,
    structuredOutputMode: 'tool_use',
    supportsPromptCache: true,
    // 실측: adaptive·effort 둘 다 200. adaptive 를 기본으로 둔다 —
    // budget 을 우리가 정하지 않아도 모델이 알아서 조절해 max_tokens 제약에 안 걸린다.
    reasoning: { mode: 'thinking_adaptive' },
    supportsStreaming: true,
    koreanTokensPerChar: null,
  },

  'claude-sonnet-5': {
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    pricing: {
      // 🔴 인트로 단가. 2026-08-31 이 지나면 next 로 자동 전환된다 —
      //   사람이 날짜를 기억하지 않아도 되게 (만료 7일 전 cron 이 Discord 로 알린다).
      input: 2.0,
      output: 10.0,
      ...ANTHROPIC_CACHE,
      webSearchUsdPerCall: ANTHROPIC_WEB_SEARCH_USD,
      validUntil: '2026-08-31',
      next: { input: 3.0, output: 15.0 },
    },
    // 실측 2026-08-03: max_tokens 999999 → 400 "> 128000, which is the maximum".
    // (웹 비교 글들이 64,000 이라고 적고 있으나 실제 API 응답은 128,000)
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    supportsTemperature: true,
    structuredOutputMode: 'tool_use',
    supportsPromptCache: true,
    // 실측 `GET /v1/models/claude-sonnet-5`:
    //   thinking.types → enabled **false** · adaptive **true** (Haiku 와 정반대)
    //   effort → low·medium·high·xhigh·max 전부 지원
    reasoning: { mode: 'thinking_adaptive' },
    supportsStreaming: true,
    // 실측 2026-08-03 (한국어 736자 자소서 표본, count_tokens).
    // 📌 문서상 "Claude 4.7 이후 토크나이저가 30% 더 쓴다" 는 **영어 기준**이다 —
    //    한국어는 Haiku 4.5(1.011) 대비 0.8% 차이라 사실상 동일했다. 추정 금지의 사례.
    koreanTokensPerChar: 1.019,
  },

  'gpt-5.6-terra': {
    provider: 'openai',
    label: 'GPT-5.6 Terra',
    pricing: {
      input: 2.0,
      output: 12.0,
      ...OPENAI_GPT56_CACHE,
      webSearchUsdPerCall: null,
    },
    maxOutputTokens: 128_000,
    contextWindow: 1_050_000,
    // 🔴 **false 다** (실측 2026-08-03). 파라미터를 받긴 하지만 **기본값 1 외에는 400** —
    //   `Unsupported value: 'temperature' does not support 0.3 ... Only the default (1)`.
    //   우리 8개 feature 가 전부 temperature 를 지정하므로, true 로 두면 **전 호출이 400** 이다.
    //   false = "보내지 않는다" 이고 그게 이 모델에서 유일하게 유효한 동작이다.
    supportsTemperature: false,
    structuredOutputMode: 'json_schema_strict',
    supportsPromptCache: true,
    // 추론 모델 — `reasoning_effort` 를 받는다. max_completion_tokens 가 작으면
    // 추론 토큰만 쓰고 본문 없이 400 이 난다 (실측: max_completion_tokens=1 → 400).
    reasoning: { mode: 'effort' },
    supportsStreaming: true, // openai.provider.callJsonStream 구현됨 (2026-08-03)
    koreanTokensPerChar: 0.546, // 실측 — Anthropic(1.02) 의 절반
  },

  'gpt-5.6-luna': {
    provider: 'openai',
    label: 'GPT-5.6 Luna',
    pricing: {
      input: 0.2,
      output: 1.2,
      ...OPENAI_GPT56_CACHE,
      webSearchUsdPerCall: null,
    },
    maxOutputTokens: 128_000,
    contextWindow: 1_050_000,
    supportsTemperature: false, // terra 와 동일 — 기본값 1 외 400 (실측)
    structuredOutputMode: 'json_schema_strict',
    supportsPromptCache: true,
    reasoning: { mode: 'effort' },
    supportsStreaming: true,
    koreanTokensPerChar: 0.546,
  },

  'gpt-4o-mini': {
    provider: 'openai',
    label: 'GPT-4o mini',
    pricing: {
      input: 0.15,
      output: 0.6,
      ...OPENAI_4O_CACHE,
      webSearchUsdPerCall: null,
    },
    maxOutputTokens: 16_384,
    contextWindow: 128_000,
    supportsTemperature: true,
    structuredOutputMode: 'json_schema_strict',
    supportsPromptCache: true,
    reasoning: null,
    supportsStreaming: true, // 2026-08-03 openai.provider 에 callJsonStream 구현
    koreanTokensPerChar: 0.548, // 실측 2026-08-03
  },

  'gpt-4o': {
    provider: 'openai',
    label: 'GPT-4o',
    pricing: {
      input: 2.5,
      output: 10.0,
      ...OPENAI_4O_CACHE,
      webSearchUsdPerCall: null,
    },
    maxOutputTokens: 16_384,
    contextWindow: 128_000,
    supportsTemperature: true,
    structuredOutputMode: 'json_schema_strict',
    supportsPromptCache: true,
    reasoning: null,
    supportsStreaming: true,
    koreanTokensPerChar: null,
  },
};

/** 별칭 → 정식 키. 모듈 로드 시 1회 구성 */
const ALIAS_TO_CANONICAL: Record<string, string> = Object.entries(
  MODEL_REGISTRY,
).reduce<Record<string, string>>((acc, [canonical, spec]) => {
  for (const alias of spec.aliases ?? []) acc[alias] = canonical;
  return acc;
}, {});

/** 모델 문자열(별칭 포함)을 정식 키로 정규화. 미등록이면 null */
export function canonicalModelId(model: string): string | null {
  if (MODEL_REGISTRY[model]) return model;
  return ALIAS_TO_CANONICAL[model] ?? null;
}

/** 등록된 모델이면 spec, 아니면 null (호출부가 판단) */
export function getModelSpec(model: string): ModelSpec | null {
  const id = canonicalModelId(model);
  return id ? MODEL_REGISTRY[id] : null;
}

/**
 * 오늘 기준 실제 적용 단가. `validUntil` 이 지났으면 `next` 로 자동 전환.
 *
 * `now` 를 인자로 받는 이유 — 만료 경계를 테스트로 고정하기 위해서다.
 * (KST 고정 앱이므로 날짜 비교는 `YYYY-MM-DD` 문자열 비교로 충분)
 */
export function effectivePricing(
  spec: ModelSpec,
  todayKst: string,
): ModelPricing {
  const p = spec.pricing;
  if (!p.validUntil || !p.next) return p;
  // validUntil 당일까지는 기존 단가 유효 → 그 다음 날부터 next
  return todayKst <= p.validUntil ? p : { ...p, ...p.next };
}

/** admin 드롭다운용 — provider 로 좁힐 수 있다 */
export function listModels(
  provider?: ModelSpec['provider'],
): Array<{ id: string } & ModelSpec> {
  return Object.entries(MODEL_REGISTRY)
    .filter(([, s]) => !provider || s.provider === provider)
    .map(([id, s]) => ({ id, ...s }));
}

/**
 * G-1 — 모델이 `temperature` 를 받는지에 따라 **인자를 넣거나 아예 뺀다.**
 *
 * 이전에는 모든 호출에 무조건 실어 보냈다. `temperature` 를 거부하는 모델을 고르면
 * **400 으로 죽는다** — 벤치 대상 모델이 그러면 비교 자체가 불가능해진다.
 *
 * 미등록 모델(spec 없음)은 **기존 동작 유지**(전송) — 레지스트리에 없다는 이유로
 * 갑자기 파라미터가 빠지면 지금 잘 돌던 호출이 바뀐다. 미등록 자체는 `llm-pricing` 이 경고한다.
 *
 * 반환값을 스프레드해서 쓴다: `{ ...temperatureArg(model, t) }`
 */
export function temperatureArg(
  model: string,
  temperature: number,
): { temperature?: number } {
  const spec = getModelSpec(model);
  if (spec && !spec.supportsTemperature) return {};
  return { temperature };
}

/** 호출부가 표현하는 **의도** — provider 중립. 실제 payload 는 어댑터가 조립한다 */
export type ReasoningIntent = 'low' | 'medium' | 'high';

/** `thinking_budget` 모드에서 intent → budget_tokens 환산 */
const BUDGET_BY_INTENT: Record<ReasoningIntent, number> = {
  low: 1_024,
  medium: 4_096,
  high: 16_384,
};

/**
 * G-1 — 추론 파라미터를 **모델 선언에 맞는 형태로** 조립한다.
 *
 * 레지스트리는 **능력**(무엇이 가능한가)을, 호출부는 **의도**(얼마나 생각하게 할까)를
 * 갖는다. 둘을 여기서 합친다 — 그래서 호출부가 모델별 payload 를 알 필요가 없다.
 *
 * 🔴 `thinking_budget` 은 **`max_tokens > budget_tokens`** 가 강제된다 (실측 400).
 * 한도가 모자라면 **추론을 끄고 진행**한다 — 400 으로 죽이는 것보다 낫고,
 * 조용히 넘어가지 않도록 호출부가 알 수 있게 `downgraded` 를 함께 돌려준다.
 *
 * @returns `{ args, downgraded }` — args 를 스프레드해서 요청에 붙인다
 */
export function reasoningArgs(
  model: string,
  intent: ReasoningIntent | undefined,
  maxTokens: number,
): {
  args: Record<string, unknown>;
  downgraded: 'unsupported' | 'max_tokens_too_small' | null;
} {
  if (!intent) return { args: {}, downgraded: null };

  const spec = getModelSpec(model);
  if (!spec?.reasoning) return { args: {}, downgraded: 'unsupported' };

  switch (spec.reasoning.mode) {
    case 'thinking_adaptive':
      return { args: { thinking: { type: 'adaptive' } }, downgraded: null };

    case 'thinking_budget': {
      const budget = BUDGET_BY_INTENT[intent];
      // max_tokens 는 최종 답변 + 추론 토큰을 합쳐 담아야 한다
      if (maxTokens <= budget) {
        return { args: {}, downgraded: 'max_tokens_too_small' };
      }
      return {
        args: { thinking: { type: 'enabled', budget_tokens: budget } },
        downgraded: null,
      };
    }

    case 'effort':
      // 🔴 top-level 이 아니라 output_config 안 (실측 확인)
      return { args: { output_config: { effort: intent } }, downgraded: null };
  }
}
