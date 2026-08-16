import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  JoinColumn,
} from 'typeorm';
import { Application } from './application.entity';

@Entity('application_steps')
export class ApplicationStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'application_id', type: 'uuid' })
  applicationId: string;

  @ManyToOne(() => Application, (app) => app.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id' })
  application: Application;

  @Column({ name: 'order_index' })
  orderIndex: number;

  @Column()
  name: string;

  @Column({ name: 'scheduled_date', type: 'timestamptz', nullable: true })
  scheduledDate: Date | null;

  @Column({ nullable: true, type: 'varchar' })
  location: string | null;

  @Column({ nullable: true, type: 'text' })
  notes: string | null;

  @Column({ name: 'pinned_content', nullable: true, type: 'text' })
  pinnedContent: string | null;

  /**
   * 면접 유도 모달을 이 스텝에서 띄운 시각 — **스텝당 1회** 소진.
   *
   * 🔴 카드(application) 가 아니라 **스텝** 단위인 이유: 1차 면접에서 닫았어도
   * 2차 면접 단계가 되면 다시 물어야 한다. 차수마다 준비가 새로 필요하기 때문이다.
   * 카드 단위였다면 2차·3차를 통째로 놓친다.
   *
   * 닫는 방법 4가지(X · 오버레이 탭 · ESC · CTA)는 **전부 여기에 기록**한다 — 동등하다.
   * 「다시 보지 않기」 체크는 별개로 `users.interview_nudge_dismissed_at` 에 간다.
   *
   * ⚠️ 스텝을 재정렬해도 이 값은 **행을 따라간다** (인덱스가 아니라 행에 붙어 있다).
   */
  @Column({
    name: 'interview_nudge_shown_at',
    type: 'timestamptz',
    nullable: true,
  })
  interviewNudgeShownAt: Date | null;
}
