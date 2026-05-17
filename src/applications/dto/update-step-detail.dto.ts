import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateStepDetailDto {
  // LRR P2T2 PR δ (DTO-1): IsString 단독 → IsISO8601로 형식 검증 (UpdateStepsDto와 일치)
  @IsOptional()
  @IsISO8601()
  scheduledDate?: string;

  // LRR P2T2 PR δ (DTO-2): MaxLength 100 추가 (UpdateStepsDto.StepItemDto와 일치)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  pinnedContent?: string;
}
