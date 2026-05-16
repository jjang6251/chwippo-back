import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * 자소서 소재 (6개 회사 무관 범용) 업데이트 DTO.
 * - 모든 필드 optional, 부분 업데이트 지원
 * - 각 필드 2000자 제한 (frontend도 동일 enforcing)
 */
export class UpdateCoverletterDto {
  @IsOptional() @IsString() @MaxLength(2000) personality?: string;
  @IsOptional() @IsString() @MaxLength(2000) background?: string;
  @IsOptional() @IsString() @MaxLength(2000) job_competency?: string;
  @IsOptional() @IsString() @MaxLength(2000) own_strength?: string;
  @IsOptional() @IsString() @MaxLength(2000) collaboration?: string;
  @IsOptional() @IsString() @MaxLength(2000) challenge?: string;
}

export class CreateCoverletterCustomDto {
  @IsString() @MaxLength(50) label: string;

  @IsOptional() @IsInt() @Min(0) order_index?: number;
}

export class UpdateCoverletterCustomDto {
  @IsOptional() @IsString() @MaxLength(50) label?: string;
  @IsOptional() @IsString() @MaxLength(2000) content?: string;
  @IsOptional() @IsInt() @Min(0) order_index?: number;
}
