import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

const INTERVIEW_TYPES = ['technical', 'personality', 'etc'] as const;

export class UpdateSessionDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(1)
  @MaxLength(40)
  round?: string;

  @IsOptional()
  @IsIn(INTERVIEW_TYPES)
  interviewType?: (typeof INTERVIEW_TYPES)[number] | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  myMemo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  jobDescription?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  emphasisPoints?: string | null;

  /** Phase 4 — 자료 변경 후 "다시 생성" 흐름. IDOR batch 가드는 service 가 재실행 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  coverletterIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  extraLogIds?: string[];
}
