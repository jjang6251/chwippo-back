import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLastActiveAt1777600002000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    await qr.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NULL;
    `);
  }

  async down(qr: QueryRunner) {
    await qr.query(`ALTER TABLE users DROP COLUMN IF EXISTS last_active_at`);
  }
}
