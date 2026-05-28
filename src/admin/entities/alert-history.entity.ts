import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AlertType =
  | 'daily_cost'
  | 'hourly_error_rate'
  | 'vs_yesterday'
  | 'abuser_ban'
  | 'test'
  // 5.6.10 — provider health cron (5분) detect status 변경
  | 'provider_down'
  | 'provider_up';

export type WebhookStatus =
  | 'sent'
  | 'failed'
  | 'skipped_dedup'
  | 'skipped_no_webhook';

/**
 * F6 PR 2 Phase 5.4 — 알람 발송 audit.
 *
 * dedup: 같은 alert_type 의 1시간 내 'sent' row 있으면 이번 cron 은 'skipped_dedup' 만 insert.
 * abuser_ban 도 통합 가시화를 위해 같은 테이블에 기록.
 */
@Entity('alert_history')
@Index('idx_alert_history_type_created', ['alertType', 'createdAt'])
export class AlertHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'alert_type', type: 'varchar', length: 40 })
  alertType: AlertType;

  @Column({
    name: 'triggered_value',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number(v)),
    },
  })
  triggeredValue: number;

  @Column({
    name: 'threshold_value',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number(v)),
    },
  })
  thresholdValue: number;

  @Column({ type: 'text' })
  message: string;

  @Column({ name: 'webhook_status', type: 'varchar', length: 20 })
  webhookStatus: WebhookStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
