import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';

/**
 * F6 PR 2 Phase 5.4 — 임계치 알람 설정 (단일 row, CHECK id=1).
 * admin UI 에서 동적 통제 — memory `feedback_admin_quota_control` 강화.
 */
@Entity('alert_thresholds')
export class AlertThresholds {
  @PrimaryColumn({ type: 'int', default: 1 })
  id: number;

  @Column({
    name: 'daily_cost_threshold_usd',
    type: 'numeric',
    precision: 8,
    scale: 2,
    default: 50,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number(v)),
    },
  })
  dailyCostThresholdUsd: number;

  @Column({
    name: 'hourly_error_rate_threshold',
    type: 'numeric',
    precision: 4,
    scale: 3,
    default: 0.1,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number(v)),
    },
  })
  hourlyErrorRateThreshold: number;

  @Column({
    name: 'vs_yesterday_increase_threshold',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 200,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number(v)),
    },
  })
  vsYesterdayIncreaseThreshold: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // PR_B2 Phase 1 — admin grant alert (S1)
  @Column({ name: 'admin_grant_per_hour_alert', type: 'int', default: 10000 })
  adminGrantPerHourAlert: number;

  @Column({ name: 'admin_grant_single_alert', type: 'int', default: 10000 })
  adminGrantSingleAlert: number;

  // PR_B2 Phase 2 — 신규 4 임계치 (Q5 모든 alert)
  @Column({ name: 'inquiry_sla_hours', type: 'int', default: 24 })
  inquirySlaHours: number;

  @Column({ name: 'abuser_suspect_daily_calls', type: 'int', default: 100 })
  abuserSuspectDailyCalls: number;

  @Column({ name: 'free_user_signup_spike_pct', type: 'int', default: 200 })
  freeUserSignupSpikePct: number;

  @Column({
    name: 'cost_outlier_stddev',
    type: 'numeric',
    precision: 4,
    scale: 2,
    default: 2.0,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number(v)),
    },
  })
  costOutlierStddev: number;

  // AI cost guard — per-user / per-feature daily USD cost cap
  @Column({
    name: 'per_user_daily_cost_usd',
    type: 'numeric',
    precision: 8,
    scale: 4,
    default: 0.5,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number(v)),
    },
  })
  perUserDailyCostUsd: number;

  @Column({
    name: 'per_feature_daily_cost_usd',
    type: 'numeric',
    precision: 8,
    scale: 4,
    default: 5.0,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number(v)),
    },
  })
  perFeatureDailyCostUsd: number;

  // AI 제공사 장애 알림 — 최근 10분(고정 윈도우) 해당 provider error ≥ N 건 → Discord critical
  @Column({ name: 'ai_outage_alert_count_10m', type: 'int', default: 3 })
  aiOutageAlertCount10m: number;

  // 동일 provider 재발송 쿨다운(분) — sliding window
  @Column({ name: 'ai_outage_alert_cooldown_min', type: 'int', default: 30 })
  aiOutageAlertCooldownMin: number;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updatedByUser: User | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
