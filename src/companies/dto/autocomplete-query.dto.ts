import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * W2 — 회사명 자동완성 query.
 *
 * GET /companies/autocomplete?q=string&limit=10
 *
 * - q 빈 string OR 미전송 → 빈 배열 (타이핑 전엔 추천 근거가 없다)
 * - q 100자 초과 → 400
 * - limit 11+ → 10 cap
 */
export class AutocompleteQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}
