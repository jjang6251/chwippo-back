import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LRR Phase 3-D (PR CC) — 자주 쿼리되는 컬럼에 index 추가.
 *
 * Tier 2 v2에서 발견된 ENT-2 갭 해소. 출시 후 트래픽 증가 대비.
 *
 * 기준:
 * - findAll/find의 where 컬럼
 * - createQueryBuilder().where() 빈번 컬럼
 * - soft delete `deleted_at IS NULL` 자동 필터
 * - 정렬 자주 사용되는 컬럼
 *
 * PostgreSQL은 FK에 auto-index 안 만드므로 수동 추가 필요.
 * `IF NOT EXISTS`로 멱등 — 재실행·롤백 후 재실행 안전.
 */
export class AddPerfIndexes1779600000000 implements MigrationInterface {
  name = 'AddPerfIndexes1779600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // applications — 모든 카드 조회의 기본
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_applications_deleted_at ON applications(deleted_at)`,
    );

    // application_steps — relations/find with order
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_application_steps_app ON application_steps(application_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_application_steps_app_order ON application_steps(application_id, order_index)`,
    );

    // myinfo_* (user_id) — 5개 list 쿼리
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_myinfo_certs_user ON myinfo_certs(user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_myinfo_awards_user ON myinfo_awards(user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_myinfo_language_certs_user ON myinfo_language_certs(user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_myinfo_experiences_user ON myinfo_experiences(user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_myinfo_documents_user ON myinfo_documents(user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_myinfo_coverletter_custom_user ON myinfo_coverletter_custom(user_id)`,
    );
    // myinfo_coverletter·user_profiles는 user_id PK라 이미 unique index — skip
    // myinfo_educations·myinfo_exam_schedules는 기존 마이그레이션에서 추가됨 — skip

    // inquiries — findByUser
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_inquiries_user ON inquiries(user_id)`,
    );

    // announcements — getActive 조건 (active=true + 기간)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_announcements_active_ends ON announcements(active, ends_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // CI 회귀 검증을 위해 reversible (feedback_migration_down_reversible_for_ci)
    const indexes = [
      'idx_applications_user',
      'idx_applications_deleted_at',
      'idx_application_steps_app',
      'idx_application_steps_app_order',
      'idx_myinfo_certs_user',
      'idx_myinfo_awards_user',
      'idx_myinfo_language_certs_user',
      'idx_myinfo_experiences_user',
      'idx_myinfo_documents_user',
      'idx_myinfo_coverletter_custom_user',
      'idx_inquiries_user',
      'idx_announcements_active_ends',
    ];
    for (const idx of indexes) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${idx}"`);
    }
  }
}
