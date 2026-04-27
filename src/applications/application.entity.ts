import { Column, CreateDateColumn, DeleteDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('applications')
export class Application {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  user_id: string;

  @Column()
  company_name: string;

  @Column({ nullable: true })
  job_title: string;

  @Column({ nullable: true })
  job_category: string;

  @Column({ default: 'IN_PROGRESS' })
  status: string;

  @Column({ type: 'date', nullable: true })
  deadline: string;

  @Column({ nullable: true })
  job_url: string;

  @Column({ type: 'text', nullable: true })
  memo: string;

  @Column({ default: 0 })
  current_step_index: number;

  @Column({ default: false })
  needs_detail: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @DeleteDateColumn()
  deleted_at: Date;
}
