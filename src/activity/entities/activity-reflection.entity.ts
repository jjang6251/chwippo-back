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
 * 활동 회고 — mock 의 state.reflections 와 1:1.
 * weekStart 정책: 입력값 그대로 저장 (보정 안 함). 월요일 보장은 UI picker 책임.
 * 같은 (activity, weekStart) 에 여러 row 허용 — unique 제약 없음.
 */
@Entity('activity_reflections')
@Index('idx_activity_reflections_activity', ['activityId', 'createdAt'])
export class ActivityReflection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'activity_id', type: 'uuid' })
  activityId: string;

  @ManyToOne(() => Activity, (activity) => activity.reflections, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'week_start', type: 'date', nullable: true })
  weekStart: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  growth: string[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  challenges: string[];

  @Column({ name: 'next_actions', type: 'jsonb', default: () => "'[]'::jsonb" })
  nextActions: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
