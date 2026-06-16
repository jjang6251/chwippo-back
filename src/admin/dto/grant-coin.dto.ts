import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * PR_B2 Phase 1 — admin 코인 수동 지급.
 *
 * Q1 정책 — reason enum + amount 입력 + 지급 제한 X (audit 만).
 * Q26 코드 base cap — `@Max(100000)` (10만 코인). 10000 이상은 Discord alert.
 */
export class GrantCoinDto {
  @IsInt()
  @Min(1)
  @Max(100000)
  amount: number;

  @IsIn(['refund', 'event', 'bonus', 'abuser_compensation', 'manual'])
  reason: 'refund' | 'event' | 'bonus' | 'abuser_compensation' | 'manual';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string;
}
