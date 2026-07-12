import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** 통합 목록 필터 — 조사 캐시 ∪ 지원 카드 병합 행 기준 */
export type UnifiedResearchFilter =
  | 'all'
  | 'unresearched'
  | 'expiring'
  | 'expired'
  | 'optout';

/** 정렬 화이트리스트 — 이 외 값은 ValidationPipe 에서 400 */
export type UnifiedResearchSort =
  | 'name'
  | 'applicants'
  | 'cards'
  | 'hitCount'
  | 'updatedAt'
  | 'inferredCount';

export type SortOrder = 'asc' | 'desc';

export class UnifiedCompanyResearchDto {
  /** 회사명 부분 검색 (정규화 소문자 includes, 서비스에서 병합 후 적용) */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsIn(['all', 'unresearched', 'expiring', 'expired', 'optout'])
  filter?: UnifiedResearchFilter;

  @IsOptional()
  @IsIn([
    'name',
    'applicants',
    'cards',
    'hitCount',
    'updatedAt',
    'inferredCount',
  ])
  sort?: UnifiedResearchSort;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: SortOrder;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
