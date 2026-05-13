import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserOnboardedAt1779000000000 implements MigrationInterface {
  name = 'AddUserOnboardedAt1779000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "onboarded_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "onboarded_at"`,
    );
  }
}
