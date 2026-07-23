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
  | 'provider_up'
  // 웨이브 D — 사용자별 24h 코인차감 feature 호출 수 임계 초과 (쿨다운·한도 제거 대신 감시)
  | 'abnormal_coin_usage'
  // AI 제공사 장애 관측 — 실 호출 error 급증 감지 (LlmService error audit hook)
  | 'provider_outage';

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
// provider_outage 동시 발송 race 차단 — 같은 dedup_key 는 1건만 (partial unique, NULL 제외)
@Index('uq_alert_history_dedup_key', ['dedupKey'], {
  unique: true,
  where: '"dedup_key" IS NOT NULL',
})
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

  /**
   * 발송 idempotency 키 (provider_outage 전용). 예: `provider_outage:anthropic:{bucket}`.
   * 동시 2 레플리카가 같은 bucket 에서 발송 시도하면 UNIQUE 충돌로 1건만 성공.
   * 기존 알림 type 은 NULL (partial unique index 대상 아님).
   */
  @Column({ name: 'dedup_key', type: 'varchar', length: 200, nullable: true })
  dedupKey: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
