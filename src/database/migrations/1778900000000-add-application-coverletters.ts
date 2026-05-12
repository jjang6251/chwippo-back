import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApplicationCoverletters1778900000000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS application_coverletters (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        question    TEXT NOT NULL,
        category    VARCHAR NULL,
        answer      TEXT NULL,
        char_limit  INT NULL,
        order_index INT NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_app_coverletters_application ON application_coverletters(application_id);`,
    );
  }

  async down(qr: QueryRunner) {
    await qr.query(`DROP TABLE IF EXISTS application_coverletters;`);
  }
}
