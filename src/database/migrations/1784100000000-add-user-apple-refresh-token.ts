import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Apple revoke (Guideline 5.1.1(v)) 실구현 — `users.apple_refresh_token` 추가.
 *
 * authorizationCode 교환으로 얻은 refresh_token 을 평문 저장 (revoke 에 원문 필요).
 * nullable — 구버전 앱·교환 실패 시 NULL (revoke 스킵).
 *
 * down(): CI down→up 검증용 컬럼 drop (reversible).
 */
export class AddUserAppleRefreshToken1784100000000 implements MigrationInterface {
  name = 'AddUserAppleRefreshToken1784100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "apple_refresh_token" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "apple_refresh_token"`,
    );
  }
}
