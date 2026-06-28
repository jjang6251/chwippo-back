import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W1 — applications.is_sample 컬럼 + 빠른 sample 조회 인덱스.
 *
 * 가상 회사 카드 vs 사용자가 직접 추가한 진짜 카드 구분.
 * Board UI = sample 분리 정렬 (진짜 위·sample 아래) + "📌 샘플" 배지.
 * dismiss endpoint = WHERE is_sample = true 만 soft delete.
 *
 * 인덱스 (user_id, is_sample, deleted_at) 부분 인덱스로 살아있는 sample 빠른 조회.
 */
export class AddApplicationsIsSample1780550000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE applications ADD COLUMN is_sample BOOLEAN NOT NULL DEFAULT FALSE`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_applications_user_sample
         ON applications (user_id, is_sample)
         WHERE deleted_at IS NULL AND is_sample = TRUE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_applications_user_sample`,
    );
    await queryRunner.query(
      `ALTER TABLE applications DROP COLUMN IF EXISTS is_sample`,
    );
  }
}
