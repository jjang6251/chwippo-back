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
 * 카드가 **어느 화면에서** 만들어졌는가. 관측 전용이며 동작에 쓰지 않는다.
 *
 * 🔴 **소급이 불가능해서 미리 심는 값이다.** 치뽀엔 사용자 행동 이벤트 테이블이 없어
 * (`admin_audit_log` 는 운영자 액션 전용) 도메인 테이블의 최종 상태만 남는다. 지금 기록을
 * 시작하지 않으면 카드 추가 UX 를 바꾼 뒤 **신·구 경로를 나눠 볼 방법이 영영 없다.**
 *
 * 날짜로 가르면 되지 않느냐 — 개편 시점 전후로 자르는 것은 「개편 효과」와 「그 사이 유입된
 * 사용자층 변화」를 **구분하지 못한다.** 두 경로가 동시에 존재할 때만 진짜 비교가 된다.
 *
 * 도입 시점(2026-08-25) 기준 실제 생성 경로는 **두 개뿐**이다. 값이 늘어나는 것은
 * 카드 추가 재설계가 진입점을 나눌 때이고, 그때 이 유니온에 추가한다.
 * 기존 카드는 `null`(=미기록)로 남는다 — 백필하지 않는다. 추측한 값은 관측을 오염시킨다.
 */
export type ApplicationCreatedVia =
  /** 보드의 「카드 추가」 모달 (`AddCardModal`) — 현재 유일한 사용자 생성 경로 */
  | 'add_modal'
  /** 가입 온보딩이 직군 답변으로 자동 생성한 샘플 카드 (`is_sample = true`) */
  | 'onboarding_sample'
  /**
   * 가입 온보딩 2단 보상에서 **사용자가 직접 고른 회사** → 지원 예정 카드.
   *
   * 🔴 `onboarding_sample` 과 반드시 갈라 센다. 저쪽은 서버가 만들어 준 **가상 회사**라
   * `is_sample = true` 로 집계에서 통째로 빠지지만, 이건 사람이 고른 **진짜 회사**의
   * 진짜 카드다(`is_sample = false`). 한 값으로 뭉치면 「온보딩이 첫 카드를 만들어 줬나」와
   * 「샘플이 몇 장 깔렸나」가 같은 숫자가 되어 A안의 효과를 영영 못 잰다.
   */
  | 'onboarding_pick';

export const APPLICATION_CREATED_VIA: ApplicationCreatedVia[] = [
  'add_modal',
  'onboarding_sample',
  'onboarding_pick',
];

/**
 * 직무(`job_title`)가 **어떻게 입력됐는가**. 관측 전용이며 동작에 쓰지 않는다.
 *
 * 🔴 **저장된 결과만 보면 셋이 구분되지 않는다.** 타이핑·추천 탭·프리필 수용 모두
 * `job_title = '간호사'` 한 줄로 같아서, 이 값이 없으면 「사용자가 확정한 직무」와
 * 「미리 채워진 걸 그냥 통과시킨 직무」를 통계에서 영영 가를 수 없다.
 *
 * **「사람 말만 볼펜」 저장 정책** — 여기 남는 값은 전부 *사용자 본인이 낸 말*이다.
 * 시스템이 추측한 값(직무가 비었을 때 직군 라벨을 대신 보여주는 표시 계층 fallback 등)은
 * 아예 저장하지 않으므로 이 컬럼에도 나타나지 않는다. 모르는 답을 볼펜으로 적지 않는다.
 *
 * 기존 카드는 `null`(=미기록)로 남는다 — 백필하지 않는다. 추측한 값은 관측을 오염시킨다.
 */
export type JobTitleSource =
  /** 사용자가 직무 칸에 **직접 타이핑**해 확정 — 신뢰도 가장 높음 */
  | 'typed'
  /** 타이핑 중 뜬 **사전 추천 드롭다운을 탭** — 고르는 행위 자체가 확신의 근거 */
  | 'suggestion'
  /**
   * 온보딩에서 **사용자가 타이핑한** 직무가 미리 채워진 것을 **그대로 두고** 저장.
   * 출처는 사람 말이지만 「맞다고 확인」인지 「폼을 통과시킴」인지 알 수 없어 신뢰도가 낮다.
   * 계열 라벨만 고른 사용자는 프리필 자체가 없다 — 시스템 말은 직무로 승격하지 않는다.
   */
  | 'prefill'
  /**
   * 🔴 **F0(공고 붙여넣기) 예약값** — 도입 시점(2026-08-27) 기준 쓰는 코드가 없다.
   * 유니온에 미리 넣어두어 그 기능이 붙을 때 값 추가 없이 사용만으로 끝나게 한다.
   */
  | 'parsed';

export const JOB_TITLE_SOURCES: JobTitleSource[] = [
  'typed',
  'suggestion',
  'prefill',
  'parsed',
];

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
   * 카드를 만들 때 고른 전형 템플릿 id (`APPLICATION_TEMPLATES` 의 키).
   *
   * 🔴 **여태 버려지던 값이다.** `templateId` 는 `CreateApplicationDto` 로 이미 들어와서
   * 초기 스텝을 만드는 데만 쓰이고 저장되지 않았다. 그래서 「추천 템플릿을 그대로 썼나,
   * 고쳤나」를 **스텝 이름을 8종 템플릿과 문자열 비교**해서 추정할 수밖에 없었고,
   * 사용자가 스텝 이름을 한 글자만 고쳐도 그 추정이 무너진다.
   *
   * 이 값은 **시작 시점의 기록**이라 이후 스텝을 어떻게 편집해도 바뀌지 않는다.
   * 그래서 「무엇으로 시작해」 「무엇으로 끝났나」를 비로소 가를 수 있다.
   *
   * `null` = 컬럼 도입(2026-08-25) 이전 카드 · 또는 미지정. 백필하지 않는다.
   */
  @Column({ name: 'template_id', type: 'varchar', length: 32, nullable: true })
  templateId: string | null;

  /** 어느 화면에서 만들어졌나 — 관측 전용. 자세한 이유는 `ApplicationCreatedVia` 주석 */
  @Column({ name: 'created_via', type: 'varchar', length: 32, nullable: true })
  createdVia: ApplicationCreatedVia | null;

  /** 직무를 어떻게 입력했나 — 관측 전용. 자세한 이유는 `JobTitleSource` 주석 */
  @Column({
    name: 'job_title_source',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  jobTitleSource: JobTitleSource | null;

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
