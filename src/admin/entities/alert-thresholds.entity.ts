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

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updatedByUser: User | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
