/**
 * LLM 모델별 토큰당 USD 단가 (per million tokens, 2026-05 기준 공식 가격).
 * 비용 변경 시 이 파일만 업데이트.
 */
export const LLM_PRICING_PER_MILLION_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  // OpenAI
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  // Anthropic (PR 0)
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
};

const FALLBACK = { input: 1.0, output: 4.0 };

/** Anthropic prompt cache 단가 비율 (input 대비): write ×1.25 · read ×0.10 */
const CACHE_WRITE_RATIO = 1.25;
const CACHE_READ_RATIO = 0.1;
/** Anthropic web_search tool — $10 / 1,000회 */
const WEB_SEARCH_USD_PER_CALL = 0.01;

/**
 * 모델별 실단가 USD 합산.
 *
 * A1 선행 보수 (2026-07-06) — 기존엔 입력·출력만 합산해 캐시·web_search 비용이
 * cost_usd 컬럼에서 누락됐다 (사용자 코인 차감은 CoinService 가 별도로 전부 포함
 * — 이 함수는 내부 관측용: cost guard·Discord 알람·admin 비용 집계의 소스).
 */
export function calcCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  extras?: {
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    webSearchCount?: number;
  },
): number {
  const price = LLM_PRICING_PER_MILLION_TOKENS[model] ?? FALLBACK;
  const inputCost = (promptTokens / 1_000_000) * price.input;
  const outputCost = (completionTokens / 1_000_000) * price.output;
  const cacheWriteCost =
    ((extras?.cacheCreationTokens ?? 0) / 1_000_000) *
    price.input *
    CACHE_WRITE_RATIO;
  const cacheReadCost =
    ((extras?.cacheReadTokens ?? 0) / 1_000_000) *
    price.input *
    CACHE_READ_RATIO;
  const webSearchCost = (extras?.webSearchCount ?? 0) * WEB_SEARCH_USD_PER_CALL;
  return Number(
    (
      inputCost +
      outputCost +
      cacheWriteCost +
      cacheReadCost +
      webSearchCost
    ).toFixed(6),
  );
}
