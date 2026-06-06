import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { LlmFeature } from './llm-call-log.entity';

/**
 * PR_B1 — feature 별 코인 차감 정책 + 평균 cost.
 *
 * **컬럼 의미**:
 * - `chargesCoins` — true=차감, false=우리 부담 (회사조사·노트요약)
 * - `avgCoinCost` — 호출 시작 추정 buffer (평균 × 1.2 잔여 ≥ 진행)
 * - `description` — 운영 메모
 *
 * **초기 데이터** (마이그레이션):
 * | feature                | charges | avgCoinCost |
 * | coverletter_draft_v2   | true    | 12 |
 * | coverletter_chat       | true    | 3 |
 * | coverletter_recommend  | true    | 5 |
 * | interview_prep_session | true    | 10 |
 * | interview_prep_followup| true    | 6 |
 * | company_research       | false   | 0 (우리 부담) |
 * | note_summary           | false   | 0 (우리 부담) |
 */
@Entity('feature_coin_meta')
export class FeatureCoinMeta {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  feature: LlmFeature;

  @Column({ name: 'charges_coins', type: 'boolean' })
  chargesCoins: boolean;

  @Column({ name: 'avg_coin_cost', type: 'numeric', precision: 6, scale: 1 })
  avgCoinCost: string; // NUMERIC → string

  /**
   * PR_B1c — 고정 차감 코인 (token 환산 무시). NULL → token 환산 사용 (기존 동작).
   * 사용 예: company_research = 50 (cache hit/miss 무관 50 코인). user 가 50 코인 차감 인지.
   */
  @Column({
    name: 'fixed_coin_cost',
    type: 'int',
    nullable: true,
  })
  fixedCoinCost: number | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
