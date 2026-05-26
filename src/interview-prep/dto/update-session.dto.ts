import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
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
}
