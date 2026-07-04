import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { NotificationType } from './notification.types';

/**
 * 인앱 알림 센터 항목. cron/admin 발송 시 push 와 함께 insert.
 * 헤더 종 아이콘 목록 · 놓친 알림 백업.
 */
@Entity('notifications')
@Index(['userId', 'createdAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 30 })
  type!: NotificationType;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  /** 탭 시 이동할 우리 앱 내부 경로 (예 '/board/:id') · NULL = 이동 없음 */
  @Column({ name: 'deep_link', type: 'varchar', length: 500, nullable: true })
  deepLink!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  read!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
