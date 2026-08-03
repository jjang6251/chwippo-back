import { ConfigService } from '@nestjs/config';
import { ActiveLlmFeature, LlmFeature } from './entities/llm-call-log.entity';
import { getFallbackConfig, getModelConfig } from './model-config';

/**
 * D0 (2026-08-01) — **FEATURE_MATRIX 박제 spec.**
 *
 * 이 파일은 원래 있어야 했다. `interview-prep-ai.service.spec.ts` 의
 * "interview_prep_session 의 maxOutputTokens = 7000" 케이스가
 * `// 직접 검증은 model-config.spec 에서` 주석과 함께 `expect(true).toBe(true)` 로
 * 비어 있었고, 가리킨 파일은 만들어진 적이 없다. 결과적으로 **전 feature 의
 * provider·모델·토큰 한도가 어디서도 검증되지 않았다** — cap 을 바꿔도 전 스위트가 초록불이었다.
 *
 * 이번 실사고(출력 한도 부족 → 응답 잘림 → 필수 필드 누락 → 프론트 크래시)의 배경이
 * 정확히 "한 번 박고 아무도 안 보는 상수"였으므로, 값이 소리 없이 바뀌지 못하게 고정한다.
 *
 * **cap 을 의도적으로 조정할 때는 이 표를 함께 고쳐야 한다.** 그게 이 spec 의 목적이다 —
 * 변경을 막는 게 아니라 **의식적인 변경만 통과**시키는 것.
 */
describe('model-config FEATURE_MATRIX', () => {
  // env 미설정 상태 = defaultModel 이 그대로 쓰이는 경로
  const config = { get: () => undefined } as unknown as ConfigService;

  /**
   * 기대값 표. `maxOutputTokens` 는 각 feature 의 **응답 스키마 요구량**에서 나온 값이다.
   * 출력은 실제 생성분만 과금되므로 cap 상향의 직접 비용은 없다 — 부족이 훨씬 위험하다.
   */
  const EXPECTED: Record<
    ActiveLlmFeature,
    { provider: string; model: string; maxIn: number; maxOut: number }
  > = {
    note_summary: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      maxIn: 8_000,
      maxOut: 300,
    },
    coverletter_draft_v2: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      maxIn: 16_000,
      maxOut: 6_000,
    },
    coverletter_feedback: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      maxIn: 16_000,
      maxOut: 6_000,
    },
    coverletter_recommend: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      maxIn: 4_000,
      maxOut: 300,
    },
    interview_prep_session: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      maxIn: 16_000,
      // D0 — 7,000 에서 상향. dev 실측상 cap 에 정확히 도달(=잘림)한 호출이 있었다.
      maxOut: 12_000,
    },
    interview_prep_followup: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      maxIn: 8_000,
      maxOut: 800,
    },
    coverletter_chat: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      maxIn: 16_000,
      maxOut: 8_000,
    },
    jobposting_parse: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      maxIn: 8_000,
      maxOut: 1_000,
    },
  };

  const FEATURES = Object.keys(EXPECTED) as LlmFeature[];

  describe('feature 별 provider · 모델 · 토큰 한도 박제', () => {
    it.each(FEATURES)('%s', (feature) => {
      const cfg = getModelConfig(feature, config);
      const want = EXPECTED[feature];

      expect(cfg.provider).toBe(want.provider);
      expect(cfg.model).toBe(want.model);
      expect(cfg.maxInputTokens).toBe(want.maxIn);
      expect(cfg.maxOutputTokens).toBe(want.maxOut);
    });
  });

  describe('구조 불변식 — 표를 늘릴 때 같이 지켜야 하는 것', () => {
    /**
     * 신규 feature 를 LlmFeature 에 추가하고 FEATURE_MATRIX 등록을 잊으면
     * default(note_summary) 로 조용히 fallback 한다 — 의도와 다른 모델·cap 으로 호출된다.
     * 이 표가 union 전체를 덮고 있어야 그 누락이 여기서 드러난다.
     */
    it('LlmFeature union 의 모든 값이 이 표에 있다 (신규 추가 시 등록 강제)', () => {
      // 표에 없는 feature 를 쓰면 타입 에러가 나므로, 역방향(표 → matrix)만 확인하면 된다.
      // matrix 미등록이면 note_summary 설정이 그대로 반환되어 아래 비교에서 걸린다.
      for (const feature of FEATURES) {
        const cfg = getModelConfig(feature, config);
        if (feature !== 'note_summary') {
          const isSilentFallback =
            cfg.maxInputTokens === EXPECTED.note_summary.maxIn &&
            cfg.maxOutputTokens === EXPECTED.note_summary.maxOut &&
            cfg.provider === EXPECTED.note_summary.provider;
          expect(isSilentFallback).toBe(false);
        }
      }
    });

    it('모든 feature 의 출력 한도가 0 초과 (미명시 시 SDK default 까지 생성 → 비용 surprise)', () => {
      for (const feature of FEATURES) {
        expect(getModelConfig(feature, config).maxOutputTokens).toBeGreaterThan(
          0,
        );
      }
    });

    it('anthropic feature 의 출력 한도가 모델 상한(claude-haiku-4-5 = 64,000) 이내', () => {
      // 초과하면 API 400 — 배포 후에야 터진다. 표에서 미리 막는다.
      for (const feature of FEATURES) {
        const cfg = getModelConfig(feature, config);
        if (cfg.provider === 'anthropic') {
          expect(cfg.maxOutputTokens).toBeLessThanOrEqual(64_000);
        }
      }
    });

    it('temperature 가 0~1 범위', () => {
      for (const feature of FEATURES) {
        const t = getModelConfig(feature, config).temperature;
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('getFallbackConfig — 교차 provider 전환', () => {
    it('anthropic → openai(gpt-4o-mini) 로 전환하되 cap·temperature 는 유지', () => {
      const primary = getModelConfig('interview_prep_session', config);
      const fb = getFallbackConfig(primary, config);

      expect(fb?.provider).toBe('openai');
      expect(fb?.model).toBe('gpt-4o-mini');
      // 모델만 교체 — 한도는 원본 유지가 계약이다
      expect(fb?.maxOutputTokens).toBe(primary.maxOutputTokens);
      expect(fb?.temperature).toBe(primary.temperature);
    });

    it('openai → anthropic(claude-haiku-4-5) 로 전환', () => {
      const primary = getModelConfig('jobposting_parse', config);
      const fb = getFallbackConfig(primary, config);

      expect(fb?.provider).toBe('anthropic');
      expect(fb?.model).toBe('claude-haiku-4-5');
      expect(fb?.maxOutputTokens).toBe(primary.maxOutputTokens);
    });
  });

  describe('env override', () => {
    it('modelEnvKey 가 설정돼 있으면 defaultModel 대신 그 값을 쓴다', () => {
      const overridden = {
        get: (k: string) =>
          k === 'ANTHROPIC_MODEL_LIGHT' ? 'claude-sonnet-5' : undefined,
      } as unknown as ConfigService;

      expect(getModelConfig('coverletter_feedback', overridden).model).toBe(
        'claude-sonnet-5',
      );
      // openai feature 는 영향 없음
      expect(getModelConfig('note_summary', overridden).model).toBe(
        'gpt-4o-mini',
      );
    });
  });
});

/**
 * G-1 (2026-08-02) — 이 파일이 박제하는 건 이제 **코드 기본값(3단 중 마지막)** 이다.
 *
 * 실제 호출에 쓰이는 모델은 `ModelConfigService` 가 **DB → env → 여기** 순으로 정한다.
 * 그래서 이 표가 통과해도 운영 값과 다를 수 있다 — 그 사실을 명시해 둔다.
 * (DB·env 계층 자체의 검증은 `model-config.service.spec` 이 담당)
 */
describe('G-1 — 이 표의 위치', () => {
  it('FEATURE_MATRIX 는 3단 폴백의 마지막 단이다', () => {
    // 문서화 목적 — getModelConfig 는 DB 를 보지 않는다 (ConfigService 만 받는다)
    expect(getModelConfig.length).toBe(2); // (feature, config)
  });

  /**
   * 🔴 `requiresStreaming` 은 admin 저장 검증(③)의 근거다.
   * 이게 빠지면 chat 을 스트리밍 미지원 모델로 바꿔도 저장이 통과해 기능이 죽는다.
   */
  it('스트리밍이 필요한 feature 가 선언돼 있다', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    expect(getModelConfig('coverletter_chat', config).requiresStreaming).toBe(
      true,
    );
    // 나머지는 비스트리밍 — 잘못 켜두면 선택지가 근거 없이 좁아진다
    expect(
      getModelConfig('coverletter_feedback', config).requiresStreaming,
    ).toBeUndefined();
  });
});

/**
 * 🔴 **살아있는 feature 와 퇴역 feature 의 경계를 고정한다** (2026-08-03).
 *
 * 이 경계가 없어서 **한 번도 호출된 적 없는 6개**가 1년 넘게 설정에 남아 있었고,
 * G-1 admin 매트릭스가 화면이 되면서 관리자에게 14줄 중 6줄이 죽은 항목으로 노출됐다.
 * (`coverletter` 와 `coverletter_draft_v2` 가 나란히 떠 어느 쪽이 진짜인지 알 수 없었다)
 *
 * 앞으로 feature 를 퇴역시키는 사람이 **타입만 옮기고 매트릭스를 안 지우면** 여기서 깨진다.
 */
/** 위 describe 안의 EXPECTED 와 같은 키 집합 — 경계 검증용으로 따로 둔다 */
const EXPECTED_KEYS: Record<ActiveLlmFeature, true> = {
  note_summary: true,
  coverletter_draft_v2: true,
  coverletter_feedback: true,
  coverletter_recommend: true,
  coverletter_chat: true,
  interview_prep_session: true,
  interview_prep_followup: true,
  jobposting_parse: true,
};

describe('ActiveLlmFeature 경계', () => {
  const RETIRED = [
    'coverletter',
    'interview',
    'interview_followup',
    'score',
    'analysis',
    'auto_tag',
    'company_research',
  ] as const;

  /**
   * 매트릭스에 없으면 `getModelConfig` 이 note_summary 설정으로 떨어진다.
   * 즉 **note_summary 와 같은 값이 나오는 것** 이 "매트릭스에 없다" 의 증거다.
   * (note_summary 자체는 당연히 같으므로 대상에서 제외)
   */
  it.each(RETIRED)('퇴역 feature 는 매트릭스에 없다: %s', (f) => {
    const config = new ConfigService();
    const cfg = getModelConfig(f, config);
    const noteSummary = getModelConfig('note_summary', config);
    expect(cfg.maxInputTokens).toBe(noteSummary.maxInputTokens);
    expect(cfg.maxOutputTokens).toBe(noteSummary.maxOutputTokens);
    expect(cfg.defaultModel).toBe(noteSummary.defaultModel);
  });

  /**
   * 🔴 매트릭스 키 = DB `feature_model_config` 행이어야 한다.
   * 어긋나면 admin 화면에 **설정할 수 없는 행**이나 **화면에 없는 설정**이 생긴다.
   * (마이그레이션 1784600000000 이 DB 쪽 6행을 지웠다)
   */
  it('매트릭스는 살아있는 8개뿐이다', () => {
    expect(Object.keys(EXPECTED_KEYS).sort()).toEqual(
      [
        'coverletter_chat',
        'coverletter_draft_v2',
        'coverletter_feedback',
        'coverletter_recommend',
        'interview_prep_followup',
        'interview_prep_session',
        'jobposting_parse',
        'note_summary',
      ].sort(),
    );
  });
});
