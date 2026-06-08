import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * PR_B2 Phase 3 — feature_coin_meta 수정.
 *
 * cap (Q26):
 * - fixedCoinCost @Max(1000) — 1회 호출 1000 코인 cap (회사조사=50 가 표준)
 * - avgCoinCost @Max(1000) — token 환산 추정값
 *
 * 즉시 적용 — 다음 LLM 호출부터 새 정책. confirm UI (frontend) 강제.
 */
export class UpdateFeatureCoinMetaDto {
  @IsOptional()
  @IsBoolean()
  chargesCoins?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  fixedCoinCost?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  avgCoinCost?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}
