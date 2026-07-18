import { IsIn, IsOptional, IsString } from 'class-validator';
import type { NotificationType } from '../notification.types';

const NOTIFICATION_TYPES: NotificationType[] = [
  'briefing',
  'deadline_urgent',
  'admin',
];

/**
 * GET /notifications 목록 query.
 *
 * - cursor: 이전 페이지 마지막 항목 createdAt ISO (미전송 = 첫 페이지)
 * - type: 알림 유형 서버 필터 (미전송 = 전체). 잘못된 값 → 400.
 *   unreadCount 는 이 필터와 무관하게 항상 전체 미읽음 (헤더 종 배지 의미 보존).
 */
export class ListNotificationsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsIn(NOTIFICATION_TYPES)
  type?: NotificationType;
}
