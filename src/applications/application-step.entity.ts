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

  /**
   * 공고에 적혀 있었지만 **날짜로 확정할 수 없는 표현** — 「9월 초」·「추후 공지」·「10월 중순」.
   *
   * 🔴 **「확실한 날짜만 캘린더에, 애매한 건 글자로」**(결정 8). 「11월 중」을 11-01 로 바꾸면
   * ① 알림이 엉뚱한 날 가고 ② 그게 추측값이라는 걸 사용자가 알 방법이 없다. 원문 그대로
   * 짧게(≤40자) 남겨 두면 화면이 회색 캡션으로 보여 주고, 진짜 날짜가 나오면 사용자가 적는다.
   *
   * `scheduledDate` 가 세팅되면 **자동으로 NULL 이 된다** (`updateStep`) — 날짜와 힌트가
   * 나란히 남으면 어느 쪽이 진짜인지 화면이 답할 수 없다.
   *
   * NULL = 힌트 없음 (공고 경로가 아닌 스텝은 전부 NULL).
   */
  @Column({ name: 'date_hint', type: 'varchar', length: 40, nullable: true })
  dateHint: string | null;

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
