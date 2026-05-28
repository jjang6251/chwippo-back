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

/**
 * F6 PR 2 Phase 4 — 현재 AI Q&A 형식이 잘 맞는 3종만.
 * PT/토론/코딩테스트는 1:1 Q&A 가 아니라서 별도 기능 (F-후속) 으로 분리.
 */
const INTERVIEW_TYPES = ['technical', 'personality', 'etc'] as const;

export class CreateSessionDto {
  @IsUUID()
  applicationId: string;

  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(1)
  @MaxLength(40)
  round: string;

  @IsOptional()
  @IsIn(INTERVIEW_TYPES)
  interviewType?: (typeof INTERVIEW_TYPES)[number];

  /** 사용자가 선택한 자소서 문항 id — 0개 가능. 최대 30개 (token cap 고려) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  coverletterIds?: string[];

  /** 자소서 외 추가로 선택한 activity_log id — 0개 가능. 최대 30개 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  extraLogIds?: string[];

  /** 모집 요강 텍스트 (사용자가 붙여넣음) — Phase 4. 최대 8000자 (token cap 고려) */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  jobDescription?: string;

  /** 강조하고 싶은 강점/경험 — Phase 4. 최대 2000자 */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  emphasisPoints?: string;
}
