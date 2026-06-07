import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { CoinTier } from '../ai/entities/tier-config.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'kakao_id', unique: true })
  kakaoId: string;

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
}
