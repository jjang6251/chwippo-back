import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTermsAgreedAt1777600003000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS terms_agreed_at TIMESTAMPTZ NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users DROP COLUMN IF EXISTS terms_agreed_at
    `);
  }
}
