import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 공고 요건 파싱 (jobposting-parse).
 *
 * 1. `applications.job_posting` JSONB NULL — 구조화 파싱 결과 (원문 rawText 는 미저장).
 * 2. `feature_quota_configs` 에 `jobposting_parse` (free) 행 — 쿨다운 0 · 일 5 · 월 무제한
 *    (month_limit 10000 = 기존 "사실상 무제한" 컨벤션. day 5 <= month 10000 invariant 충족).
 *    admin 이 동적 조절 (시즌 상향 대비).
 *
 * ⚠️ migration:generate 결과에서 dev DB drift 노이즈를 제거하고 이 기능 항목만 남김.
 * down() 은 CI 왕복 검증용 reversible — config 행 DELETE + 컬럼 DROP.
 */
export class AddJobPosting1783819045978 implements MigrationInterface {
  name = 'AddJobPosting1783819045978';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "job_posting" jsonb`,
    );
    await queryRunner.query(`
      INSERT INTO feature_quota_configs
        (feature, tier, day_limit, month_limit, cooldown_seconds, enabled)
      VALUES ('jobposting_parse', 'free', 5, 10000, 0, TRUE)
      ON CONFLICT (feature, tier) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM feature_quota_configs
      WHERE feature = 'jobposting_parse' AND tier = 'free'
    `);
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN "job_posting"`,
    );
  }
}
