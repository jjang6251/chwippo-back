import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDailyNotes1777700000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS daily_notes (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date        DATE NOT NULL,
        hour_slot   SMALLINT NOT NULL CHECK (hour_slot >= 0 AND hour_slot <= 35),
        content     VARCHAR(200) NOT NULL,
        is_done     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_notes_user_date ON daily_notes (user_id, date)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS daily_notes`);
  }
}
