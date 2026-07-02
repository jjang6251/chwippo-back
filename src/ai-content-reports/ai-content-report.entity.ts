import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AiContentType =
  | 'coverletter'
  | 'interview_answer'
  | 'note_summary'
  | 'company_research'
  | 'other';

export type AiReportReason =
  | 'hate_speech'
  | 'misinformation'
  | 'privacy_violation'
  | 'harmful_content'
  | 'copyright'
  | 'other';

export type AiReportStatus = 'pending' | 'reviewed' | 'resolved' | 'dismissed';

@Entity('ai_content_reports')
@Index(['status', 'createdAt'])
export class AiContentReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'reporter_user_id', type: 'uuid', nullable: true })
  reporterUserId!: string | null;

  @Column({ name: 'content_type', type: 'varchar', length: 20 })
  contentType!: AiContentType;

  @Column({ name: 'content_id', type: 'uuid', nullable: true })
  contentId!: string | null;

  @Column({ type: 'varchar', length: 30 })
  reason!: AiReportReason;

  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: AiReportStatus;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
