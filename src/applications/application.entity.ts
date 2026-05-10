import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  JoinColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { ApplicationStep } from './application-step.entity';

export type ApplicationStatus = 'PLANNED' | 'IN_PROGRESS' | 'PASSED' | 'FAILED';

@Entity('applications')
export class Application {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @OneToMany(() => ApplicationStep, (step) => step.application, {
    cascade: true,
    eager: false,
  })
  steps: ApplicationStep[];

  @Column({ name: 'company_name' })
  companyName: string;

  @Column({ name: 'job_title', nullable: true, type: 'varchar' })
  jobTitle: string | null;

  @Column({ name: 'job_category', nullable: true, type: 'varchar' })
  jobCategory: string | null;

  @Column({ default: 'IN_PROGRESS' })
  status: ApplicationStatus;

  @Column({ type: 'date', nullable: true })
  deadline: string | null;

  @Column({ name: 'job_url', nullable: true, type: 'varchar' })
  jobUrl: string | null;

  @Column({ type: 'text', nullable: true })
  memo: string | null;

  @Column({ name: 'current_step_index', default: 0 })
  currentStepIndex: number;

  @Column({ name: 'needs_detail', default: false })
  needsDetail: boolean;

  @Column({ name: 'is_starred', default: false })
  isStarred: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deletedAt: Date | null;
}
