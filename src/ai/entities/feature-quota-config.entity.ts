import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';
import type { LlmFeature } from './llm-call-log.entity';

/**
 * F6 PR 2 Phase 1 — feature 별·tier 별 quota 설정 (admin 동적 조절).
 *
 * **PK = (feature, tier)** — tier 별 독립. 'free' 변경이 'lite'/'standard' 영향 0 (유료 보호).
 *
 * **컬럼 의미**:
 * - `dayLimit` — 24h 호출 한도 (status='ok'+'retry_parsing' 카운트)
 * - `monthLimit` — 이번 달 호출 한도
 * - `cooldownSeconds` — 마지막 ok 호출 + N 초 이후 다음 호출 허용
 * - `enabled` — kill switch. false 면 모든 호출 즉시 blocked (admin 운영 통제)
 *
 * **변경 흐름**:
 * 1. admin PATCH `/admin/ai-feature-quotas/:feature/:tier` 호출
 * 2. updated_by · updated_at 갱신 + admin_audit_logs 'update_ai_quota' 또는 'toggle_ai_feature' audit
 * 3. 다음 사용자 호출부터 즉시 적용 (캐시 X — 매 호출 DB 조회, 10ms 추가 수용)
 */
// PR_B2 Phase 0 — CoinTier 와 통일. 마이그레이션 1780400 으로 DB CHECK 도 'free'|'lite'|'standard'
export type QuotaTier = 'free' | 'lite' | 'standard';

@Entity('feature_quota_configs')
export class FeatureQuotaConfig {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  feature: LlmFeature;

  @PrimaryColumn({ type: 'varchar', length: 20 })
  tier: QuotaTier;

  @Column({ name: 'day_limit', type: 'int' })
  dayLimit: number;

  @Column({ name: 'month_limit', type: 'int' })
  monthLimit: number;

  @Column({ name: 'cooldown_seconds', type: 'int' })
  cooldownSeconds: number;

  /**
   * F6 PR 2 Phase 5.6.8 — 리소스별 24h 한도 (같은 노트/자소서/세션 N회).
   * NULL = 미사용. 현재는 NoteSummaryService (note_summary) 만 활용.
   */
  @Column({
    name: 'per_resource_day_limit',
    type: 'int',
    nullable: true,
  })
  perResourceDayLimit: number | null;

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
