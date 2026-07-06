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

  @IsOptional()
  @IsString()
  @MaxLength(2000)
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
