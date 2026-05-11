import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExamSchedules1778400000000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS myinfo_exam_schedules (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        exam_type   VARCHAR NOT NULL CHECK (exam_type IN ('language','cert')),
        cert_type   VARCHAR NULL,
        name        VARCHAR NOT NULL,
        exam_date   TIMESTAMPTZ NOT NULL,
        location    VARCHAR NULL,
        memo        TEXT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_exam_schedules_user ON myinfo_exam_schedules(user_id);`,
    );
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_exam_schedules_date ON myinfo_exam_schedules(exam_date);`,
    );
  }

  async down(qr: QueryRunner) {
    await qr.query(`DROP INDEX IF EXISTS idx_exam_schedules_date`);
    await qr.query(`DROP INDEX IF EXISTS idx_exam_schedules_user`);
    await qr.query(`DROP TABLE IF EXISTS myinfo_exam_schedules`);
  }
}
