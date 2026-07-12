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

/**
 * 공고 요건 파싱 결과 (jobposting-parse). `applications.job_posting` JSONB 에 박제.
 *
 * ⚠️ **원문(rawText) 저장 금지** — 파싱 입력으로만 쓰고 폐기. 이 구조화 결과만 저장.
 * 6 필드는 LLM 이 채우고 `parsedAt` 은 서버가 저장 시각(now)으로 세팅.
 *
 * - `responsibilities` — 담당업무 (없으면 null)
 * - `requirements` — 필수 자격요건 (경력 연차·학력 요건 포함)
 * - `preferred` — 우대사항 (변별력 핵심)
 * - `techStack` — 기술 스택·툴 (기술명·고유명사는 원어 유지)
 * - `qualifications` — 정량 스펙 (자격증·어학 점수 등)
 * - `keywords` — 핵심 키워드
 * - `parsedAt` — 서버 저장 시각 (ISO). 배너 "M/D 정리됨" 신선도 표시용
 */
export interface JobPosting {
  responsibilities: string | null;
  requirements: string[];
  preferred: string[];
  techStack: string[];
  qualifications: string[];
  keywords: string[];
  parsedAt: string;
}

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

  /**
   * jobposting-parse — 공고 요건 파싱 결과 (구조화 JSONB). NULL = 미입력.
   * 원문(rawText)은 절대 저장하지 않음 (금지선). 상세 응답에만 포함, 카드 목록엔 미노출.
   */
  @Column({ name: 'job_posting', type: 'jsonb', nullable: true })
  jobPosting: JobPosting | null;

  /**
   * jobposting-parse — 파싱 진행 lock. NULL = idle, 'parsing' 만 사용.
   * 새로고침 재진입 시 배너가 CTA 대신 "정리 중" 표시하는 근거.
   * atomic UPDATE (WHERE status IS NULL OR started_at < NOW()-2min) 로 중복 파싱 차단.
   * 파싱은 5~15초라 자소서(30분 cron)와 달리 별도 cron 없이 읽기 시점 stale(2분) 판정으로 회수.
   */
  @Column({
    name: 'job_posting_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  jobPostingStatus: 'parsing' | null;

  /** jobposting-parse — parsing 시작 시각. stale(2분 초과) 판정·atomic 회수 조건에 사용 */
  @Column({
    name: 'job_posting_started_at',
    type: 'timestamptz',
    nullable: true,
  })
  jobPostingStartedAt: Date | null;

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
