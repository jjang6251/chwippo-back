import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W2 RN 하이브리드 · Sign in with Apple (Apple App Store Guideline 4.8) 대응.
 *
 * 컬럼:
 *   - apple_sub : Apple identity token 의 `sub` claim (사용자 고유 · 앱마다 다름 · 영구 불변)
 *   - apple_email : Apple 이 이메일 relay 사용 시 (@privaterelay.appleid.com). 실 이메일 없이 SIWA 로 가입 가능.
 *
 * Kakao 사용자는 apple_sub NULL 유지. 향후 계정 병합 시나리오 별도 고려.
 * kakao_id 는 이미 unique · apple_sub 도 unique · 두 컬럼 중 하나만 값 있음 (or 병합 시 둘 다).
 */
export class AddAppleSub1780580000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // kakao_id 를 nullable 로 완화 (SIWA 로 first-sign-up 시 kakao_id 없이 가입 가능)
    await queryRunner.query(
      `ALTER TABLE users ALTER COLUMN kakao_id DROP NOT NULL`,
    );

    // Apple SIWA 컬럼 추가
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN apple_sub VARCHAR(255) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN apple_email VARCHAR(255) NULL`,
    );

    // unique 제약 (NULL 은 unique 검사 예외 · Postgres 기본 동작)
    await queryRunner.query(
      `ALTER TABLE users ADD CONSTRAINT UQ_users_apple_sub UNIQUE (apple_sub)`,
    );

    // 최소 하나의 identity provider 필수 (kakao_id 또는 apple_sub 중 하나 이상)
    await queryRunner.query(
      `ALTER TABLE users ADD CONSTRAINT CK_users_identity_provider
       CHECK (kakao_id IS NOT NULL OR apple_sub IS NOT NULL)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP CONSTRAINT CK_users_identity_provider`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP CONSTRAINT UQ_users_apple_sub`,
    );
    await queryRunner.query(`ALTER TABLE users DROP COLUMN apple_email`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN apple_sub`);

    // kakao_id NOT NULL 복원 (revert 전에 apple-only 사용자 없다는 가정)
    await queryRunner.query(
      `ALTER TABLE users ALTER COLUMN kakao_id SET NOT NULL`,
    );
  }
}
