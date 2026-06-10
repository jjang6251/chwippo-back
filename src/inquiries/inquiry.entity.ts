import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('inquiries')
export class Inquiry {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ nullable: true }) user_id: string;
  @Column() category: string;
  @Column() title: string;
  @Column({ type: 'text' }) content: string;
  @Column({ default: 'OPEN' }) status: string; // OPEN | IN_PROGRESS | CLOSED
  @Column({ default: 0 }) user_unread: number;
  @Column({ default: 1 }) admin_unread: number; // 새 문의는 어드민 미읽음 1로 시작

  // PR_B2 Phase 4 — assign / priority / SLA
  @Column({ name: 'assigned_to', type: 'uuid', nullable: true })
  assignedTo: string | null;

  @Column({ type: 'varchar', length: 10, default: 'medium' })
  priority: 'high' | 'medium' | 'low';

  @Column({ name: 'sla_deadline_at', type: 'timestamptz', nullable: true })
  slaDeadlineAt: Date | null;

  @CreateDateColumn() created_at: Date;
}

/** PR_B2 Phase 4 — priority 별 default SLA (시간 단위). */
export const SLA_DEFAULT_HOURS: Record<'high' | 'medium' | 'low', number> = {
  high: 4,
  medium: 24,
  low: 72,
};
