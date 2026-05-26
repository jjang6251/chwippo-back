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

  /** F6 PR 2 — 결제 tier 변경 (free/pro/enterprise). F7 결제 인프라 도입 전 admin 수동 부여용 */
  @IsOptional()
  @IsIn(['free', 'pro', 'enterprise'])
  tier?: 'free' | 'pro' | 'enterprise';
}
