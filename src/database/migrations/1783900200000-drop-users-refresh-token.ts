import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 세션 지속성 웨이브 (2차) — 구 `users.refresh_token` 컬럼 drop.
 *
 * 1차에서 기기별 세션(`refresh_sessions`) + 토큰 패밀리(`refresh_tokens`)를 도입하고
 * 구 컬럼은 무중단 이전용 fallback 으로 남겼으나, 베타 전이라 무중단 이전이 불필요 →
 * CEO 결정으로 1차+2차를 통합 릴리즈. legacy fallback 코드와 함께 컬럼 제거.
 *
 * down(): CI down→up 검증용으로 컬럼 구조만 복원 (데이터는 복원 불가).
 * — [[migration-down-reversible-for-ci]]: 비가역 의도여도 throw 금지.
 */
export class DropUsersRefreshToken1783900200000 implements MigrationInterface {
  name = 'DropUsersRefreshToken1783900200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "refresh_token"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "refresh_token" character varying`,
    );
  }
}
