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
  | 'reset_ai_quota'
  // PR_B2 Phase 1 — admin 이 사용자에게 코인 grant
  // targetType='user', targetId=userId, detail: { amount, reason, memo?, balanceBefore, balanceAfter }
  | 'grant_coin'
  // PR_B2 Phase 1 — admin 이 사용자에게서 코인 revoke (음수 X, clamp 0)
  // targetType='user', targetId=userId, detail: { requested, actualRevoked, reason, memo?, before, after }
  | 'revoke_coin'
  // PR_B2 Phase 1 — admin 이 이미 정지된 사용자의 사유 / 만료일 갱신
  // targetType='user', targetId=userId, detail: { before: {reason, expiresAt}, after: {reason, expiresAt} }
  | 'update_suspend_reason'
  // PR_B2 Phase 1 — cron 또는 lazy 의 자동 unsuspend (system 자동, adminUserId=NULL)
  // targetType='user', targetId=userId, detail: { trigger: 'cron'|'lazy', expiredAt }
  | 'auto_unsuspend'
  // PR_B2 Phase 3 — admin 이 tier_configs 수정 (monthlyCoinLimit / cooldown / cap 등)
  // targetType='tier_config', targetId=tier, detail: { before, after, applyMode, affectedUsers }
  | 'update_tier_config'
  // PR_B2 Phase 3 — admin 이 feature_coin_meta 수정 (chargesCoins / fixedCoinCost 등)
  // targetType='feature_coin_meta', targetId=feature, detail: { before, after }
  | 'update_feature_coin_meta'
  // PR_B2 Phase 3 — admin 이 user.tier 강제 변경 + planExpiresAt 명시
  // targetType='user', targetId=userId, detail: { fromTier, toTier, planExpiresAt, reason }
  | 'change_plan_with_expires'
  // PR_B2 Phase 3 — downgrade 시 사용자 cycle 보호 (Q2 B) audit 명시
  | 'force_plan_downgrade';

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

  // PR_B2 Phase 0.3 — 모든 admin 액션의 출처 (Q4 강화). 신규 row 부터 채움
  @Column({ type: 'text', nullable: true })
  ip: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
