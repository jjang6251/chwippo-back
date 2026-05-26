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

const INTERVIEW_TYPES = [
  'technical',
  'behavioral',
  'personality',
  'case',
  'codingtest',
  'etc',
] as const;

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
}
