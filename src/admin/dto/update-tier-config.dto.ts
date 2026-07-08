import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * PR_B2 Phase 3 — tier_config 수정 (Q3 C admin 선택 immediate vs next_reset).
 *
 * cap 정책:
 * - monthlyCoinLimit @Max(10000) — 운영 사고 시뮬 S2 (잘못 변경 → cost 폭증)
 * - inputTokenCapPerCall @Max(64000) — provider 한계 + cost 통제
 * - 모든 수치 @Min(0) — 음수 차단
 *
 * **applyMode**:
 * - `immediate`: tier_configs UPDATE + user_coin_balances 즉시 반영 (diff 만큼 balance ±)
 * - `next_reset`: tier_configs only — cron 이 다음 reset 시점 자동 반영 (사용자 보호)
 */
export class UpdateTierConfigDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  monthlyCoinLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(64000)
  inputTokenCapPerCall?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  defaultCooldownSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10080) // 7 days in minutes
  noteSummaryCooldownMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000000) // 1천만원
  priceKrw?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsIn(['immediate', 'next_reset'])
  applyMode: 'immediate' | 'next_reset';
}
