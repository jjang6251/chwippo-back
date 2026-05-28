import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AuditAction =
  | 'suspend'
  | 'unsuspend'
  | 'grant_admin'
  | 'revoke_admin'
  | 'rename'
  | 'delete'
  | 'warn'
  | 'export'
  | 'close_inquiry'
  | 'reply_inquiry'
  | 'view_inquiry' // LRR P1T3 PR J — 단건 문의 상세 조회 (본문+사용자 context 노출)
  | 'publish_announcement'
  | 'update_announcement'
  | 'delete_announcement'
  // F6 PR 1 — AbuserBanService 자동 ban 발동 (3일 연속 일 한도 도달)
  // adminUserId = NULL (시스템 자동), targetType = 'user', targetId = userId
  // detail: { reason, duration_days, daily_cap_override, triggered_feature, consecutive_days }
  | 'auto_ban_ai'
  // F6 PR 2 — admin 이 feature_quota_configs 변경 (dayLimit·monthLimit·cooldown·enabled)
  // targetType = 'feature_quota', targetId = `${feature}:${tier}`
  // detail: { feature, tier, before, after }
  | 'update_ai_quota'
  // F6 PR 2 — admin 이 user.tier 변경 (free ↔ pro ↔ enterprise, F7 결제 전 수동 부여)
  // targetType = 'user', targetId = userId, detail: { before, after }
  | 'update_tier'
  // F6 PR 2 Phase 5.4 — admin 이 alert_thresholds 변경 (daily_cost · hourly_error_rate · vs_yesterday · enabled)
  // targetType = 'alert_thresholds', targetId = '1', detail: { before, after }
  | 'update_alert_thresholds'
  // F6 PR 2 Phase 5.6.9 — admin 가 AI 사용량 reset
  // targetType='all_users' (userId 없음) | 'user' (userId 있음), targetId=userId or 'all'
  // detail: { scope, affected, resetAt }
  | 'reset_ai_quota';

@Entity('admin_audit_logs')
export class AdminAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ON DELETE SET NULL — 어드민 계정 삭제 시 로그 보존
  @Column({ name: 'admin_user_id', type: 'uuid', nullable: true })
  adminUserId: string | null;

  @Column()
  action: AuditAction;

  @Column({ name: 'target_type' })
  targetType: string;

  @Column({ name: 'target_id' })
  targetId: string;

  @Column({ type: 'jsonb', default: {} })
  detail: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
