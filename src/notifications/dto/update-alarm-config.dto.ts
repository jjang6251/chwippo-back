import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, ValidateNested } from 'class-validator';
import {
  BRIEFING_HOURS,
  type BriefingHour,
  type DeadlinePoints,
} from '../notification.types';

const DEADLINE_POINTS: DeadlinePoints[] = ['d1', 'd3', 'd7'];

/**
 * eventToggles 부분 update — 전 필드 optional (보낸 유형만 merge).
 * whitelist+forbidNonWhitelisted 로 알 수 없는 키·비-boolean 값은 400.
 */
export class EventTogglesDto {
  @IsOptional()
  @IsBoolean()
  deadline?: boolean;

  @IsOptional()
  @IsBoolean()
  interview?: boolean;

  @IsOptional()
  @IsBoolean()
  exam?: boolean;

  @IsOptional()
  @IsBoolean()
  resultDate?: boolean;

  @IsOptional()
  @IsBoolean()
  todo?: boolean;
}

/**
 * 알림 설정 부분 update. 전 필드 optional — 보낸 것만 merge.
 * admin 통지는 config 밖 (opt-out 불가) 이라 여기 없음.
 */
export class UpdateAlarmConfigDto {
  @IsOptional()
  @IsBoolean()
  master?: boolean;

  @IsOptional()
  @IsBoolean()
  briefingEnabled?: boolean;

  @IsOptional()
  @IsIn(DEADLINE_POINTS)
  deadlinePoints?: DeadlinePoints;

  /** 아침 브리핑 시각 (KST · 7·8·9·10 중 하나) · 그 외 값 400 */
  @IsOptional()
  @IsIn(BRIEFING_HOURS)
  briefingHour?: BriefingHour;

  /** 브리핑 유형별 on/off — 부분 update (보낸 유형만 merge) */
  @IsOptional()
  @ValidateNested()
  @Type(() => EventTogglesDto)
  eventToggles?: EventTogglesDto;

  @IsOptional()
  @IsBoolean()
  deadlineUrgentEnabled?: boolean;

  /** 2시간 전 임박 리마인드 채널 on/off */
  @IsOptional()
  @IsBoolean()
  imminentEnabled?: boolean;
}
