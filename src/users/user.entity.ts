import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { CoinTier } from '../ai/entities/tier-config.entity';
import type { AlarmConfig } from '../notifications/notification.types';

/** PR_B2 Phase 1 — Q24 사용자 통지. admin 액션 후 사용자 me 호출 시 1회 모달 표시 */
export interface PendingNotification {
  type:
    | 'coin_grant'
    | 'coin_revoke'
    | 'quota_override' // cost hardening ④ — AI 개별 한도 설정/해제/자동제재 모달
    | 'matrix_change'
    | 'tier_downgrade'
    | 'tier_upgrade';
  title: string;
  body: string;
  createdAt: string;
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'kakao_id', unique: true, nullable: true, type: 'varchar' })
  kakaoId: string | null;

  /**
   * W2 RN 하이브리드 · Sign in with Apple (Apple Guideline 4.8).
   * Apple identity token 의 `sub` claim. 사용자별 고유 · 앱별 다름 · 영구 불변.
   * NULL = SIWA 로 가입 안 한 사용자 (kakao 만 사용).
   */
  @Column({ name: 'apple_sub', unique: true, nullable: true, type: 'varchar' })
  appleSub: string | null;

  /**
   * Apple 이메일 relay 사용 시 (@privaterelay.appleid.com).
   * user 가 hide email 선택하면 여기 저장. `email` 은 표시용 실 이메일 or NULL.
   */
  @Column({ name: 'apple_email', nullable: true, type: 'varchar' })
  appleEmail: string | null;

  @Column()
  nickname: string;

  @Column({ nullable: true, type: 'varchar' })
  email: string | null;

  @Column({ name: 'refresh_token', nullable: true, type: 'varchar' })
  refreshToken: string | null;

  @Column({ default: 'user' })
  role: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'last_active_at', type: 'timestamptz', nullable: true })
  lastActiveAt: Date | null;

  @Column({ name: 'terms_agreed_at', type: 'timestamptz', nullable: true })
  termsAgreedAt: Date | null;

  @Column({ name: 'dashboard_config', type: 'jsonb', nullable: true })
  dashboardConfig: { sections: { id: string; visible: boolean }[] } | null;

  // 알림 시스템 — 알림 설정 (NULL = 기본값 merge · notification.types resolveAlarmConfig)
  @Column({ name: 'alarm_config', type: 'jsonb', nullable: true })
  alarmConfig: AlarmConfig | null;

  // 알림 시스템 — soft-ask 모달 표시 시각 (NULL = 미표시 → 로그인 후 모달)
  @Column({ name: 'alarm_prompted_at', type: 'timestamptz', nullable: true })
  alarmPromptedAt: Date | null;

  // 알림 시스템 — OS 푸시 권한 실제 허용 여부 (앱 시작 시 동기화)
  @Column({
    name: 'alarm_permission_granted',
    type: 'boolean',
    default: false,
  })
  alarmPermissionGranted: boolean;

  @Column({ name: 'onboarded_at', type: 'timestamptz', nullable: true })
  onboardedAt: Date | null;

  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  /**
   * PR 0 — AI 사용 별도 동의 시점 (개인정보보호법 26조 — OpenAI·Anthropic 미국 소재 처리위탁).
   * NULL → LlmService 진입점에서 `blocked_consent` 반환. 프론트가 모달 노출 후 동의.
   * **F5 NoteSummary 기존 사용자도 NULL → 재동의 트리거**.
   */
  @Column({ name: 'ai_consent_at', type: 'timestamptz', nullable: true })
  aiConsentAt: Date | null;

  /** PR 0 — 동의 버전 ('v1' 등). 약관 갱신 시 강제 재동의 (저장된 version 과 현재 version 비교) */
  @Column({
    name: 'ai_consent_version',
    type: 'varchar',
    length: 10,
    nullable: true,
  })
  aiConsentVersion: string | null;

  /** PR_B1 — 코인 시스템 onboarding modal 표시 여부. NULL → 첫 로그인 시 modal 노출 → 닫으면 NOW 저장 */
  @Column({
    name: 'onboarded_coin_at',
    type: 'timestamptz',
    nullable: true,
  })
  onboardedCoinAt: Date | null;

  /**
   * 사용자 결제 tier ('free'/'lite'/'standard').
   * PR_B2 Phase 0 — CoinTier 통일 ('pro'→'lite', 'enterprise'→'standard').
   * `tier_configs` (PR_B1 코인 system) + `feature_quota_configs` (legacy) 공용 tier.
   * admin Phase 3 의 ForcePlanChange 또는 결제 시스템이 UPDATE.
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: 'free',
  })
  tier: CoinTier;

  // PR_B2 Phase 1 — Q13 정지 모달의 사유 (admin 입력 1..500자)
  @Column({ name: 'suspend_reason', type: 'text', nullable: true })
  suspendReason: string | null;

  // PR_B2 Phase 1 — Q13 정지 모달의 예상 해제일 (NULL = 영구). 자동 해제 cron + lazy
  @Column({ name: 'suspend_expires_at', type: 'timestamptz', nullable: true })
  suspendExpiresAt: Date | null;

  // PR_B2 Phase 1 — Q24 사용자 통지 (admin 액션 후 me 호출 응답에 포함, dismiss 시 NULL)
  @Column({ name: 'pending_notification', type: 'jsonb', nullable: true })
  pendingNotification: PendingNotification | null;

  /**
   * W1 — signup 1 질문 (관심 직군) 답변. 다중 선택 (1~21개).
   * - NULL = 미답변 (LoginCallback 가 /signup/question redirect)
   * - [] 빈 array = "건너뛰기" (다시 안 묻음, 샘플도 X)
   * - ['백엔드 개발', '기타'] 등 = JOB_CATEGORIES 안의 값들
   */
  @Column({ name: 'signup_job_categories', type: 'jsonb', nullable: true })
  signupJobCategories: string[] | null;

  /**
   * W1 — "기타" 선택 시 자유 입력 직무명 (예: "게임 기획"). max 200자.
   * NULL = 미입력 또는 "기타" 미선택. service 가드: 기타 미선택 + otherText 있음 → 400.
   * 가상 샘플 카드 generate 시 "Sample Corp {otherText}" 형식으로 사용.
   */
  @Column({
    name: 'signup_other_text',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  signupOtherText: string | null;

  /**
   * W1 — 사용자가 "전체 숨기기" 누른 시각 (한 번 dismiss 시 영구).
   * NULL = 샘플 카드 살아있음 (보드 표시).
   * NOT NULL = 모든 is_sample 카드 soft delete + 다음 로그인에도 안 나타남.
   */
  @Column({
    name: 'sample_cards_dismissed_at',
    type: 'timestamptz',
    nullable: true,
  })
  sampleCardsDismissedAt: Date | null;

  /**
   * 캘린더 UX 재구성 — 홈 = /calendar redirect 전환.
   *
   * 첫 방문 시 캘린더 상단 "이제 캘린더가 홈이에요" 안내 배너 노출.
   * dismiss 하면 timestamp 저장 → 이후 재노출 X.
   */
  @Column({
    name: 'calendar_home_intro_dismissed_at',
    type: 'timestamptz',
    nullable: true,
  })
  calendarHomeIntroDismissedAt: Date | null;
}
