import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * PR_B1 — tier 별 코인 매트릭스 (Free / Lite / Standard).
 *
 * admin 페이지 (PR_B2) 에서 수정 가능. launch 후 사용량 보고 조정.
 *
 * **컬럼 의미**:
 * - `monthlyCoinLimit` — 매월 reset 시 부여 코인 (Free 100 / Lite 800 / Standard 1500)
 * - `inputTokenCapPerCall` — 한 호출당 input 토큰 cap (cost 동등화)
 * - `defaultCooldownSeconds` — 모든 호출 공통 cooldown (double-click 방어, 3초)
 * - `companyResearchDailyCap` — 사용자 당 cache miss 일 N회 (Free 2 / Lite 5 / Standard 10)
 * - `noteSummaryCooldownMinutes` — 노트별 cooldown (Free 60 / Lite 10 / Standard 1)
 * - `priceKrw` — 참고. 실제 결제는 별도 SKU
 * - `active` — kill switch. false 면 tier 강등 또는 새 결제 차단 (admin 운영)
 */
export type CoinTier = 'free' | 'lite' | 'standard';

@Entity('tier_configs')
export class TierConfig {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  tier: CoinTier;

  @Column({
    name: 'monthly_coin_limit',
    type: 'numeric',
    precision: 8,
    scale: 1,
  })
  monthlyCoinLimit: string; // NUMERIC → string (TypeORM 정밀도 보존)

  @Column({ name: 'input_token_cap_per_call', type: 'int' })
  inputTokenCapPerCall: number;

  @Column({ name: 'default_cooldown_seconds', type: 'int', default: 3 })
  defaultCooldownSeconds: number;

  @Column({ name: 'company_research_daily_cap', type: 'int' })
  companyResearchDailyCap: number;

  @Column({ name: 'note_summary_cooldown_minutes', type: 'int' })
  noteSummaryCooldownMinutes: number;

  @Column({ name: 'price_krw', type: 'int', nullable: true })
  priceKrw: number | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
