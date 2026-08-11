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
import { ApplicationStep } from './application-step.entity';

/**
 * 준비 노트의 **시트** — 엑셀 탭처럼 스텝 하나에 노트를 여러 장 둔다.
 *
 * 🔴 **`application_steps.notes` 는 건드리지 않는다.** 기존 노트는 읽기 전용 유산이고,
 * 첫 시트로 "승격"할 때도 원본은 그대로 남긴다 (복구 경로를 지우지 않는다).
 * 승격은 프론트가 기존 notes 를 읽어 `POST ... { ifEmpty: true }` 로 보내는 흐름이며,
 * 이 테이블은 그 결과만 받는다.
 */
@Entity('step_note_sheets')
@Index('idx_sns_step_order', ['stepId', 'orderIndex'])
export class StepNoteSheet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'step_id', type: 'uuid' })
  stepId: string;

  @ManyToOne(() => ApplicationStep, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'step_id' })
  step: ApplicationStep;

  /** 탭에 보이는 이름. trim 후 1~50자 (판정은 서비스가 단일 지점에서) */
  @Column({ type: 'varchar', length: 50 })
  name: string;

  /** tiptap doc JSON 문자열. 빈 시트는 null */
  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ name: 'order_index', type: 'int', default: 0 })
  orderIndex: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
