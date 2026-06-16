import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';

/**
 * F6 PR 1 — 사용자별 AI quota override (abuser ban / fair-use).
 *
 * **사용 흐름**:
 * 1. LlmService 진입점 (PR 0 단일 입구) 가 매 호출 시 `findOne({user_id, valid_until > now()})` 조회
 * 2. row 존재 + valid_until 미래 → `daily_cap_override` 활성 (없으면 통상 한도)
 * 3. 만료된 row 는 자연히 무시 (cron 불필요. 새 ban 시 UPSERT)
 *
 * **trigger 정책** (Phase 3 AbuserBanService):
 * - 3일 연속 일 한도 도달 → 7일간 일 5회 + Discord webhook + `admin_audit_logs.action='auto_ban_ai'`
 * - 어드민 수동 ban·해제 → reason='manual_admin'
 */
export type UserAiQuotaReason =
  | 'auto_ban_3_consecutive_days' // 3일 연속 한도 도달 자동 ban
  | 'manual_admin' // 어드민 수동 조정
  | 'fair_use'; // 우리가 의도적으로 너그럽게 조정 (이벤트 등)

@Entity('user_ai_quotas')
@Index('idx_user_ai_quotas_valid', ['validUntil'])
export class UserAiQuota {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** NULL 이면 통상 한도. 값이면 그 값으로 일 한도 강제 (auto ban 시 5) */
  @Column({ name: 'daily_cap_override', type: 'int', nullable: true })
  dailyCapOverride: number | null;

  /** 이 시점 이후 row 무시 (자동 해제). NULL 이면 수동 해제까지 영구 */
  @Column({ name: 'valid_until', type: 'timestamptz', nullable: true })
  validUntil: Date | null;

  @Column({ type: 'varchar', length: 100 })
  reason: UserAiQuotaReason;

  /**
   * F6 PR 2 Phase 5.6.9 — admin 가 사용량 reset 시 wildcard 시각 저장.
   * shape: `{"*": "ISO timestamp"}`. dayUsed 계산 시 GREATEST(24h ago, reset_at) 적용.
   */
  @Column({
    name: 'quota_reset_at',
    type: 'jsonb',
    default: () => "'{}'::jsonb",
  })
  quotaResetAt: Record<string, string>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
