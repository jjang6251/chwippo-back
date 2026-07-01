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
 * 전공 자동완성 query.
 *
 * GET /schools/majors/autocomplete?q=string&limit=10
 *
 * - q 빈 string → 이름 순 상위 20
 * - q 100자 초과 → 400
 * - limit 21+ → 20 cap
 */
export class MajorAutocompleteQueryDto {
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
  @Max(20)
  limit?: number;
}
