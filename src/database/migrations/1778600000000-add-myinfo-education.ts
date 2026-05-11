import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMyinfoEducation1778600000000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS myinfo_educations (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        school_name  VARCHAR NOT NULL,
        major        VARCHAR NULL,
        minor        VARCHAR NULL,
        degree       VARCHAR NULL,
        gpa          NUMERIC(4,2) NULL,
        gpa_max      NUMERIC(4,2) NULL,
        start_at     DATE NULL,
        end_at       DATE NULL,
        status       VARCHAR NULL,
        location     VARCHAR NULL,
        file_url     VARCHAR NULL
      );
    `);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_educations_user ON myinfo_educations(user_id);`);
  }

  async down(qr: QueryRunner) {
    await qr.query(`DROP INDEX IF EXISTS idx_educations_user`);
    await qr.query(`DROP TABLE IF EXISTS myinfo_educations`);
  }
}
