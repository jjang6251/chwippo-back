import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export type SchoolKind = 'high' | 'univ';

/**
 * 학교명 자동완성 query.
 *
 * GET /schools/autocomplete?q=string&kind=high|univ&limit=10
 *
 * - kind 필수 — 학교 단계에 따라 데이터 소스 분리 (고등학교 = NEIS / 대학 = 정적)
 * - q 빈 string → 이름 순 상위 20 반환
 * - q 100자 초과 → 400
 * - limit 21+ → 20 cap
 */
export class SchoolAutocompleteQueryDto {
  @IsIn(['high', 'univ'])
  kind!: SchoolKind;

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
