import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsString, ValidateNested } from 'class-validator';

const VALID_SECTION_IDS = ['stats', 'dday', 'todos', 'today_schedule', 'top_applications', 'goals', 'calendar_mini', 'cover_letter_quick'] as const;

export class DashboardSectionDto {
  @IsString()
  @IsIn(VALID_SECTION_IDS)
  id: string;

  @IsBoolean()
  visible: boolean;
}

export class UpdateDashboardConfigDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardSectionDto)
  sections: DashboardSectionDto[];
}
