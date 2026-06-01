import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';
import type { CoinTier } from './tier-config.entity';

/**
 * PR_B1 — 사용자 plan 변경 이력.
 *
 * **컬럼 의미**:
 * - `changedBy` — 'system' (자동) / 'admin' (수동) / 'payment' (결제 인프라 통합 후)
 * - `changedByAdminId` — admin 인 경우 admin user id (운영 추적)
 * - `reason` — "수동 결제 입금 확인" 등 자유 텍스트
 *
 * **활용**:
 * - admin 페이지 (PR_B2) — user 별 plan 변경 이력 표시
 * - 환불·downgrade 처리 추적
 * - 결제 인프라 도입 후 자동 audit
 */
@Entity('user_plan_history')
export class UserPlanHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'from_tier', type: 'varchar', length: 20 })
  fromTier: CoinTier;

  @Column({ name: 'to_tier', type: 'varchar', length: 20 })
  toTier: CoinTier;

  @Column({ name: 'changed_by', type: 'varchar', length: 20 })
  changedBy: 'system' | 'admin' | 'payment';

  @Column({ name: 'changed_by_admin_id', type: 'uuid', nullable: true })
  changedByAdminId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'changed_by_admin_id' })
  changedByAdmin: User | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @CreateDateColumn({ name: 'changed_at', type: 'timestamptz' })
  changedAt: Date;
}
