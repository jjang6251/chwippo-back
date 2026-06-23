import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI cost guard — alert_thresholds +2 컬럼.
 *
 * **목적** — 코인 차단 (tier 별 monthly_coin_limit) 외에 USD cost 직접 cap.
 * 모델 비용이 예상보다 비싸지면 (token 폭증·model 가격 변동) 코인은 적게 차감됐는데 운영 cost 큰 case 차단.
 *
 * - `per_user_daily_cost_usd` default 0.5 — 1 user/day 의 모든 feature 합산 cap
 * - `per_feature_daily_cost_usd` default 5.0 — 1 user/feature/day cap
 * - 두 cap 모두 USD numeric(8, 4)
 */
export class AddCostGuardThresholds1780480000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alert_thresholds
       ADD COLUMN per_user_daily_cost_usd NUMERIC(8, 4) NOT NULL DEFAULT 0.5,
       ADD COLUMN per_feature_daily_cost_usd NUMERIC(8, 4) NOT NULL DEFAULT 5.0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alert_thresholds
       DROP COLUMN IF EXISTS per_feature_daily_cost_usd,
       DROP COLUMN IF EXISTS per_user_daily_cost_usd`,
    );
  }
}
