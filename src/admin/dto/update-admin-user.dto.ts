import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateAdminUserDto {
  @IsOptional()
  @IsBoolean()
  suspended?: boolean;

  @IsOptional()
  @IsIn(['user', 'admin'])
  role?: 'user' | 'admin';

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(1)
  @MaxLength(100)
  nickname?: string;

  /** 결제 tier 변경 (free/lite/standard). PR_B2 Phase 0 — CoinTier 통일. PR_B2 Phase 3 의 ForcePlanChange 가 별도 endpoint 로 분리 예정 */
  @IsOptional()
  @IsIn(['free', 'lite', 'standard'])
  tier?: 'free' | 'lite' | 'standard';
}
