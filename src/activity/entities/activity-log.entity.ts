import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Activity } from './activity.entity';

/**
 * 행동 분류 12종 — mock CAT_KO 와 1:1.
 */
export type LogCategory =
  | 'develop'
  | 'meeting'
  | 'presentation'
  | 'collaboration'
  | 'conflict_resolution'
  | 'learning'
  | 'leadership'
  | 'volunteer'
  | 'customer'
  | 'analysis'
  | 'creative'
  | 'other';

/** 발휘 역량 10종 — mock COMP_KO */
export type LogComp =
  | 'technical'
  | 'leadership'
  | 'communication'
  | 'planning'
  | 'analytical'
  | 'problem_solving'
  | 'collaboration'
  | 'creativity'
  | 'responsibility'
  | 'adaptability';

/** 자소서 매핑 6종 — mock CL_KO */
export type CoverletterTag =
  | 'personality'
  | 'background'
  | 'job_competency'
  | 'own_strength'
  | 'collaboration'
  | 'challenge';

/** 감정 톤 4종 — mock MOOD_EM */
export type LogMood = 'proud' | 'learning' | 'frustrated' | 'neutral';

/** 정량 결과 — 3 패턴 (none = jsonb null) */
export type QuantValue =
  | { type: 'before-after'; before: string; after: string; unit?: string }
  | { type: 'count'; value: string; unit: string; metric?: string }
  | { type: 'raw'; raw: string };

@Entity('activity_logs')
@Index('idx_activity_logs_activity_occurred', ['activityId', 'occurredAt'])
@Index('idx_activity_logs_user', ['userId'])
@Index('idx_activity_logs_archived', ['activityId', 'archivedAt'])
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'activity_id', type: 'uuid' })
  activityId: string;

  @ManyToOne(() => Activity, (activity) => activity.logs, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ length: 200 })
  content: string;

  @Column({ name: 'occurred_at', type: 'date' })
  occurredAt: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  cat: LogCategory | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  comps: LogComp[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  cl: CoverletterTag[];

  @Column({ type: 'jsonb', nullable: true })
  quant: QuantValue | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  mood: LogMood | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  keywords: string[];

  @Column({ type: 'jsonb', nullable: true })
  note: Record<string, unknown> | null;

  @Column({ name: 'note_summary', type: 'text', nullable: true })
  noteSummary: string | null;

  @Column({
    name: 'note_summary_hash',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  noteSummaryHash: string | null;

  @Column({ name: 'note_summary_at', type: 'timestamptz', nullable: true })
  noteSummaryAt: Date | null;

  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
