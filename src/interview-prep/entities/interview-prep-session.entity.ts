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

  /** 면접 종류 — null 또는 enum 3종 (technical/personality/etc). PT·토론·코딩은 F-후속 별도 기능 */
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

  /**
   * Phase 4 추가 — 모집 요강 (사용자가 직접 붙여넣음). 회사·직무 + 자소서 외 회사 특화 키워드 source.
   * AI 가 요구역량·우대사항 기반 추궁 질문 생성에 사용.
   */
  @Column({ name: 'job_description', type: 'text', nullable: true })
  jobDescription: string | null;

  /**
   * Phase 4 추가 — 사용자가 면접관에게 꼭 어필하고 싶은 강점/경험.
   * AI 가 본인 의도 방향으로 질문 생성 (예: "갈등 해결 경험을 꼭 어필" → 그 방향 추궁).
   */
  @Column({ name: 'emphasis_points', type: 'text', nullable: true })
  emphasisPoints: string | null;

  /**
   * Phase 4 단계 B — 사용자가 회사 조사 결과 위에 추가로 적은 자유 메모.
   * AI 가 생성한 `company_research_cache.ai_research` 는 read-only.
   * 책임 분리: AI 정보 = 우리 책임 / 사용자 메모 = 사용자 책임.
   * 면접 질문 생성에도 활용 (사용자 메모 우선).
   */
  @Column({ name: 'user_research_notes', type: 'text', nullable: true })
  userResearchNotes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => InterviewPrepQuestion, (q) => q.session)
  questions: InterviewPrepQuestion[];
}
