import {
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  IsUrl,
  MaxLength,
  IsInt,
  Min,
  IsBoolean,
} from 'class-validator';
import type { ApplicationStatus } from '../application.entity';

export class UpdateApplicationDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @IsOptional()
  @IsString()
  jobCategory?: string;

  @IsOptional()
  @IsIn(['PLANNED', 'IN_PROGRESS', 'PASSED', 'FAILED'])
  status?: ApplicationStatus;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsUrl()
  jobUrl?: string;

  /** 회사 메모 — tiptap JSON 문자열 (텍스트 2000자는 프론트 CharacterCount 가 제한, 여기는 JSON 오버헤드 포함 상한 — 스텝 notes 와 동일 관례) */
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  memo?: string;

  /** A9 — 탈락 회고. 빈 문자열 = 삭제(null 처리) */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  failedTakeaway?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  currentStepIndex?: number;

  @IsOptional()
  @IsBoolean()
  needsDetail?: boolean;

  @IsOptional()
  @IsBoolean()
  isStarred?: boolean;
}
