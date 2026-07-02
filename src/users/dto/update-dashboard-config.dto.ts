import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  ValidateNested,
} from 'class-validator';

// 회고=성장 재정의 후 현재 유효 섹션. 프론트가 PATCH 로 보낼 수 있는 값.
// deprecated 섹션 (dday·todos·today_schedule·top_applications·calendar_mini·goals·cover_letter_quick)
// 은 GET 응답에서 자동 필터링되므로 PATCH 로 다시 들어올 일 없음.
const VALID_SECTION_IDS = [
  'stats',
  'milestones',
  'monthly_comparison',
  'insights',
  'activity_streak',
  'status_doughnut',
  'personal_funnel',
  'interview_review',
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
