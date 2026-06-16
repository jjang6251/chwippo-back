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
 * PR_B2 Phase 1 — admin 코인 환수 (Q12 별도 액션, audit 분리).
 *
 * balance < amount 시 clamp 0 (응답 `actualRevoked` 로 실제 회수량 표시).
 * balance <= 0 진입 시 reject (Q26 — 이미 마이너스 상태 의미 모호).
 */
export class RevokeCoinDto {
  @IsInt()
  @Min(1)
  @Max(100000)
  amount: number;

  @IsIn(['fraud', 'mistake', 'abuser', 'manual'])
  reason: 'fraud' | 'mistake' | 'abuser' | 'manual';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string;
}
