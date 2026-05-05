import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ApplicationStep } from './application-step.entity';

@Entity('step_checklist_items')
export class StepChecklistItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'step_id', type: 'uuid' })
  stepId: string;

  @ManyToOne(() => ApplicationStep, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'step_id' })
  step: ApplicationStep;

  @Column({ type: 'varchar', length: 200 })
  content: string;

  @Column({ name: 'is_done', default: false })
  isDone: boolean;

  @Column({ name: 'order_index', default: 0 })
  orderIndex: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
