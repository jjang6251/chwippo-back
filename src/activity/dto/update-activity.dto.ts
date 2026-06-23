import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ACTIVITY_TYPES } from './create-activity.dto';
import type { ActivityTypeDto } from './create-activity.dto';

export class UpdateActivityDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(ACTIVITY_TYPES)
  type?: ActivityTypeDto;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  org?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  role?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  resultUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  outcome?: string;

  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @IsOptional()
  @IsDateString()
  endedAt?: string;

  /**
   * 활동 총괄 회고 — 끝난 활동을 한꺼번에 wrap up 하는 큰 문단.
   * NULL 또는 빈 string 으로 clear.
   * char 5000 cap.
   */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  summaryReflection?: string | null;
}
