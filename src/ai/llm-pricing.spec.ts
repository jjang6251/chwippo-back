import { calcCostUsd } from './llm-pricing';

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
