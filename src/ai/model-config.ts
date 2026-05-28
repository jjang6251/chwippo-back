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
    maxOutputTokens: 2_000,
    temperature: 0.5,
  },
  coverletter_feedback: {
    provider: 'anthropic',
    modelEnvKey: 'ANTHROPIC_MODEL_LIGHT',
    defaultModel: 'claude-haiku-4-5',
    maxInputTokens: 16_000,
    maxOutputTokens: 1_500,
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
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 16_000,
    maxOutputTokens: 3_000,
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
  // PR 2 Phase 4 단계 B — 회사 조사 (Anthropic Claude haiku + web_search tool)
  // light haiku 가 web_search tool 지원. 한국어 자연스러움 ↑
  company_research: {
    provider: 'anthropic',
    modelEnvKey: 'ANTHROPIC_MODEL_LIGHT',
    defaultModel: 'claude-haiku-4-5',
    maxInputTokens: 4_000,
    maxOutputTokens: 2_500, // 8 항목 JSON 응답 충분
    temperature: 0.2, // 사실 기반 정보 — 낮게
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
