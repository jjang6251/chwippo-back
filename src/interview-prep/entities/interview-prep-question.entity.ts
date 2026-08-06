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
import { InterviewPrepSession } from './interview-prep-session.entity';

/**
 * F6 PR 2 Phase 2 — 면접 준비 질문 (self-ref 트리, depth 0~2).
 *
 * **트리 구조**:
 * - `depth=0` (main): parent_question_id = null. session 의 메인 질문 (LLM 일괄 5~8개 생성)
 * - `depth=1` (follow-up): parent = depth 0. LLM 일괄 생성 시 main 마다 1~2개
 * - `depth=2` (follow-up of follow-up): parent = depth 1. on-demand `interview_prep_followup` LLM 호출
 * - 3+ 차단 (DB CHECK)
 *
 * **JSONB `source_log_ids`**: AI 가 답변(`suggested_answer`) 작성에 참조한 activity_log id 배열.
 * F5 hard delete 가드의 JSONB `@>` 검색 대상. hallucination 방어 — AI 응답에서 candidate 풀 안 id 만 filter.
 *
 * **`suggested_answer` vs `my_memo`**:
 * - `suggestedAnswer` — AI 생성 모범 답안 (변경 후엔 force=true 로 재생성)
 * - `myMemo` — 사용자가 직접 작성한 내 답변 (autosave 대상)
 */
@Entity('interview_prep_questions')
@Index('idx_ipq_session', ['sessionId', 'orderIndex'])
@Index('idx_ipq_parent', ['parentQuestionId'])
export class InterviewPrepQuestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId: string;

  @ManyToOne(() => InterviewPrepSession, (s) => s.questions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'session_id' })
  session: InterviewPrepSession;

  /** 부모 질문 id (depth=0 면 null, depth=1/2 면 부모 question id) */
  @Column({ name: 'parent_question_id', type: 'uuid', nullable: true })
  parentQuestionId: string | null;

  @ManyToOne(() => InterviewPrepQuestion, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'parent_question_id' })
  parent: InterviewPrepQuestion | null;

  /** 0=main, 1=follow-up, 2=follow-up-of-follow-up. DB CHECK 0-2 */
  @Column({ type: 'smallint', default: 0 })
  depth: number;

  /** 같은 depth + 같은 parent 내 표시 순서 */
  @Column({ name: 'order_index', type: 'int', default: 0 })
  orderIndex: number;

  @Column({ name: 'question_text', type: 'text' })
  questionText: string;

  /**
   * F1 v2 — 질문 카테고리 (INTERVIEW_CATEGORIES 18종 중 1). 옛 세션은 NULL.
   * 마이그레이션 1780000000000-add-category-to-interview-prep-questions
   */
  @Column({ name: 'category', type: 'varchar', length: 40, nullable: true })
  category: string | null;

  /** AI 가 생성한 모범 답안 (사용자 my_memo 와 분리) */
  /**
   * v2.1 (2026-08-07) — **우선 준비 대상.**
   *
   * 실제 신입 면접은 1인 26분 · 실질 문답 4분 남짓이라 **받는 질문이 5개 안팎**이다.
   * 20문항을 다 준비하는 건 현실적이지 않아, 모델이 "먼저 할 것" 5~7개를 골라 준다.
   *
   * `NOT NULL DEFAULT false` — 옛 질문은 전부 false 로 남는다 (표시가 없을 뿐 안 깨진다).
   */
  @Column({ name: 'must_prepare', type: 'boolean', default: false })
  mustPrepare: boolean;

  /**
   * 꼬리질문이 **무엇을 파고들었는지** (v2.1, 2026-08-07) — `my_memo` | `ai_answer` | `question`.
   *
   * 메인 질문(depth 0)은 항상 null 이다. 생성 시점의 판단을 박제하는 이유는,
   * 부모의 메모가 나중에 바뀌어도 **그때 무엇을 보고 만들었는지**는 변하지 않아서다.
   */
  @Column({
    name: 'followup_basis',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  followupBasis: string | null;

  @Column({ name: 'suggested_answer', type: 'text', nullable: true })
  suggestedAnswer: string | null;

  /** AI 가 답변 작성 시 참조한 activity_log id 배열. F5 가드 대상 */
  @Column({
    name: 'source_log_ids',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  sourceLogIds: string[];

  /** 사용자가 직접 작성한 내 답변 메모 (autosave 대상) */
  @Column({ name: 'my_memo', type: 'text', nullable: true })
  myMemo: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => InterviewPrepQuestion, (q) => q.parent)
  children: InterviewPrepQuestion[];
}
