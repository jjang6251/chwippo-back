import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';

export type LlmFeature =
  | 'note_summary'
  | 'coverletter'
  | 'interview'
  | 'interview_followup'
  | 'score'
  | 'analysis'
  | 'auto_tag';

export type LlmCallStatus =
  | 'ok'
  | 'error'
  | 'blocked_moderation'
  | 'blocked_quota';

@Entity('llm_call_logs')
@Index('idx_llm_call_logs_user_feature', ['userId', 'feature', 'createdAt'])
@Index('idx_llm_call_logs_created', ['createdAt'])
export class LlmCallLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 40 })
  feature: LlmFeature;

  @Column({ type: 'varchar', length: 40 })
  model: string;

  @Column({ name: 'prompt_tokens', type: 'int', default: 0 })
  promptTokens: number;

  @Column({ name: 'completion_tokens', type: 'int', default: 0 })
  completionTokens: number;

  @Column({
    name: 'cost_usd',
    type: 'numeric',
    precision: 10,
    scale: 6,
    default: 0,
  })
  costUsd: string;

  @Column({ name: 'latency_ms', type: 'int', default: 0 })
  latencyMs: number;

  @Column({ type: 'varchar', length: 20 })
  status: LlmCallStatus;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({
    name: 'resource_type',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  resourceType: string | null;

  @Column({ name: 'resource_id', type: 'uuid', nullable: true })
  resourceId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
