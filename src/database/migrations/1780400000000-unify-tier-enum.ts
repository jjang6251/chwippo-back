import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B2 Phase 0 — Tier enum 통일 (CRITICAL 차단 해소).
 *
 * **문제**:
 * - `users.tier` = 'free' | 'pro' | 'enterprise' (legacy F7 결제 인프라 가정)
 * - `tier_configs.tier` (PR_B1) = 'free' | 'lite' | 'standard' (PK)
 * - `user_coin_balances.tier` (PR_B1) = 'free' | 'lite' | 'standard'
 * - QuotaCheckService 가 `user.tier` 를 그대로 사용 → feature_quota_configs WHERE tier='pro'
 *   row 없으므로 silent fallback default. UserCoinService.canCharge 의 tier_configs lookup 도 mismatch
 *
 * **해소**:
 * - `users.tier` 의 값을 'lite'/'standard' 로 정규화
 * - `feature_quota_configs.tier` CHECK constraint 도 같이 변경
 * - `user_coin_balances.tier` 는 이미 새 system 으로 정합 (PR_B1) — 단 user.tier 와 동기화 검증
 * - down() 은 역치환 (CI 가역성 — memory `feedback_migration_down_reversible_for_ci`)
 */
export class UnifyTierEnum1780400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. users.tier 정규화 — 'pro' → 'lite', 'enterprise' → 'standard'
    await queryRunner.query(
      `UPDATE users SET tier = 'lite' WHERE tier = 'pro'`,
    );
    await queryRunner.query(
      `UPDATE users SET tier = 'standard' WHERE tier = 'enterprise'`,
    );

    // 2. user_coin_balances.tier 동기화 (users 와 mismatch row 가 있을 때)
    await queryRunner.query(
      `UPDATE user_coin_balances ucb
       SET tier = u.tier
       FROM users u
       WHERE ucb.user_id = u.id AND ucb.tier <> u.tier`,
    );

    // 3. feature_quota_configs.tier CHECK constraint — 새 enum 으로 교체
    await queryRunner.query(
      `ALTER TABLE feature_quota_configs DROP CONSTRAINT IF EXISTS feature_quota_configs_tier_check`,
    );
    await queryRunner.query(
      `ALTER TABLE feature_quota_configs ADD CONSTRAINT feature_quota_configs_tier_check
       CHECK (tier IN ('free', 'lite', 'standard'))`,
    );

    // 4. 기존 feature_quota_configs 의 'pro'/'enterprise' row (있을 시) 도 정규화
    await queryRunner.query(
      `UPDATE feature_quota_configs SET tier = 'lite' WHERE tier = 'pro'`,
    );
    await queryRunner.query(
      `UPDATE feature_quota_configs SET tier = 'standard' WHERE tier = 'enterprise'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 역치환 — 운영 rollback 시 이전 enum 호환 보장
    await queryRunner.query(
      `UPDATE feature_quota_configs SET tier = 'enterprise' WHERE tier = 'standard'`,
    );
    await queryRunner.query(
      `UPDATE feature_quota_configs SET tier = 'pro' WHERE tier = 'lite'`,
    );
    await queryRunner.query(
      `ALTER TABLE feature_quota_configs DROP CONSTRAINT IF EXISTS feature_quota_configs_tier_check`,
    );
    await queryRunner.query(
      `ALTER TABLE feature_quota_configs ADD CONSTRAINT feature_quota_configs_tier_check
       CHECK (tier IN ('free', 'pro', 'enterprise'))`,
    );

    await queryRunner.query(
      `UPDATE user_coin_balances ucb
       SET tier = u.tier
       FROM users u
       WHERE ucb.user_id = u.id AND ucb.tier <> u.tier`,
    );

    await queryRunner.query(
      `UPDATE users SET tier = 'enterprise' WHERE tier = 'standard'`,
    );
    await queryRunner.query(
      `UPDATE users SET tier = 'pro' WHERE tier = 'lite'`,
    );
  }
}
