import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 회사 조사 pre-seed (2026-07-09, CEO 결정) — seed 로 적재된 row 마킹.
 * - seed_version: pre-seed 파일 버전 (예: '2026-07'). NULL = 유저 조사로 생성된 row.
 * - 부팅 자동 seed 가 upsert 판단에 사용: 유저 row(NULL)·opt_out row 는 덮어쓰지 않음.
 */
export class AddResearchSeedVersion1780700000000 implements MigrationInterface {
  name = 'AddResearchSeedVersion1780700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "company_research_cache" ADD "seed_version" character varying(20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "company_research_cache" DROP COLUMN "seed_version"`,
    );
  }
}
