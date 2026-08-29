import { ConfigService } from '@nestjs/config';
import { CoinService } from './coin.service';
import { LlmFeature } from './entities/llm-call-log.entity';
import { AI_RECOMMEND_SCHEMA } from '../applications/ai-coverletter-draft.service';
import { FEEDBACK_SCHEMA } from '../applications/ai-coverletter-feedback.service';
import { CHAT_JSON_SCHEMA } from '../applications/coverletter-chat.service';
import { JOB_POSTING_SCHEMA } from '../applications/job-posting.service';
import { CARD_SCHEMA } from '../applications/job-posting-card.prompt';
import {
  FOLLOWUP_JSON_SCHEMA,
  SESSION_JSON_SCHEMA,
} from '../interview-prep/interview-prep-ai.service';
import { getModelConfig } from './model-config';
import {
  MODEL_REGISTRY,
  canonicalModelId,
  effectivePricing,
  getModelSpec,
  listModels,
  reasoningArgs,
} from './model-registry';

/**
 * G-1 — 레지스트리는 **모델을 데이터로 다루기 위한 단일 소스**다.
 *
 * 여기가 틀리면 비용·코인·호출 파라미터가 전부 조용히 틀어진다. 특히:
 *  - 별칭이 빠지면 → 호출은 되는데 단가표에 없어 FALLBACK 으로 계산 (원가 과소 기록)
 *  - 배율이 틀리면 → 모델 비교의 저울이 기울어 벤치 결론 자체가 못 쓰게 됨
 */
describe('MODEL_REGISTRY', () => {
  describe('조회·별칭', () => {
    it('등록된 모델을 spec 으로 반환한다', () => {
      const spec = getModelSpec('claude-haiku-4-5-20251001');
      expect(spec?.provider).toBe('anthropic');
      expect(spec?.label).toBe('Claude Haiku 4.5');
    });

    /**
     * 🔴 2-2 회귀 방어. `FEATURE_MATRIX.defaultModel` 이 `claude-haiku-4-5`(별칭)인데
     * 단가표 키는 날짜가 붙은 정식 id 였다. env 가 비면 단가표 조회가 빗나가
     * FALLBACK($1/$4)으로 계산돼 **출력 원가가 20% 적게 기록**된다.
     */
    it('별칭도 같은 spec 으로 해석된다 (단가 조회가 빗나가지 않게)', () => {
      expect(canonicalModelId('claude-haiku-4-5')).toBe(
        'claude-haiku-4-5-20251001',
      );
      expect(getModelSpec('claude-haiku-4-5')).toBe(
        getModelSpec('claude-haiku-4-5-20251001'),
      );
    });

    it('미등록 모델은 null — 호출부가 판단하게 한다', () => {
      expect(getModelSpec('gpt-9-turbo-ultra')).toBeNull();
      expect(canonicalModelId('gpt-9-turbo-ultra')).toBeNull();
    });

    it('같은 별칭을 두 모델이 주장하지 않는다', () => {
      const seen = new Set<string>();
      for (const spec of Object.values(MODEL_REGISTRY)) {
        for (const alias of spec.aliases ?? []) {
          expect(seen.has(alias)).toBe(false);
          seen.add(alias);
        }
      }
    });
  });

  /**
   * 🔴 **이 작업 전체의 안전 근거.**
   *
   * 코인 계산을 "Haiku 단가 하드코딩" 에서 "레지스트리 파생" 으로 바꾸는 중이다.
   * Haiku 를 계속 쓰는 한 **차감액이 1원도 달라지면 안 된다.** 리터럴을 복붙하지 않고
   * 실제 상수(`CoinService.COST_PER_M`)와 대조해, 한쪽만 바뀌면 반드시 깨지게 한다.
   */
  describe('하위호환 불변식 — 현행 하드코딩과 일치', () => {
    const haiku = MODEL_REGISTRY['claude-haiku-4-5-20251001'].pricing;
    const legacy = CoinService.COST_PER_M;

    it('input·output 단가가 COST_PER_M 과 같다', () => {
      expect(haiku.input).toBe(legacy.input);
      expect(haiku.output).toBe(legacy.output);
    });

    it('캐시 배율에서 파생한 값이 COST_PER_M 과 같다', () => {
      expect(haiku.input * haiku.cacheWriteRatio).toBe(legacy.cacheCreation);
      expect(haiku.input * haiku.cacheReadRatio).toBe(legacy.cacheRead);
    });

    it('출력 배율(output÷input)이 현행 하드코딩 5 와 같다', () => {
      expect(haiku.output / haiku.input).toBe(5);
    });

    it('web_search 단가가 현행 환산값과 같다 (10,000 token-equivalent)', () => {
      // calculateCoin 은 webSearch 1회 = 10,000 token-equivalent 로 계산한다.
      // = $0.01 ÷ ($1/1M) → input 토큰 10,000개어치
      expect(haiku.webSearchUsdPerCall).not.toBeNull();
      expect((haiku.webSearchUsdPerCall! * 1_000_000) / haiku.input).toBe(
        legacy.webSearch,
      );
    });
  });

  /**
   * 🔴 미등록 모델이 기본값으로 남아 있으면 FALLBACK 경로가 살아남는다.
   * 이 spec 이 신규 feature 추가 시 레지스트리 등록을 강제한다.
   */
  describe('FEATURE_MATRIX 와의 정합', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const FEATURES: LlmFeature[] = [
      'note_summary',
      'auto_tag',
      'score',
      'analysis',
      'coverletter',
      'interview',
      'interview_followup',
      'coverletter_draft_v2',
      'coverletter_feedback',
      'coverletter_recommend',
      'interview_prep_session',
      'interview_prep_followup',
      'coverletter_chat',
      'jobposting_parse',
      'jobposting_card',
    ];

    it.each(FEATURES)('%s 의 기본 모델이 레지스트리에 있다', (feature) => {
      const cfg = getModelConfig(feature, config);
      const spec = getModelSpec(cfg.model);
      expect(spec).not.toBeNull();
    });

    it.each(FEATURES)('%s 의 provider 가 모델 선언과 일치한다', (feature) => {
      const cfg = getModelConfig(feature, config);
      expect(getModelSpec(cfg.model)!.provider).toBe(cfg.provider);
    });

    it.each(FEATURES)(
      '%s 의 출력 한도가 모델 상한을 넘지 않는다',
      (feature) => {
        const cfg = getModelConfig(feature, config);
        expect(cfg.maxOutputTokens).toBeLessThanOrEqual(
          getModelSpec(cfg.model)!.maxOutputTokens,
        );
      },
    );
  });

  /**
   * 🔴 캐시 배율을 provider 무관 상수로 두면 OpenAI 비용이 부풀어
   * "어느 모델이 싼가" 판단이 왜곡된다 — 벤치의 저울이 기우는 지점.
   */
  describe('provider 별 차이가 실제로 다르게 선언돼 있다', () => {
    it('캐시 읽기 할인율이 provider 마다 다르다', () => {
      expect(getModelSpec('claude-haiku-4-5')!.pricing.cacheReadRatio).toBe(
        0.1,
      );
      expect(getModelSpec('gpt-4o-mini')!.pricing.cacheReadRatio).toBe(0.5);
    });

    it('캐시 쓰기 프리미엄이 provider 마다 다르다', () => {
      expect(getModelSpec('claude-haiku-4-5')!.pricing.cacheWriteRatio).toBe(
        1.25,
      );
      expect(getModelSpec('gpt-4o-mini')!.pricing.cacheWriteRatio).toBe(1.0);
    });

    it('구조화 출력 방식이 provider 마다 다르다', () => {
      expect(getModelSpec('claude-haiku-4-5')!.structuredOutputMode).toBe(
        'tool_use',
      );
      expect(getModelSpec('gpt-4o-mini')!.structuredOutputMode).toBe(
        'json_schema_strict',
      );
    });

    it('web_search 미지원 provider 는 null (0 이 아니라)', () => {
      // 0 으로 두면 "지원하는데 공짜" 로 읽힌다 — 미지원과 구분되어야 한다
      expect(getModelSpec('gpt-4o')!.pricing.webSearchUsdPerCall).toBeNull();
    });
  });

  describe('능력 선언 — Anthropic models API 실측(2026-08-02) 반영', () => {
    /**
     * 🔴 models 엔드포인트의 capabilities 이름과 **실제 요청 형태가 다르다.**
     * 실측(2026-08-02): Haiku 는 adaptive 를 400 으로 거부하고 budget 방식만 받는다.
     * Sonnet 4.6 은 adaptive 가 되므로 budget 을 우리가 정할 필요가 없다.
     */
    it('Haiku 4.5 는 budget 방식 · Sonnet 4.6 은 adaptive', () => {
      expect(getModelSpec('claude-haiku-4-5')!.reasoning).toEqual({
        mode: 'thinking_budget',
      });
      expect(getModelSpec('claude-sonnet-4-6')!.reasoning).toEqual({
        mode: 'thinking_adaptive',
      });
    });

    it('gpt-4o 계열은 추론 파라미터가 없다', () => {
      expect(getModelSpec('gpt-4o-mini')!.reasoning).toBeNull();
      expect(getModelSpec('gpt-4o')!.reasoning).toBeNull();
    });

    /**
     * openai.provider 에 `callJsonStream` 이 없다. API 스펙이 아니라
     * **우리 어댑터 기준**이라는 걸 고정한다 — 소비자가 알고 싶은 건 실제 가능 여부다.
     */
    /**
     * 2026-08-03 OpenAI 어댑터에 `callJsonStream` 이 구현되면서 **전 모델 true** 가 됐다.
     * 이 필드가 "API 스펙" 이 아니라 **우리 어댑터 구현 기준**이라는 게 요점이므로,
     * 값을 박제하는 대신 **어댑터에 구현이 있으면 true** 라는 관계를 고정한다.
     */
    it('스트리밍 선언은 어댑터 구현과 일치한다', () => {
      const IMPLEMENTED: Record<string, boolean> = {
        anthropic: true, // anthropic.provider.callJsonStream
        openai: true, // openai.provider.callJsonStream (2026-08-03)
      };
      for (const [id, spec] of Object.entries(MODEL_REGISTRY)) {
        expect(`${id}:${spec.supportsStreaming}`).toBe(
          `${id}:${IMPLEMENTED[spec.provider]}`,
        );
      }
    });

    /**
     * 🔴 `coverletter_chat` 이 스트리밍 필수다. 이 값이 어긋나면
     * **관리자가 고를 수 있는데 런타임에 죽는** 모델이 생긴다.
     */
    it('스트리밍 필수 feature 의 기본 모델은 스트리밍을 지원한다', () => {
      const chat = getModelConfig('coverletter_chat', new ConfigService());
      expect(getModelSpec(chat.model)?.supportsStreaming).toBe(true);
    });

    /**
     * 🔴 **추정값 금지** — 값이 있으면 실측한 것이어야 한다.
     *
     * 코드가 출처를 검증할 수는 없으므로, 대신 **실측한 모델 목록을 여기 고정**한다.
     * 목록에 없는데 값이 채워지면 = 누군가 추정값을 넣었다는 뜻이라 테스트가 깨진다.
     * (2026-08-03 실측: 한국어 736자 자소서 표본 · Anthropic `count_tokens` ·
     *  OpenAI 실호출 `usage.prompt_tokens`)
     */
    const MEASURED_KO: Record<string, number> = {
      'claude-haiku-4-5-20251001': 1.011,
      'claude-sonnet-5': 1.019,
      'gpt-5.6-terra': 0.546,
      'gpt-5.6-luna': 0.546,
      'gpt-4o-mini': 0.548,
    };

    it('한국어 토큰 비율 — 실측한 모델만 값이 있다', () => {
      for (const [id, spec] of Object.entries(MODEL_REGISTRY)) {
        expect(spec.koreanTokensPerChar).toBe(MEASURED_KO[id] ?? null);
      }
    });

    /**
     * 🔴 이 격차가 **모델 선정을 뒤집은 실측**이다.
     * 표시 단가로는 Sonnet 5 인트로($2)가 Terra($2)와 같지만, Anthropic 이 같은
     * 한국어에 토큰을 1.8배 써서 **실제 청구는 Terra 가 훨씬 싸다.**
     * 이 관계가 깨지면 원가 비교 전제가 무너지므로 고정한다.
     */
    it('한국어는 Anthropic 이 OpenAI 보다 토큰을 훨씬 많이 쓴다', () => {
      const anthropic = MODEL_REGISTRY['claude-sonnet-5'].koreanTokensPerChar!;
      const openai = MODEL_REGISTRY['gpt-5.6-terra'].koreanTokensPerChar!;
      expect(anthropic / openai).toBeGreaterThan(1.5);
    });

    /**
     * 문서상 "Claude 4.7 이후 토크나이저는 30% 더 쓴다" 는 **영어 기준**이었다.
     * 한국어 실측은 0.8% 차이 — 문서 문장을 그대로 곱했으면 원가를 30% 과다 계상했다.
     */
    it('Claude 신·구 토크나이저는 한국어에선 차이가 미미하다', () => {
      const sonnet5 = MODEL_REGISTRY['claude-sonnet-5'].koreanTokensPerChar!;
      const haiku45 =
        MODEL_REGISTRY['claude-haiku-4-5-20251001'].koreanTokensPerChar!;
      expect(Math.abs(sonnet5 / haiku45 - 1)).toBeLessThan(0.05);
    });
  });

  describe('effectivePricing — 단가 유효기간', () => {
    const base = MODEL_REGISTRY['gpt-4o-mini'];

    it('validUntil 이 없으면 항상 그대로', () => {
      expect(effectivePricing(base, '2099-12-31')).toBe(base.pricing);
    });

    it('만료 당일까지는 기존 단가 (경계)', () => {
      const spec = {
        ...base,
        pricing: {
          ...base.pricing,
          input: 2,
          output: 10,
          validUntil: '2026-08-31',
          next: { input: 3, output: 15 },
        },
      };
      expect(effectivePricing(spec, '2026-08-31').input).toBe(2);
      expect(effectivePricing(spec, '2026-08-31').output).toBe(10);
    });

    it('만료 다음 날부터 next 단가 (경계)', () => {
      const spec = {
        ...base,
        pricing: {
          ...base.pricing,
          input: 2,
          output: 10,
          validUntil: '2026-08-31',
          next: { input: 3, output: 15 },
        },
      };
      expect(effectivePricing(spec, '2026-09-01').input).toBe(3);
      expect(effectivePricing(spec, '2026-09-01').output).toBe(15);
    });

    it('next 없이 validUntil 만 있으면 전환하지 않는다 (미완 선언 방어)', () => {
      const spec = {
        ...base,
        pricing: { ...base.pricing, validUntil: '2020-01-01' },
      };
      expect(effectivePricing(spec, '2026-09-01')).toBe(spec.pricing);
    });
  });

  describe('listModels', () => {
    it('provider 로 좁힐 수 있다', () => {
      const anthropic = listModels('anthropic');
      expect(anthropic.length).toBeGreaterThan(0);
      expect(anthropic.every((m) => m.provider === 'anthropic')).toBe(true);
    });

    it('인자 없으면 전체', () => {
      expect(listModels().length).toBe(Object.keys(MODEL_REGISTRY).length);
    });
  });

  describe('구조 불변식 — 새 모델을 추가할 때 지켜야 하는 것', () => {
    const entries = Object.entries(MODEL_REGISTRY);

    it.each(entries)('%s — 단가가 양수', (_id, spec) => {
      expect(spec.pricing.input).toBeGreaterThan(0);
      expect(spec.pricing.output).toBeGreaterThan(0);
    });

    it.each(entries)('%s — 출력·컨텍스트 한도가 양수', (_id, spec) => {
      expect(spec.maxOutputTokens).toBeGreaterThan(0);
      expect(spec.contextWindow).toBeGreaterThan(spec.maxOutputTokens);
    });

    it.each(entries)('%s — 캐시 배율이 0 이상', (_id, spec) => {
      expect(spec.pricing.cacheReadRatio).toBeGreaterThanOrEqual(0);
      expect(spec.pricing.cacheWriteRatio).toBeGreaterThanOrEqual(0);
    });
  });
});

/**
 * G-1 — 추론 파라미터 조립. **실제 API 에 던져 확인한 형태**(2026-08-02)를 고정한다.
 * 여기가 틀리면 벤치에서 상위 모델을 호출하는 순간 400 으로 죽는다.
 */
describe('reasoningArgs', () => {
  const HAIKU = 'claude-haiku-4-5';
  const SONNET = 'claude-sonnet-4-6';

  it('의도가 없으면 아무것도 안 붙인다 (기본 동작 불변)', () => {
    expect(reasoningArgs(HAIKU, undefined, 10_000)).toEqual({
      args: {},
      downgraded: null,
    });
  });

  describe('thinking_budget — Haiku 4.5', () => {
    it('budget 형태로 조립한다 (adaptive 는 이 모델에서 400)', () => {
      expect(reasoningArgs(HAIKU, 'low', 10_000).args).toEqual({
        thinking: { type: 'enabled', budget_tokens: 1_024 },
      });
    });

    it('의도에 따라 budget 이 커진다', () => {
      const b = (i: 'low' | 'medium' | 'high') =>
        (
          reasoningArgs(HAIKU, i, 100_000).args as {
            thinking: { budget_tokens: number };
          }
        ).thinking.budget_tokens;
      expect(b('low')).toBeLessThan(b('medium'));
      expect(b('medium')).toBeLessThan(b('high'));
    });

    /**
     * 🔴 실측: `max_tokens` 가 `budget_tokens` 이하면 400.
     * 400 으로 죽이는 대신 추론을 끄되, 조용히 넘어가지 않게 사유를 돌려준다.
     */
    it('max_tokens 가 budget 이하면 추론을 끄고 사유를 알린다', () => {
      const r = reasoningArgs(HAIKU, 'high', 1_000); // high = 16,384 > 1,000
      expect(r.args).toEqual({});
      expect(r.downgraded).toBe('max_tokens_too_small');
    });

    it('경계 — max_tokens 가 budget 과 같으면 끈다 (초과여야 함)', () => {
      expect(reasoningArgs(HAIKU, 'low', 1_024).downgraded).toBe(
        'max_tokens_too_small',
      );
      expect(reasoningArgs(HAIKU, 'low', 1_025).downgraded).toBeNull();
    });
  });

  describe('thinking_adaptive — Sonnet 4.6', () => {
    it('adaptive 는 budget 을 안 정한다 → max_tokens 제약도 없다', () => {
      const r = reasoningArgs(SONNET, 'high', 100);
      expect(r.args).toEqual({ thinking: { type: 'adaptive' } });
      expect(r.downgraded).toBeNull();
    });
  });

  describe('effort', () => {
    /** 🔴 top-level `effort` 는 400 "Extra inputs are not permitted" — output_config 안이다 */
    it('output_config 안에 넣는다 (top-level 아님)', () => {
      const EFFORT = 'test-only-effort-model';
      MODEL_REGISTRY[EFFORT] = {
        ...MODEL_REGISTRY['claude-sonnet-4-6'],
        reasoning: { mode: 'effort' },
      };
      try {
        const r = reasoningArgs(EFFORT, 'medium', 10_000);
        expect(r.args).toEqual({ output_config: { effort: 'medium' } });
        expect(r.downgraded).toBeNull();
      } finally {
        delete MODEL_REGISTRY[EFFORT];
      }
    });
  });

  describe('미지원 모델', () => {
    it('추론 미지원이면 사유를 알린다 (조용히 무시 금지)', () => {
      const r = reasoningArgs('gpt-4o-mini', 'high', 10_000);
      expect(r.args).toEqual({});
      expect(r.downgraded).toBe('unsupported');
    });

    it('미등록 모델도 사유를 알린다', () => {
      expect(reasoningArgs('gpt-9-ultra', 'low', 10_000).downgraded).toBe(
        'unsupported',
      );
    });
  });
});

/**
 * G-1 — **cross-provider 스키마 호환 검증.**
 *
 * "어떤 모델이 와도 된다" 의 마지막 조건. 구조화 출력 규격이 provider 마다 다르다:
 *   - Anthropic `tool_use`        — optional 필드 허용
 *   - OpenAI `json_schema_strict` — 🔴 **모든 property 가 required 에 있어야 함**
 *     (실측 400: "'required' is required to be supplied and to be an array
 *      including every key in properties")
 *
 * 하나라도 어기면 그 feature 는 OpenAI 모델로 **전환 자체가 불가능**하다.
 * 실제 스키마를 읽어 검사하므로, 누가 optional 필드를 추가하면 여기서 걸린다.
 *
 * (`maxItems`·`minItems` 는 OpenAI strict 에서도 통과하는 것을 실측 확인 — 검사 대상 아님)
 */
describe('cross-provider 스키마 호환', () => {
  /** 중첩 object 를 포함해 모든 properties 블록이 required 로 덮이는지 재귀 확인 */
  function findStrictViolation(
    node: Record<string, unknown>,
    path = 'root',
  ): string | null {
    const props = node.properties as Record<string, unknown> | undefined;
    if (props) {
      const required = new Set((node.required as string[]) ?? []);
      for (const key of Object.keys(props)) {
        if (!required.has(key)) {
          return `${path}.${key} 가 required 에 없음 — OpenAI strict 에서 400`;
        }
      }
      for (const [key, child] of Object.entries(props)) {
        const v = findStrictViolation(
          child as Record<string, unknown>,
          `${path}.${key}`,
        );
        if (v) return v;
      }
    }
    const items = node.items as Record<string, unknown> | undefined;
    if (items) return findStrictViolation(items, `${path}[]`);
    return null;
  }

  /**
   * 🔴 **전 feature 를 덮는다.** 하나라도 빠지면 그 feature 만 OpenAI 로 못 옮기는데,
   * 그 사실이 벤치 결과를 적용하는 순간에야 드러난다.
   */
  it.each([
    ['coverletter_chat', CHAT_JSON_SCHEMA.schema],
    ['coverletter_feedback', FEEDBACK_SCHEMA.schema],
    ['coverletter_recommend', AI_RECOMMEND_SCHEMA.schema],
    ['jobposting_parse', JOB_POSTING_SCHEMA.schema],
    ['jobposting_card', CARD_SCHEMA.schema],
    ['interview_prep_session', SESSION_JSON_SCHEMA.schema],
    ['interview_prep_followup', FOLLOWUP_JSON_SCHEMA.schema],
  ])('%s 스키마가 OpenAI strict 규격을 만족한다', (_name, schema) => {
    expect(findStrictViolation(schema as Record<string, unknown>)).toBeNull();
  });

  it('검사기 자체가 위반을 잡는다 (테스트가 죽어있지 않은지)', () => {
    const bad = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
    };
    expect(findStrictViolation(bad)).toContain('b');
  });
});
