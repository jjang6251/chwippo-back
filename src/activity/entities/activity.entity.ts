import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';
import { ActivityLog } from './activity-log.entity';
import { ActivityReflection } from './activity-reflection.entity';

/**
 * 활동 type 12종 — mock (plans/activity-journal-mock.html) TYPE_KO 와 1:1.
 * DB 에는 enum 제약 없이 VARCHAR(30) 저장. 유효성은 DTO class-validator 가 보장.
 */
export type ActivityType =
  | 'intern'
  | 'club'
  | 'study'
  | 'project'
  | 'sideproject'
  | 'contest'
  | 'research'
  | 'parttime'
  | 'volunteer'
  | 'overseas'
  | 'bootcamp'
  | 'other';

@Entity('activities')
@Index('idx_activities_user_archived', ['userId', 'archivedAt', 'createdAt'])
export class Activity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ length: 120 })
  name: string;

  @Column({ nullable: true, type: 'varchar', length: 120 })
  org: string | null;

  @Column({ nullable: true, type: 'varchar', length: 30 })
  type: ActivityType | null;

  @Column({ nullable: true, type: 'varchar', length: 120 })
  role: string | null;

  @Column({ name: 'result_url', nullable: true, type: 'varchar', length: 500 })
  resultUrl: string | null;

  /** activity-redesign — 유저별 숨김 "기본함" (미분류 로그 컨테이너, 유저당 1개) */
  @Column({ name: 'is_inbox', default: false })
  isInbox: boolean;

  @Column({ nullable: true, type: 'varchar', length: 200 })
  outcome: string | null;

  @Column({ name: 'started_at', type: 'date', nullable: true })
  startedAt: string | null;

  @Column({ name: 'ended_at', type: 'date', nullable: true })
  endedAt: string | null;

  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @Column({ name: 'legacy_experience_id', type: 'uuid', nullable: true })
  legacyExperienceId: string | null;

  /**
   * 활동 총괄 회고 — 끝난 활동을 한꺼번에 wrap up 하는 큰 문단.
   * 베타 피드백 (2026-06-23). NULL = 미작성.
   * char 5000 cap (DTO 검증).
   */
  @Column({ name: 'summary_reflection', type: 'text', nullable: true })
  summaryReflection: string | null;

  @OneToMany(() => ActivityLog, (log) => log.activity)
  logs: ActivityLog[];

  @OneToMany(() => ActivityReflection, (refl) => refl.activity)
  reflections: ActivityReflection[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
