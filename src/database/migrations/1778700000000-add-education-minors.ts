import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEducationMinors1778700000000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    await qr.query(`ALTER TABLE myinfo_educations ADD COLUMN IF NOT EXISTS minors JSONB NULL;`);
  }

  async down(qr: QueryRunner) {
    await qr.query(`ALTER TABLE myinfo_educations DROP COLUMN IF EXISTS minors;`);
  }
}
