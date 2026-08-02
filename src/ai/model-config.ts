import type { ConfigService } from '@nestjs/config';
import type {
  LlmFeature,
  LlmProviderName,
} from './entities/llm-call-log.entity';

/**
 * Feature 별 모델·provider·token cap·temperature 매트릭스.
 *
 * **설계 원칙** (ADR-025 + risk audit C4):
 * - **maxInputTokens 박제** — feature 별로 명시 (light=8K, heavy=16K). 초과 시 `blocked_input_cap`
 * - **maxTokens 박제** — output 토큰 cap (모든 feature 명시, default 의존 X)
 * - **provider 강점 활용** — 자소서 = Claude (한국어), 면접 = GPT (structured output 강함), 요약 = GPT mini (저렴)
 * - **Phase 1** (F7 토큰 시스템 도입 전): mini-only. Phase 2+ 에서 사용자별 분기 시 `getModelConfig(feature, user)` 로 확장
 */

export interface ModelConfig {
  provider: LlmProviderName;
  /** Config 에서 모델명 가져올 ENV 키. 없으면 default 값 사용 */
  modelEnvKey: string;
  defaultModel: string;
  /** input prompt (system + user 합산) 토큰 cap. 초과 시 blocked_input_cap */
  maxInputTokens: number;
  /** output 토큰 cap (provider 의 max_tokens 파라미터). 모든 feature 명시 강제 */
  maxOutputTokens: number;
  temperature: number;
  /**
   * (옵션) 1차 provider 가 5xx · timeout · network 에러 시 fallback provider 로 1회 retry.
   * 동일 prompt 그대로 호출. 429 · 400 schema · blocked_* 는 fallback 미적용.
   * fallback 사용 시 model 은 fallback provider 의 default (gpt-4o-mini / claude-haiku-4-5).
   */
  /**
   * G-1 — 이 feature 가 **스트리밍을 필수로 요구**하는가.
   *
   * `LlmService.callStream` 을 쓰는 feature 는 스트리밍 미지원 모델로 바꾸면
   * **기능이 통째로 죽는다**(명시적 error event). admin 저장 시 이 플래그로 차단한다.
   * "경고만 하고 허용" 은 안 된다 — 관리자가 무시하면 사용자가 즉시 깨진 화면을 본다.
   */
  requiresStreaming?: boolean;
  fallbackProvider?: LlmProviderName;
  fallbackModelEnvKey?: string;
  fallbackDefaultModel?: string;
}

/**
 * Phase 1 (2026-05 ~ F7 직전) feature 매핑.
 * 매핑 누락 시 default = light + log warn (getModelConfig 안에서 처리).
 */
const FEATURE_MATRIX: Record<LlmFeature, ModelConfig> = {
  // ── F5 기존 ──
  note_summary: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 8_000,
    maxOutputTokens: 300,
    temperature: 0.3,
  },
  auto_tag: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 4_000,
    maxOutputTokens: 200,
    temperature: 0.1,
  },
  score: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 4_000,
    maxOutputTokens: 100,
    temperature: 0.1,
  },
  analysis: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 8_000,
    maxOutputTokens: 500,
    temperature: 0.3,
  },
  // 기존 단발 호출 (F2 이전) — 호환 유지 (deprecated, PR 1 의 v2 로 교체 예정)
  coverletter: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 8_000,
    maxOutputTokens: 1_500,
    temperature: 0.5,
  },
  interview: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 8_000,
    maxOutputTokens: 1_500,
    temperature: 0.5,
  },
  interview_followup: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 4_000,
    maxOutputTokens: 500,
    temperature: 0.5,
  },

  // ── PR 0 신규 (F6 PR 1·2 에서 사용) ──
  // F6 PR 2 — **모든 feature light 모델 강제** (memory `feedback_admin_quota_control` 비용 통제).
  // 한국어 품질 평가 후 사용자가 명시적으로 heavy 전환 결정 시 admin 매트릭스 갱신.
  coverletter_draft_v2: {
    provider: 'anthropic',
    modelEnvKey: 'ANTHROPIC_MODEL_LIGHT',
    defaultModel: 'claude-haiku-4-5',
    maxInputTokens: 16_000,
    // D0 (2026-08-01) 2,000 → 6,000. 출력 = 자소서 본문 그 자체라 charLimit 에 정비례한다.
    //   프롬프트가 "charLimit 의 92% 이상" 을 지시하므로: charLimit × 0.92 × (자당 토큰 ~1.5)
    //   → 2,000자 문항 = 2,760 토큰 / 4,000자 문항 = 5,520 토큰. 6,000 이면 charLimit 4,000자까지 커버.
    //   (자당 토큰 비율은 미실측 보수값 1.5 — count_tokens 실측 후 재조정)
    maxOutputTokens: 6_000,
    temperature: 0.5,
  },
  coverletter_feedback: {
    provider: 'anthropic',
    modelEnvKey: 'ANTHROPIC_MODEL_LIGHT',
    defaultModel: 'claude-haiku-4-5',
    maxInputTokens: 16_000,
    // 🔴 D0 (2026-08-01 실사고 직접 원인) 1,500 → 6,000.
    //   1,500 은 스키마가 요구하는 최대 출력보다 **작았다** — 잘려서 `suggestions` 가 통째로 누락되고,
    //   그 값이 검증 없이 저장돼 프론트 크래시로 이어졌다.
    //   스키마 최대: issues 6개(quote+advice ~180자) + suggestions 2개(~200자) + strengths·summary·JSON 구조
    //   ≈ 2,070자 ≈ 3,100 토큰. 6,000 이면 최대치의 약 2배 여유 — 자소서 길이와 무관하게 안전하다.
    //   (출력이 스키마로 상한이 잡혀 있어 입력 길이에 비례하지 않는다)
    maxOutputTokens: 6_000,
    temperature: 0.3,
  },
  coverletter_recommend: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 4_000,
    maxOutputTokens: 300,
    temperature: 0.2,
  },
  interview_prep_session: {
    // F1 v2 (2026-06-01) — anthropic 전환 + main 20 균등 분배 + streaming SSE (Phase 3)
    provider: 'anthropic',
    modelEnvKey: 'ANTHROPIC_MODEL_LIGHT',
    defaultModel: 'claude-haiku-4-5',
    maxInputTokens: 16_000,
    // main 20개 × (질문 ~80자 + 답변 ~300자 = ~380자) + 일부 followup 1개 = ~8000자 JSON 필요
    //
    // D0 (2026-08-01) 7,000 → 12,000. **잘림이 추정이 아니라 실측으로 확인됐다** —
    // dev llm_call_logs 기준 ok 6건 중 4건이 5,000+ 이고 1건은 `completion_tokens` 가
    // 정확히 7,000(=cap). cap 과 정확히 일치하는 건 한도에 걸려 강제 종료됐다는 뜻이라,
    // 사용자는 질문 20개를 요청하고 일부만 받고 있었다.
    //   - 위 주석의 요구량 ~8,000자는 JSON 구조 오버헤드까지 더하면 상한이 8,600 토큰 근처.
    //   - 12,000 은 그 위 여유분. claude-haiku-4-5 의 max_tokens=64,000 이라 안전.
    //   - 출력은 **실제 생성분만 과금**되므로 cap 상향 자체의 비용 증가는 없다.
    // 근본 해결은 prep v2 의 "질문 only + on-demand 답변" (출력 79% 감소). 그때 재조정할 것.
    maxOutputTokens: 12_000,
    temperature: 0.5,
  },
  interview_prep_followup: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 8_000,
    maxOutputTokens: 800,
    temperature: 0.5,
  },
  // F1 자소서 풀페이지 Phase D — AI 채팅 (multi-turn + structured output)
  // 메시지 이력 6개 truncate, 컨텍스트 = 회사조사 + N문항 + source_refs + 메시지 이력
  coverletter_chat: {
    // SSE 스트리밍으로 답변을 흘려보낸다 (LlmService.callStream)
    requiresStreaming: true,
    provider: 'anthropic',
    modelEnvKey: 'ANTHROPIC_MODEL_LIGHT',
    defaultModel: 'claude-haiku-4-5',
    maxInputTokens: 16_000,
    // D0 (2026-08-01) 5,000 → 8,000 + 스키마 `suggestedUpdates maxItems: 2` 로 상한 고정.
    //   기존 주석은 "5000자 JSON 필요 → maxTokens 5000" 이었는데 **자(char)와 토큰을 1:1 로 놓은 계산 오류**다.
    //   한국어는 자당 ~1.5 토큰이고 JSON 구조(clId UUID 36자 × N + 키)까지 붙어 4문항이면 이미 초과했다.
    //   문항 수에 비례해 무한정 커지는 걸 막으려면 한도를 키우는 게 아니라 **개수를 스키마로 고정**해야 한다:
    //   2문항 × 1,500자 = 3,000자 ≈ 4,500 토큰 + reply(~750) + 구조(~240) ≈ 5,500 → 8,000 이면 충분.
    maxOutputTokens: 8_000,
    temperature: 0.5,
  },
  // 공고 요건 파싱 — note_summary 와 같은 light 모델(gpt-4o-mini). 붙여넣은 공고(최대 10K자 ≈ input 8K cap)
  // 를 6필드 구조화 JSON 으로. 추출 태스크라 temperature 최저(0.1), output 은 요건 배열이라 1K.
  jobposting_parse: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 8_000,
    maxOutputTokens: 1_000,
    temperature: 0.1,
  },
};

export function getModelConfig(
  feature: LlmFeature,
  config: ConfigService,
): ModelConfig & { model: string } {
  const cfg = FEATURE_MATRIX[feature];
  if (!cfg) {
    // 매핑 누락 시 default = OpenAI mini + 경고 (PR 0 plan)
    const fallback = FEATURE_MATRIX.note_summary;
    return {
      ...fallback,
      model: config.get<string>(fallback.modelEnvKey) ?? fallback.defaultModel,
    };
  }
  return {
    ...cfg,
    model: config.get<string>(cfg.modelEnvKey) ?? cfg.defaultModel,
  };
}

/**
 * Provider 5xx · timeout · network 에러 시 사용할 fallback provider 설정 자동 결정.
 * - anthropic → openai (gpt-4o-mini)
 * - openai → anthropic (claude-haiku-4-5)
 * - mock → fallback 미사용 (null)
 *
 * fallback 시 maxOutputTokens · temperature 는 원본 그대로 (모델만 교체).
 * web_search 같은 anthropic 전용 도구는 fallback 시 자동 비활성 (LlmService 가 webSearch 인자 무시).
 */
export function getFallbackConfig(
  cfg: ModelConfig & { model: string },
  config: ConfigService,
): (ModelConfig & { model: string }) | null {
  if (cfg.provider === 'anthropic') {
    return {
      ...cfg,
      provider: 'openai',
      modelEnvKey: 'OPENAI_MODEL_LIGHT',
      defaultModel: 'gpt-4o-mini',
      model: config.get<string>('OPENAI_MODEL_LIGHT') ?? 'gpt-4o-mini',
    };
  }
  if (cfg.provider === 'openai') {
    return {
      ...cfg,
      provider: 'anthropic',
      modelEnvKey: 'ANTHROPIC_MODEL_LIGHT',
      defaultModel: 'claude-haiku-4-5',
      model: config.get<string>('ANTHROPIC_MODEL_LIGHT') ?? 'claude-haiku-4-5',
    };
  }
  return null;
}
