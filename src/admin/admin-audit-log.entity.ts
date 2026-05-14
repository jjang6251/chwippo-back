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
  | 'publish_announcement'
  | 'update_announcement'
  | 'delete_announcement';

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
