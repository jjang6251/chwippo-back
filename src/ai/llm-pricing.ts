/**
 * OpenAI 모델별 토큰당 USD 단가 (2025-10 기준 공식 가격).
 * 비용 변경 시 이 파일만 업데이트.
 */
export const LLM_PRICING_PER_MILLION_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
};

const FALLBACK = { input: 1.0, output: 4.0 };

export function calcCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = LLM_PRICING_PER_MILLION_TOKENS[model] ?? FALLBACK;
  const inputCost = (promptTokens / 1_000_000) * price.input;
  const outputCost = (completionTokens / 1_000_000) * price.output;
  return Number((inputCost + outputCost).toFixed(6));
}
