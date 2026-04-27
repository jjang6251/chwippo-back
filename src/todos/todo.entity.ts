import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('todos')
export class Todo {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  user_id: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'date' })
  date: string;

  @Column({ default: false })
  is_done: boolean;

  @CreateDateColumn()
  created_at: Date;
}
