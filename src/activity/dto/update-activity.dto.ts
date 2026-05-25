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
}
