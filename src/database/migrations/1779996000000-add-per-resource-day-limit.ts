import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F6 PR 2 Phase 5.6.8 — feature_quota_configs 에 per_resource_day_limit 컬럼 추가.
 *
 * 노트별·자소서별 등 "같은 리소스 N회/24h" 한도. 현재는 NoteSummaryService 만 사용
 * (hardcoded 5 → admin 통제). 다른 feature 는 NULL (활용 안 함, but 필요 시 활용 가능).
 *
 * memory `feedback_admin_quota_control` — 모든 한도가 admin UI 에서 동적 조절.
 */
export class AddPerResourceDayLimit1779996000000 implements MigrationInterface {
  name = 'AddPerResourceDayLimit1779996000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE feature_quota_configs
        ADD COLUMN per_resource_day_limit INT NULL
    `);
    // note_summary 의 기존 hardcoded 한도 5 를 seed (NoteSummaryService 기존 행동 유지)
    await queryRunner.query(`
      UPDATE feature_quota_configs
         SET per_resource_day_limit = 5
       WHERE feature = 'note_summary'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE feature_quota_configs
        DROP COLUMN IF EXISTS per_resource_day_limit
    `);
  }
}
