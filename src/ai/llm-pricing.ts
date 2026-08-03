/**
 * LLM 모델별 실단가 USD 계산.
 *
 * G-1 (2026-08-02) — **단가표를 `MODEL_REGISTRY` 파생으로 전환.**
 *
 * 이전에는 이 파일에 모델 4개의 단가가 따로 박혀 있었고, 캐시 배율도
 * `CACHE_WRITE_RATIO 1.25` · `CACHE_READ_RATIO 0.1` 이라는 **provider 무관 상수**였다.
 * 두 가지가 틀어져 있었다:
 *
 *   1. 🔴 `FEATURE_MATRIX.defaultModel` 은 `claude-haiku-4-5`(별칭)인데 이 표의 키는
 *      날짜가 붙은 정식 id 여서, env 가 비면 조회가 빗나가 FALLBACK($1/$4)으로 계산됐다
 *      → **출력 원가 20% 과소 기록**. 레지스트리의 별칭 해석으로 해소.
 *   2. 🔴 캐시 배율은 **provider 마다 다르다** (Anthropic read 0.1 / OpenAI read 0.5).
 *      상수로 두면 OpenAI 비용이 5배 부풀어 **모델 비교의 저울이 기운다.**
 *
 * 이 함수는 내부 관측용이다 — cost guard · Discord 알람 · admin 비용 집계의 소스.
 * (사용자 코인 차감은 `CoinService` 가 별도로 계산한다)
 */

import { Logger } from '@nestjs/common';
import { todayKst } from '../common/datetime';
import { effectivePricing, getModelSpec } from './model-registry';

const logger = new Logger('LlmPricing');

/**
 * 레지스트리에 없는 모델을 만났을 때의 최후 단가.
 *
 * 🔴 **여기 도달하면 비용 기록이 틀린 것이다.** admin 은 레지스트리 밖 모델을 저장할 수
 * 없으므로 정상 경로에서는 도달하지 않는다. 그럼에도 남겨두는 건 계산을 멈추는 것보다
 * 기록을 남기는 게 낫기 때문이고, **대신 조용히 넘어가지 않는다** (error 로그).
 */
const FALLBACK = {
  input: 1.0,
  output: 4.0,
  cacheWriteRatio: 1.25,
  cacheReadRatio: 0.1,
  webSearchUsdPerCall: 0.01,
};

/** 같은 모델로 경고가 쏟아지지 않게 1회만 기록 */
const warnedModels = new Set<string>();

function resolvePricing(model: string, todayKstDate: string) {
  const spec = getModelSpec(model);
  if (!spec) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      logger.error(
        `MODEL_REGISTRY 에 없는 모델의 비용을 계산합니다: "${model}" — ` +
          `FALLBACK 단가로 기록되어 실제 원가와 어긋납니다. 레지스트리에 등록하세요.`,
      );
    }
    return FALLBACK;
  }
  const p = effectivePricing(spec, todayKstDate);
  return {
    input: p.input,
    output: p.output,
    cacheWriteRatio: p.cacheWriteRatio,
    cacheReadRatio: p.cacheReadRatio,
    // 미지원(null)은 0 — 지원하는데 공짜인 것과 계산 결과는 같지만 선언은 구분돼 있다
    webSearchUsdPerCall: p.webSearchUsdPerCall ?? 0,
  };
}

/**
 * 모델별 실단가 USD 합산.
 *
 * @param todayKstDate 단가 유효기간 판정 기준일(`YYYY-MM-DD`). 미지정 시 오늘(KST).
 *                     **만료 경계를 테스트로 고정하기 위해 인자로 뺐다.**
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
  todayKstDate: string = todayKst(),
): number {
  const price = resolvePricing(model, todayKstDate);

  const inputCost = (promptTokens / 1_000_000) * price.input;
  const outputCost = (completionTokens / 1_000_000) * price.output;
  const cacheWriteCost =
    ((extras?.cacheCreationTokens ?? 0) / 1_000_000) *
    price.input *
    price.cacheWriteRatio;
  const cacheReadCost =
    ((extras?.cacheReadTokens ?? 0) / 1_000_000) *
    price.input *
    price.cacheReadRatio;
  const webSearchCost =
    (extras?.webSearchCount ?? 0) * price.webSearchUsdPerCall;

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

/** 테스트 전용 — FALLBACK 경고 1회 제한 상태 초기화 */
export function __resetPricingWarnings(): void {
  warnedModels.clear();
}
