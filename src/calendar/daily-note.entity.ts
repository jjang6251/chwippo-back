import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('daily_notes')
export class DailyNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'date' })
  date: string;

  // 0 = 06:00, 1 = 06:30, ..., 35 = 23:30
  @Column({ name: 'hour_slot' })
  hourSlot: number;

  @Column({ type: 'varchar', length: 200 })
  content: string;

  @Column({ name: 'is_done', default: false })
  isDone: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
