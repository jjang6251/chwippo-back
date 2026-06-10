import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class SetPriorityDto {
  @IsIn(['high', 'medium', 'low'])
  priority: 'high' | 'medium' | 'low';

  /** 변경 시 SLA deadline 도 새 priority 의 default 로 재계산 (default false — 기존 deadline 보존) */
  @IsOptional()
  @IsBoolean()
  recalcSla?: boolean;
}
