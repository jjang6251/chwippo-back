import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ExamType = 'language' | 'cert';

@Entity('myinfo_exam_schedules')
export class ExamSchedule {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column() user_id: string;

  @Column({ name: 'exam_type', type: 'varchar' }) exam_type: ExamType;

  @Column({ name: 'cert_type', type: 'varchar', nullable: true }) cert_type:
    | string
    | null;

  @Column() name: string;

  @Column({ name: 'exam_date', type: 'timestamptz' }) exam_date: Date;

  @Column({ type: 'varchar', nullable: true }) location: string | null;

  @Column({ type: 'text', nullable: true }) memo: string | null;

  @CreateDateColumn({ name: 'created_at' }) created_at: Date;

  @UpdateDateColumn({ name: 'updated_at' }) updated_at: Date;
}
