import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  JoinColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { ApplicationStep } from './application-step.entity';

export type ApplicationStatus = 'PLANNED' | 'IN_PROGRESS' | 'PASSED' | 'FAILED';

@Entity('applications')
export class Application {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @OneToMany(() => ApplicationStep, (step) => step.application, {
    cascade: true,
    eager: false,
  })
  steps: ApplicationStep[];

  @Column({ name: 'company_name' })
  companyName: string;

  @Column({ name: 'job_title', nullable: true, type: 'varchar' })
  jobTitle: string | null;

  @Column({ name: 'job_category', nullable: true, type: 'varchar' })
  jobCategory: string | null;

  @Column({ default: 'IN_PROGRESS' })
  status: ApplicationStatus;

  @Column({ name: 'job_url', nullable: true, type: 'varchar' })
  jobUrl: string | null;

  @Column({ type: 'text', nullable: true })
  memo: string | null;

  /** A9 — 탈락 회고 한 줄 ("이번 지원에서 얻은 것"). 선택 입력 · 수정 허용 */
  @Column({ name: 'failed_takeaway', type: 'text', nullable: true })
  failedTakeaway: string | null;

  /** A9 — 회고 입력·수정 시각 (성장 페이지 정렬 기준) */
  @Column({ name: 'failed_takeaway_at', type: 'timestamptz', nullable: true })
  failedTakeawayAt: Date | null;

  @Column({ name: 'current_step_index', default: 0 })
  currentStepIndex: number;

  @Column({ name: 'needs_detail', default: false })
  needsDetail: boolean;

  @Column({ name: 'is_starred', default: false })
  isStarred: boolean;

  /**
   * W1 — 가상 회사 샘플 카드 (signup 직군 답변 기반 자동 생성) 여부.
   * 진짜 카드 (사용자가 직접 추가) = false / 샘플 = true.
   * Board UI 가 분리 정렬 + "📌 샘플" 배지 + GuideOverlay 표시.
   * 부분 인덱스 (user_id, is_sample) WHERE deleted_at IS NULL AND is_sample = TRUE 로 빠른 조회.
   */
  @Column({ name: 'is_sample', default: false })
  isSample: boolean;

  /**
   * PR_B1c — 자소서 생성 (회사조사 trigger) 상태.
   * - 'idle': 미시작. "생성하기" 버튼 노출
   * - 'in_progress': 회사조사 진행 중. spinner 표시 + atomic UPDATE WHERE='idle' 로 race 차단
   * - 'completed': 회사조사 완료 + 50 코인 차감 + cache 저장. 자소서 작성 가능
   * - 'failed': LLM 실패. "다시 시도" 버튼 노출 (service 가 자동 'idle' reset 후 재진행)
   */
  @Column({
    name: 'coverletter_generation_status',
    type: 'varchar',
    length: 20,
    default: 'idle',
  })
  coverletterGenerationStatus: 'idle' | 'in_progress' | 'completed' | 'failed';

  /** PR_B1c — in_progress stuck timeout 감지용 (30분 초과 시 cron 으로 'failed' 처리) */
  @Column({
    name: 'coverletter_generation_started_at',
    type: 'timestamptz',
    nullable: true,
  })
  coverletterGenerationStartedAt: Date | null;

  /**
   * PR_B1c Phase A — 회사조사 outdated (회사명/직무 변경 감지).
   * status='completed' 인데 사용자가 companyName/jobTitle/jobCategory 수정하면 NOW() 저장.
   * UI 가 "회사 정보 수정됨" banner 표시 + 재조사 CTA.
   * generateCoverletter 가 outdated_at not null → atomic WHERE 통과 → 재조사 허용.
   * 재조사 완료 시 NULL reset.
   */
  @Column({
    name: 'coverletter_research_outdated_at',
    type: 'timestamptz',
    nullable: true,
  })
  coverletterResearchOutdatedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deletedAt: Date | null;

  /**
   * W2 — 회사 도메인 (favicon 로딩 용).
   * DB 컬럼 X — runtime virtual 필드. ApplicationsService 응답에서 CompaniesService lookup 후 inject.
   * frontend 가 Google s2 favicon URL 생성에 사용. 없으면 해시 아바타 fallback.
   */
  domain?: string;
}
