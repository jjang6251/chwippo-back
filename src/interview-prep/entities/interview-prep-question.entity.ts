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

  /**
   * AI 답변의 **자료 부족 사유**. NULL = 자료 충분.
   *
   * 🔴 이 값이 답변 본문에 섞이면 안 된다 — `suggested_answer` 는 면접장에서 그대로 말할
   * 1인칭 발화라, "자료가 없어서" 같은 말이 들어가면 사용자가 그것까지 외운다.
   * 화면은 이걸 **배지로 따로** 그린다.
   */
  @Column({ name: 'material_gap', type: 'text', nullable: true })
  materialGap: string | null;

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

  /**
   * 질문 출처 — `'ai'` | `'user'` (질문 은행 D1, 2026-08-11).
   *
   * 🔴 **`NOT NULL DEFAULT 'ai'` 인 이유** — 이미 저장된 질문은 전부 AI 가 만든 것이라
   * 기본값이 곧 정확한 백필이다. 별도 UPDATE 없이 마이그레이션 한 줄로 끝난다.
   *
   * 이 값이 갈라놓는 것: 「내 질문」 배지 · 텍스트/카테고리 수정권(user 만) ·
   * 직접 꼬리를 달 수 있는 트리(루트가 user) · 면접 보기의 출처 필터.
   *
   * varchar 로 두고 CHECK 를 안 건 이유는 `interview_type`·`category` 와 같다 —
   * 값 추가가 마이그레이션을 부르지 않게 한다. 실제 강제는 DTO 화이트리스트가 한다.
   */
  @Column({ name: 'source', type: 'varchar', length: 10, default: 'ai' })
  source: string;

  /**
   * 마지막으로 **면접 보기(연습)** 에서 이 질문을 평가한 시각.
   *
   * 🔴 **서버 `now()` 만 쓴다.** 클라이언트 시각은 기기 설정으로 조작되고, 이 값이
   * "최근에 안 본 것부터" 정렬의 근거가 되면 조작이 곧 순서 조작이 된다.
   */
  @Column({ name: 'last_practiced_at', type: 'timestamptz', nullable: true })
  lastPracticedAt: Date | null;

  /**
   * 마지막 연습 결과 — `'good'` | `'soso'` | `'again'`. NULL = 아직 연습 안 함.
   *
   * 시험 설정의 「다시 볼 것만」 범위가 `'again'` 을 고른다. 이력이 아니라 **최신 1건만**
   * 남기는 이유는, 사용자가 묻는 게 "지금 약한 게 뭐냐" 하나라서다 (이력 테이블은 Out of Scope).
   */
  @Column({
    name: 'last_practice_result',
    type: 'varchar',
    length: 10,
    nullable: true,
  })
  lastPracticeResult: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => InterviewPrepQuestion, (q) => q.parent)
  children: InterviewPrepQuestion[];
}
