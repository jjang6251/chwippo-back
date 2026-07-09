import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * activity-redesign — 퀵캡처 로그 생성.
 * - activityId 없으면 유저 기본함(inbox)으로
 * - isRest: 쉬어가기 (같은 KST 날짜 멱등 · autoTag 미호출)
 * - relatedStepId: 일정 질문 카드 답변이 가리키는 전형 스텝
 * content 는 rest 가 아니면 필수 (서비스에서 검증 — rest 는 기본 문구 대체)
 */
export class QuickCreateActivityLogDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MaxLength(200)
  content?: string;

  @IsOptional()
  @IsUUID()
  activityId?: string;

  @IsOptional()
  @IsUUID()
  relatedStepId?: string;

  @IsOptional()
  @IsBoolean()
  isRest?: boolean;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}
