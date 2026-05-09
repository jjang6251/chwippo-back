import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStepNotes1777900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "application_steps" ADD COLUMN "notes" TEXT`);
    await queryRunner.query(`ALTER TABLE "application_steps" ADD COLUMN "pinned_content" TEXT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "application_steps" DROP COLUMN IF EXISTS "pinned_content"`);
    await queryRunner.query(`ALTER TABLE "application_steps" DROP COLUMN IF EXISTS "notes"`);
  }
}
