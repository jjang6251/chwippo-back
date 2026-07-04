import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { DeadlinePoints } from '../notification.types';

const DEADLINE_POINTS: DeadlinePoints[] = ['d1', 'd3', 'd7'];

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

  @IsOptional()
  @IsBoolean()
  deadlineUrgentEnabled?: boolean;
}
