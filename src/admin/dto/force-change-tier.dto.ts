import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * PR_B2 Phase 3 — admin 의 사용자 tier 강제 변경 (Q11 planExpiresAt + Q2 B applyMode).
 *
 * applyMode:
 * - `immediate` → 즉시 강등/upgrade (downgrade 시도 balance reset 0 위험)
 * - `next_cycle` → downgrade 의 경우 현재 cycle 끝까지 기존 tier 유지 (Q2 B 권장)
 */
export class ForceChangeTierDto {
  @IsIn(['free', 'lite', 'standard'])
  newTier: 'free' | 'lite' | 'standard';

  @IsOptional()
  @IsDateString()
  planExpiresAt?: string;

  @IsIn(['immediate', 'next_cycle'])
  applyMode: 'immediate' | 'next_cycle';

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}
