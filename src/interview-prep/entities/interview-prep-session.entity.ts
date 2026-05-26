import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Application } from '../../applications/application.entity';
import { User } from '../../users/user.entity';
import { InterviewPrepQuestion } from './interview-prep-question.entity';

/**
 * F6 PR 2 Phase 2 — 면접 준비 세션.
 *
 * **scope**: 한 application 의 round/면접 종류 별 면접 준비. 사용자가 자소서 문항 + 추가 활동 로그 선택 →
 * AI 가 main 5~8 질문 + 각 main 의 꼬리 1~2개 일괄 생성 (`interview_prep_session` LLM feature, ADR-024 Hybrid).
 *
 * **JSONB 필드 (selected refs)**:
 * - `coverletterIds` — 사용자가 선택한 자소서 문항 id. IDOR batch 가드 후 저장 (생성 시점 snapshot)
 * - `extraLogIds` — 자소서 외 추가로 선택한 activity_log id. F5 hard delete 가드의 JSONB `@>` 검색 대상
 *
 * **응답 DTO user_id strip** (Q4 결정) — 응답 mapper 가 user_id 제거. F6.5 익명화 풀 준비.
 */
@Entity('interview_prep_sessions')
@Index('idx_ips_user', ['userId', 'createdAt'])
@Index('idx_ips_application', ['applicationId', 'createdAt'])
export class InterviewPrepSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'application_id', type: 'uuid' })
  applicationId: string;

  @ManyToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id' })
  application: Application;

  /** 차수/명칭 (예: '1차 실무면접', '임원면접', '코딩테스트 회고' 등 자유 입력 ≤40자) */
  @Column({ type: 'varchar', length: 40 })
  round: string;

  /** 면접 종류 — null 또는 enum 6종 (technical/behavioral/personality/case/codingtest/etc — UI 결정) */
  @Column({
    name: 'interview_type',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  interviewType: string | null;

  /** 사용자가 생성 시 체크한 자소서 문항 id 배열 — IDOR batch 후 저장 */
  @Column({
    name: 'coverletter_ids',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  coverletterIds: string[];

  /** 사용자가 생성 시 추가로 체크한 activity_log id 배열 — IDOR batch 후 저장. F5 가드 대상 */
  @Column({
    name: 'extra_log_ids',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  extraLogIds: string[];

  /** 세션 단위 사용자 메모 (autosave 대상, 질문별 my_memo 와 분리) */
  @Column({ name: 'my_memo', type: 'text', nullable: true })
  myMemo: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => InterviewPrepQuestion, (q) => q.session)
  questions: InterviewPrepQuestion[];
}
