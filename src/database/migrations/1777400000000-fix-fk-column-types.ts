import { MigrationInterface, QueryRunner } from 'typeorm';

// 초기 마이그레이션에서 FK 컬럼들이 varchar로 생성됨.
// users.id가 uuid 타입이므로 모든 user_id, application_id FK를 uuid로 변환.
export class FixFkColumnTypes1777400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "application_steps" ALTER COLUMN "application_id" TYPE uuid USING "application_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "todos" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_profiles" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_language_certs" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_certs" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_awards" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_experiences" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_coverletter" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_coverletter_custom" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "inquiries" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "application_steps" ALTER COLUMN "application_id" TYPE character varying USING "application_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "todos" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_profiles" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_language_certs" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_certs" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_awards" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_experiences" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_coverletter" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_coverletter_custom" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "inquiries" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
  }
}
