import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  JOB_CATEGORIES,
  type JobCategory,
} from '../signup-job-categories.const';

/**
 * W1 — signup 1 질문 답변 DTO.
 *
 * **jobCategories**: 0~21개 (0 = "건너뛰기" 명시, 1+ = 다중 선택).
 *   enum 외 값 → 400 IsIn. 22+ → 400 ArrayMaxSize.
 *
 * **otherText**: "기타" 선택 시 자유 입력 (0~200자, trim).
 *   - "기타" 미포함 + otherText 있음 → service 가드 400
 *   - "기타" 포함 + otherText 빈 string → 200 OK (generic sample)
 *   - 공백만 ("   ") → trim 후 빈 string
 */
export class SignupAnswerDto {
  @IsArray()
  @ArrayMaxSize(21)
  @IsString({ each: true })
  @IsIn(JOB_CATEGORIES, { each: true })
  jobCategories: JobCategory[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  otherText?: string;
}
