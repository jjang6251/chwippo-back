import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * PR_B2 Phase 1 — admin 사용자 정지 (Q13).
 *
 * reason 필수 (1..500자). expiresAt NULL = 영구 정지. 과거 expiresAt 은 service 에서 reject.
 */
export class SuspendUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}
