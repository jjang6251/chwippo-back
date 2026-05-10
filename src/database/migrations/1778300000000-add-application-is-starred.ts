import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApplicationIsStarred1778300000000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    await qr.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT false;
    `);
  }

  async down(qr: QueryRunner) {
    await qr.query(`ALTER TABLE applications DROP COLUMN IF EXISTS is_starred`);
  }
}
