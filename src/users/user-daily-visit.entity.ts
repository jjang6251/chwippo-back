import { Entity, PrimaryColumn } from 'typeorm';

/**
 * A8 — 일별 방문 기록 (코호트 리텐션 D7/D30 · 정확한 DAU 소스).
 * insert 는 jwt.strategy 의 KST 일 1회 분기에서만 (ON CONFLICT DO NOTHING).
 */
@Entity('user_daily_visits')
export class UserDailyVisit {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({ name: 'visit_date', type: 'date' })
  visitDate: string;
}
