import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCertExpiresAt1778500000000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    await qr.query(`ALTER TABLE myinfo_language_certs ADD COLUMN IF NOT EXISTS expires_at DATE NULL;`);
    await qr.query(`ALTER TABLE myinfo_certs ADD COLUMN IF NOT EXISTS expires_at DATE NULL;`);
  }

  async down(qr: QueryRunner) {
    await qr.query(`ALTER TABLE myinfo_certs DROP COLUMN IF EXISTS expires_at;`);
    await qr.query(`ALTER TABLE myinfo_language_certs DROP COLUMN IF EXISTS expires_at;`);
  }
}
