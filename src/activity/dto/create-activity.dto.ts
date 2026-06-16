import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** mock TYPE_KO 와 1:1. 백엔드 entity ActivityType 과 동일 */
export const ACTIVITY_TYPES = [
  'intern',
  'club',
  'study',
  'project',
  'sideproject',
  'contest',
  'research',
  'parttime',
  'volunteer',
  'overseas',
  'bootcamp',
  'other',
] as const;

export type ActivityTypeDto = (typeof ACTIVITY_TYPES)[number];

export class CreateActivityDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsIn(ACTIVITY_TYPES)
  type: ActivityTypeDto;

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
