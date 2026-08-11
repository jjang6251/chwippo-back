import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CoinService } from './coin.service';
import type { ActiveLlmFeature } from './entities/llm-call-log.entity';

/**
 * 공개 조회를 허용하는 feature 화이트리스트.
 *
 * 🔴 **전체 feature 를 자동으로 열지 않는다.** `feature_coin_meta` 는 운영 원가 테이블이라
 * 아직 화면에 없는 기능·우리 부담 기능까지 통째로 노출할 이유가 없다. 화면에 "약 N코인" 을
 * 그리는 자리가 생길 때 **그 feature 만** 여기에 추가한다 (DTO 가 그대로 400 을 만든다).
 */
export const AI_COST_PUBLIC_FEATURES: ActiveLlmFeature[] = [
  'interview_prep_session',
];

/** `count` 허용 범위 — 지금 이 API 를 쓰는 유일한 화면(AI 질문 생성 팝오버)의 슬라이더 범위 */
export const AI_COST_COUNT_MIN = 1;
export const AI_COST_COUNT_MAX = 20;

export class AiCostQueryDto {
  @IsIn(AI_COST_PUBLIC_FEATURES)
  feature: ActiveLlmFeature;

  /**
   * 만들 개수. **지금은 응답값에 영향을 주지 않는다** (`countSensitive: false` 참조).
   * 그래도 받고 검증하는 이유는 두 가지다 — 프론트가 "보내도 되는 값" 을 알 수 있고,
   * 나중에 개수 비례 예약치로 바뀌어도 **호출 형태가 안 바뀐다.**
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(AI_COST_COUNT_MIN)
  @Max(AI_COST_COUNT_MAX)
  count?: number;
}

export interface AiCostEstimate {
  feature: ActiveLlmFeature;
  /** false = 우리 부담 (차감 0) */
  chargesCoins: boolean;
  /**
   * 🔴 **예약치이지 청구액이 아니다.** 호출 전 "잔액이 이만큼은 있어야 시작한다" 는
   * 게이트 기준(`CoinService.canCharge`)과 **같은 숫자**다. 실제 차감은 끝난 뒤
   * 토큰 실비로 환산하므로 **보통 이보다 적다.** 화면 문구도 "약 N코인" 처럼 근사로 쓴다.
   */
  estimatedCoins: number;
  /**
   * 예약치가 `count` 에 따라 달라지는가. 지금은 항상 false — 예약치는 feature 단위
   * (`feature_coin_meta.avg_coin_cost × 1.2`)이고 개수를 안 본다. 프론트는 이 값이
   * false 면 슬라이더를 움직여도 **재조회할 필요가 없다.**
   */
  countSensitive: boolean;
}

/**
 * 질문 은행 D1c — **예상 코인 공개 조회** (읽기 전용 · 인증 필수 · admin 아님).
 *
 * 🔴 이 API 의 존재 이유는 하나다 — **프론트가 단가를 하드코딩하지 않게 하는 것.**
 * admin 이 `feature_coin_meta` 를 고치면 화면 숫자가 같이 움직여야 한다. 프론트에 상수를
 * 박으면 admin 조절이 화면에서만 거짓말을 한다.
 *
 * 사용자별 값이 아니라 `@CurrentUser` 를 안 받는다. 그래도 인증은 건다 — 원가 테이블은
 * 로그인한 사용자에게만 보여준다 (비로그인에게 열어 줄 이유가 없다).
 *
 * 참고: `COIN_SYSTEM_ENABLED=false` 로 과금을 통째로 끄면 실제 차감은 0 이 되지만 이 API 는
 * 예약치를 그대로 보고한다 — 표시가 실제보다 **큰** 쪽이라 안전 방향이고, 그 킬스위치가
 * 켜진 순간은 코인 UI 전체가 무의미한 상태다.
 */
@Controller('me/ai-costs')
@UseGuards(AuthGuard('jwt'))
export class MyAiCostsController {
  constructor(private readonly coinService: CoinService) {}

  @Get()
  async estimate(@Query() query: AiCostQueryDto): Promise<AiCostEstimate> {
    const { chargesCoins, estimatedCoins } =
      await this.coinService.estimateCoins(query.feature);
    return {
      feature: query.feature,
      chargesCoins,
      estimatedCoins,
      countSensitive: false,
    };
  }
}
