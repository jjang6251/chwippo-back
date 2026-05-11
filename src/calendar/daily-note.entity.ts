import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('daily_notes')
export class DailyNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'date' })
  date: string;

  // null = 시간 없는 할 일 (대시보드 오늘 할 일)
  // -12 = 00:00, 0 = 06:00, ..., 35 = 23:30
  @Column({ name: 'hour_slot', nullable: true, type: 'int' })
  hourSlot: number | null;

  @Column({ type: 'varchar', length: 200 })
  content: string;

  @Column({ name: 'is_done', default: false })
  isDone: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
