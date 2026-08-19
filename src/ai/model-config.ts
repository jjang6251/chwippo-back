import type { ConfigService } from '@nestjs/config';
import type {
  ActiveLlmFeature,
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
const FEATURE_MATRIX: Record<ActiveLlmFeature, ModelConfig> = {
  // ── F5 기존 ──
  note_summary: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_LIGHT',
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 8_000,
    maxOutputTokens: 300,
    temperature: 0.3,
  },
  // 기존 단발 호출 (F2 이전) — 호환 유지 (deprecated, PR 1 의 v2 로 교체 예정)

  // ── PR 0 신규 (F6 PR 1·2 에서 사용) ──
  // F6 PR 2 — **모든 feature light 모델 강제** (memory `feedback_admin_quota_control` 비용 통제).
  // 한국어 품질 평가 후 사용자가 명시적으로 heavy 전환 결정 시 admin 매트릭스 갱신.
  coverletter_draft_v2: {
    // Phase 1 (2026-08-03) — 벤치 결과 Terra 확정 (ADR-062). 지어내기 0건 · 원가 27원/건
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_COVERLETTER',
    defaultModel: 'gpt-5.6-terra',
    maxInputTokens: 16_000,
    /**
     * 6,000 → 8,000 (2026-08-03). D0 의 "자당 1.5" 는 **미실측 보수값**이었고,
     * 실측은 Terra **0.546** 이다. 두 변화가 반대 방향이라 다시 계산했다:
     *
     *   본문  = 저장 가능한 최대 답변 10,000자(DTO MaxLength) × 0.546 = 5,460 토큰
     *   추론  = Terra 실측 121~992 → 보수적으로 2,000 여유
     *   합계  ≈ 7,460  → **8,000**
     *
     * 🔴 **추론 토큰이 새로 들어온 게 핵심이다.** gpt-5.6 은 추론 모델이라 출력 예산을
     * 본문과 나눠 쓴다. 이걸 빼고 계산하면 사용자가 **잘린 자소서 + 정상 코인 차감**을 받는다
     * (실제로 벤치 1차에서 Sonnet 5 가 예산 1,631 중 1,261 을 추론에 써 본문이 361자에서 잘렸다).
     *
     * 출력은 실제 생성분만 과금되므로 cap 상향의 직접 비용은 0 — 부족이 훨씬 위험하다.
     */
    maxOutputTokens: 8_000,
    // ⚠️ gpt-5.6 은 temperature 기본값 1 외 400 → 레지스트리가 `supportsTemperature: false`
    //   로 선언해 **전송되지 않는다**. 이 값은 다른 모델로 되돌릴 때를 위한 선언으로만 남는다.
    temperature: 0.5,
  },
  coverletter_feedback: {
    // Phase 1 (2026-08-03) — 자소서 트랙 통일. 점검도 "자료에 근거해 짚는" 작업이라
    //   지어내기가 더 큰 위험이고, 그 축에서 Terra 가 이겼다 (ADR-062)
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_COVERLETTER',
    defaultModel: 'gpt-5.6-terra',
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
    /**
     * v2 (2026-08-06) — **질문만 생성.** 벤치로 모델·호출형태를 확정했다
     * (`scripts/bench/run-question-bench.ts`, 36콜·264원).
     *
     * | 모델·모드        | 자료 밀착 | 공통질문 누락 | 원/세션 | 초 |
     * |-----------------|---------|------------|--------|----|
     * | 4o-mini · 1콜    | 16%     | 2          | 0.9원  | 8  |
     * | **luna · 1콜**   | **68%** | **0**      | **2.8원** | **9** |
     * | terra · 1콜      | 57%     | 0          | 24.4원 | 12 |
     *
     * 🔴 **판별축은 "자료 밀착도"** — 질문이 사용자 자소서·활동 기록의 사실을 인용하는가.
     * 4o-mini 는 16% 로 탈락했다 ("프로세스와 스레드의 차이를 설명해 주세요" 같은 검색형 질문).
     * 그게 이 제품의 차별점이라 원가(0.9원)가 싸도 못 쓴다.
     * terra 는 밀착이 luna 보다 낮은데 원가가 9배다 — 자소서 벤치(ADR-062)와 결론이 뒤집힌 건
     * 축이 다르기 때문이다(그쪽은 답변 지어내기, 여기는 질문 밀착도).
     */
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_INTERVIEW',
    defaultModel: 'gpt-5.6-luna',
    maxInputTokens: 16_000,
    /**
     * v1 은 12,000 이었다 (질문 20개 + 답변 20개 = 실측 평균 6,109 토큰, cap 도달 사례 있음).
     * v2 는 **답변을 안 만들어** 출력이 1/5 로 줄었다 — 벤치 실측 luna 1콜 최대 약 1,900 토큰.
     *
     * 4,000 은 그 2배 여유다. 🔴 더 줄이지 마라 — luna 는 추론 모델이라 이 예산을
     * **추론 토큰과 본문이 나눠 쓴다** (벤치 실측 추론 164~285). 부족하면 JSON 이 잘려
     * strict 파싱이 실패한다. 출력은 실제 생성분만 과금되므로 여유의 직접 비용은 0 이다.
     */
    maxOutputTokens: 4_000,
    // ⚠️ gpt-5.6 은 기본값 1 외 temperature 를 400 으로 거부한다 →
    //   레지스트리가 `supportsTemperature: false` 라 **전송되지 않는다**.
    //   이 값은 다른 모델로 되돌릴 때를 위한 선언으로만 남는다.
    temperature: 0.5,
  },
  /**
   * v2 (2026-08-06) — 질문 1개의 예상 답변을 on-demand 로 만든다.
   *
   * 세션과 **같은 모델(luna)** 로 통일한다. 문체가 갈리면 한 화면 안에서 질문과 답변의
   * 톤이 어긋나고, 자소서에서 `coverletter_chat` 을 Terra 로 옮긴 것과 같은 근거다.
   * 원가는 이 규모에서 판단 근거가 못 된다 (호출당 1원 안팎).
   *
   * 🔴 `maxOutputTokens` 를 더 줄이지 마라 — luna 는 추론 모델이라 예산을 추론과 본문이
   * 나눠 쓴다. 꼬리질문 벤치 실측에서 800 예산 중 488(본문 356 + 추론 132)을 썼다.
   * 답변은 자기소개 기준 500자 ≈ 273 토큰이라 본문 자체는 작지만, 추론 몫까지 담아야 한다.
   */
  interview_prep_answer: {
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_INTERVIEW',
    defaultModel: 'gpt-5.6-luna',
    // 세션과 같은 컨텍스트(자소서·활동 로그·회사 조사)를 그대로 쓴다
    maxInputTokens: 16_000,
    maxOutputTokens: 2_000,
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
    // Phase 1 (2026-08-03) — OpenAI 스트리밍 이식 후 이전. 초안을 Terra 가 쓰고
    //   이어지는 대화는 다른 모델이 받으면 문체·지어내기 성향이 갈린다
    provider: 'openai',
    modelEnvKey: 'OPENAI_MODEL_COVERLETTER',
    defaultModel: 'gpt-5.6-terra',
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
  /**
   * 노트 AI 패널 — 선택 영역 변환(쉽게·간결히·표·문답·자유) + 무선택 생성.
   *
   * LIGHT 시작(D4). 입력은 선택 6,000자 + 히스토리 3턴이라 8K 안에 들어가고,
   * 출력은 표·문답으로 부풀 수 있어 2,000 을 준다 (선택 원문보다 길어지는 액션이 있다).
   * temperature 0.4 — 추출(0.1)보다는 다시 쓰는 작업이고, 창작(0.5+)까지는 아니다.
   * 품질 미달 시 admin `feature_model_config` 로 무배포 전환하되, 코인 2 는 LIGHT 단가 전제다.
   */
  note_ai_action: {
    provider: 'openai',
    // luna 확정 (2026-08-19 벤치 — mini 는 지시 준수가 한 급 아래("표 채워줘"에서 체감),
    // terra 는 품질 동급인데 8배 비쌈. 회당 실측 ~0.5코인. 면접 기능과 같은 env 축)
    modelEnvKey: 'OPENAI_MODEL_INTERVIEW',
    defaultModel: 'gpt-5.6-luna',
    maxInputTokens: 8_000,
    // 🔴 luna 는 추론 모델 — reasoning 토큰이 이 예산을 먼저 먹는다 (벤치 최대 124).
    //   2,000 이면 표·문답 결과와 합쳐 빠듯할 수 있어 여유를 둔다
    maxOutputTokens: 3_000,
    temperature: 0.4, // luna 는 temperature 미지원 — provider 가 레지스트리 보고 생략한다
  },
};

/**
 * 조회용 넓은 뷰. `feature` 는 **퇴역 값일 수 있다** (DB 행·과거 로그에서 흘러온 경우).
 * `as` 캐스팅이 아니라 **할당**이다 — `Record<Active,T>` 는 `Partial<Record<All,T>>` 의 하위 타입.
 */
const MATRIX_LOOKUP: Partial<Record<LlmFeature, ModelConfig>> = FEATURE_MATRIX;

/**
 * 🔴 인자가 `LlmFeature`(넓은 쪽)인 이유 — DB `feature_model_config` 행이나 과거
 * `llm_call_logs` 행에서 퇴역 값이 들어올 수 있다. **호출 게이트는 `LlmService.call` 의
 * `ActiveLlmFeature` 가 맡는다** (거기서 컴파일 단계로 막힌다).
 */
export function getModelConfig(
  feature: LlmFeature,
  config: ConfigService,
): ModelConfig & { model: string } {
  const cfg = MATRIX_LOOKUP[feature];
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
