import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 회사 조사 캐시 별칭 행 표식 (feature-research-admin).
 * - is_alias: seed 의 aliases 로 만들어진 복제 행은 true, 본 행은 false.
 * - admin 커버리지 분자를 "회사 수"로 보정할 때 별칭 행을 제외하기 위한 플래그.
 */
export class AddResearchIsAlias1783815919472 implements MigrationInterface {
  name = 'AddResearchIsAlias1783815919472';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "company_research_cache" ADD "is_alias" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "company_research_cache" DROP COLUMN "is_alias"`,
    );
  }
}
