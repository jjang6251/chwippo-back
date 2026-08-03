import { Logger } from '@nestjs/common';
import { calcCostUsd, __resetPricingWarnings } from './llm-pricing';

/**
 * A1 선행 보수 — calcCostUsd 캐시·web_search 포함 spec.
 *
 * 시나리오:
 * - 기본 (입력·출력만) — 기존 동작 하위 호환
 * - 캐시 쓰기(×1.25)·읽기(×0.10) 가 input 단가 기준으로 합산
 * - web_search $0.01/회
 * - extras 생략 → 기존과 동일 값 (회귀 anchor)
 * - 미등록 모델 → FALLBACK 단가
 */
describe('calcCostUsd', () => {
  const M = 'claude-haiku-4-5-20251001'; // input $1/M · output $5/M

  it('입력·출력만 — 1M/1M → $6', () => {
    expect(calcCostUsd(M, 1_000_000, 1_000_000)).toBe(6);
  });

  it('extras 생략 = 기존 동작 (하위 호환 anchor)', () => {
    expect(calcCostUsd(M, 500_000, 100_000)).toBe(
      calcCostUsd(M, 500_000, 100_000, {}),
    );
  });

  it('캐시 쓰기 1M → +$1.25 (input ×1.25)', () => {
    expect(
      calcCostUsd(M, 0, 0, { cacheCreationTokens: 1_000_000 }),
    ).toBeCloseTo(1.25, 6);
  });

  it('캐시 읽기 1M → +$0.10 (input ×0.10)', () => {
    expect(calcCostUsd(M, 0, 0, { cacheReadTokens: 1_000_000 })).toBeCloseTo(
      0.1,
      6,
    );
  });

  it('web_search 5회 → +$0.05 — 회사조사 과소 관측 재발 방지 anchor', () => {
    expect(calcCostUsd(M, 0, 0, { webSearchCount: 5 })).toBeCloseTo(0.05, 6);
  });

  it('전체 합산 — research 형태 호출 (입력 8K·출력 2K·캐시읽기 4K·검색 5회)', () => {
    // 0.008 + 0.010 + 0.0004 + 0.05 = 0.0684
    expect(
      calcCostUsd(M, 8_000, 2_000, {
        cacheReadTokens: 4_000,
        webSearchCount: 5,
      }),
    ).toBeCloseTo(0.0684, 4);
  });

  it('미등록 모델 → FALLBACK (input 1.0 · output 4.0)', () => {
    expect(calcCostUsd('unknown-model', 1_000_000, 1_000_000)).toBe(5);
  });
});

/**
 * G-1 (2026-08-02) — 단가표를 `MODEL_REGISTRY` 파생으로 전환하며 **바뀐 동작**.
 *
 * 위 `calcCostUsd` describe 는 Haiku 만 검증해서 아래 두 변화를 덮지 못한다:
 *   ① 별칭(`claude-haiku-4-5`)이 정확한 단가로 해석되는가 — 이전엔 FALLBACK 이었다
 *   ② 캐시 배율이 **provider 별로** 다르게 적용되는가 — 이전엔 Anthropic 값 고정
 */
describe('calcCostUsd — 레지스트리 파생 (G-1)', () => {
  beforeEach(() => __resetPricingWarnings());

  describe('별칭 해석 — 2-2 회귀 방어', () => {
    /**
     * 🔴 `FEATURE_MATRIX.defaultModel` 이 별칭이라, env 가 비면 단가표 조회가 빗나가
     * FALLBACK($1/$4)으로 계산됐다. 출력 1M 기준 $5 여야 하는데 $4 로 기록 = 20% 과소.
     */
    it('별칭으로 호출해도 정식 단가로 계산된다', () => {
      expect(calcCostUsd('claude-haiku-4-5', 1_000_000, 1_000_000)).toBe(6);
      expect(calcCostUsd('claude-haiku-4-5', 0, 1_000_000)).toBe(5); // FALLBACK 이면 4
    });

    it('정식 id 와 별칭의 계산 결과가 같다', () => {
      const args = [500_000, 200_000] as const;
      expect(calcCostUsd('claude-haiku-4-5', ...args)).toBe(
        calcCostUsd('claude-haiku-4-5-20251001', ...args),
      );
    });
  });

  describe('캐시 배율이 provider 별로 다르다 — 벤치 저울 보정', () => {
    /**
     * 🔴 이전엔 read 0.1 을 모든 provider 에 적용했다. OpenAI 실제 할인은 50% 라
     * **OpenAI 비용이 5배 부풀어** "어느 모델이 싼가" 판단이 왜곡됐다.
     */
    it('OpenAI 캐시 읽기는 input 의 50%', () => {
      // gpt-4o-mini input $0.15/M → 1M 캐시읽기 = 0.15 × 0.5 = $0.075
      expect(
        calcCostUsd('gpt-4o-mini', 0, 0, { cacheReadTokens: 1_000_000 }),
      ).toBeCloseTo(0.075, 6);
    });

    it('Anthropic 캐시 읽기는 input 의 10%', () => {
      // claude-haiku input $1/M → 1M 캐시읽기 = $0.1
      expect(
        calcCostUsd('claude-haiku-4-5', 0, 0, { cacheReadTokens: 1_000_000 }),
      ).toBeCloseTo(0.1, 6);
    });

    it('OpenAI 캐시 쓰기는 프리미엄이 없다 (×1.0)', () => {
      expect(
        calcCostUsd('gpt-4o-mini', 0, 0, { cacheCreationTokens: 1_000_000 }),
      ).toBeCloseTo(0.15, 6);
    });

    it('Anthropic 캐시 쓰기는 ×1.25 프리미엄', () => {
      expect(
        calcCostUsd('claude-haiku-4-5', 0, 0, {
          cacheCreationTokens: 1_000_000,
        }),
      ).toBeCloseTo(1.25, 6);
    });
  });

  describe('web_search — 미지원 provider 는 0', () => {
    it('Anthropic 은 회당 $0.01', () => {
      expect(
        calcCostUsd('claude-haiku-4-5', 0, 0, { webSearchCount: 5 }),
      ).toBeCloseTo(0.05, 6);
    });

    it('OpenAI 는 미지원이라 0 (호출돼도 비용 가산 없음)', () => {
      expect(calcCostUsd('gpt-4o-mini', 0, 0, { webSearchCount: 5 })).toBe(0);
    });
  });

  describe('단가 유효기간', () => {
    it('현행 모델은 유효기간이 없어 기준일과 무관', () => {
      expect(calcCostUsd('gpt-4o', 1_000_000, 0, {}, '2026-01-01')).toBe(
        calcCostUsd('gpt-4o', 1_000_000, 0, {}, '2099-12-31'),
      );
    });
  });

  describe('미등록 모델 — 조용히 넘어가지 않는다', () => {
    it('FALLBACK 으로 계산하되 error 로그를 남긴다', () => {
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      expect(calcCostUsd('gpt-9-ultra', 1_000_000, 1_000_000)).toBe(5); // 1 + 4
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('gpt-9-ultra');

      spy.mockRestore();
    });

    it('같은 모델 반복 호출 시 로그는 1회만 (로그 폭주 방지)', () => {
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      calcCostUsd('gpt-9-ultra', 1, 1);
      calcCostUsd('gpt-9-ultra', 1, 1);
      calcCostUsd('gpt-9-ultra', 1, 1);
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });
  });
});
