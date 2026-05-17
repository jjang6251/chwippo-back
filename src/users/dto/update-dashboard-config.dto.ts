import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  ValidateNested,
} from 'class-validator';

const VALID_SECTION_IDS = [
  'stats',
  'dday',
  'todos',
  'today_schedule',
  'top_applications',
  'goals',
  'calendar_mini',
  'cover_letter_quick',
] as const;

export class DashboardSectionDto {
  @IsString()
  @IsIn(VALID_SECTION_IDS)
  id: string;

  @IsBoolean()
  visible: boolean;
}

export class UpdateDashboardConfigDto {
  @IsArray()
  // LRR P1T3 PR K L-7 — 알려진 ID 8개 + 여유 → 20개 cap. self-DoS 차단
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DashboardSectionDto)
  sections: DashboardSectionDto[];
}
