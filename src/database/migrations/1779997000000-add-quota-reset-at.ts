import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F6 PR 2 Phase 5.6.9 — user_ai_quotas 에 quota_reset_at JSONB 컬럼 추가.
 *
 * **shape**: `{"*": "2026-05-29T03:00:00Z"}` — wildcard 키. 이 시각 이후의 호출만 quota 카운트.
 * **scope**: 전체 사용자 reset (모든 row UPDATE) 또는 1명 reset (그 user 만 UPDATE/INSERT).
 *
 * dayUsed 계산:
 *   GREATEST(now() - 24h, COALESCE((quota_reset_at->>'*')::timestamptz, '-infinity'))
 *
 * memory `feedback_admin_quota_control` — admin 가 사용량 reset 도 통제.
 */
export class AddQuotaResetAt1779997000000 implements MigrationInterface {
  name = 'AddQuotaResetAt1779997000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE user_ai_quotas
        ADD COLUMN quota_reset_at JSONB NOT NULL DEFAULT '{}'::jsonb
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE user_ai_quotas
        DROP COLUMN IF EXISTS quota_reset_at
    `);
  }
}
