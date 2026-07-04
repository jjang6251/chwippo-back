import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { NotificationType } from './notification.types';

/**
 * 발송 로그 + 중복 발송 방지.
 * dedup UNIQUE 는 KST 날짜 기준 (마이그레이션 참조) — briefing·deadline_urgent 만.
 */
@Entity('notification_logs')
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 30 })
  type!: NotificationType;

  @CreateDateColumn({ name: 'sent_at', type: 'timestamptz' })
  sentAt!: Date;

  /** Expo push ticket/receipt (디버깅·재전송 판단) */
  @Column({ name: 'push_response', type: 'jsonb', nullable: true })
  pushResponse!: Record<string, unknown> | null;
}
