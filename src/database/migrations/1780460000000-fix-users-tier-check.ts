import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B2 Phase 3 — users.tier CHECK constraint 수정 (Phase 0 누락 fix).
 *
 * **문제**:
 * - Phase 0 마이그레이션 1780400 가 `UPDATE users SET tier='lite' WHERE tier='pro'` 만 함
 * - users 테이블의 `users_tier_check` CHECK constraint 는 옛 enum 그대로:
 *   `CHECK (tier IN ('free', 'pro', 'enterprise'))`
 * - 결과: forceChangeTier / 다른 곳에서 `tier='lite'` UPDATE 시 23514 위반 → 500
 *
 * **fix**: DROP + ADD CONSTRAINT with new enum.
 */
export class FixUsersTierCheck1780460000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD CONSTRAINT users_tier_check
       CHECK (tier IN ('free', 'lite', 'standard'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD CONSTRAINT users_tier_check
       CHECK (tier IN ('free', 'pro', 'enterprise'))`,
    );
  }
}
