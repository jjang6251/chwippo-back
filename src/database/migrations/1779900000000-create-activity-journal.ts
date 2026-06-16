import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateActivityJournal1779900000000 implements MigrationInterface {
  name = 'CreateActivityJournal1779900000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                  VARCHAR(120) NOT NULL,
        org                   VARCHAR(120) NULL,
        category              VARCHAR(30) NULL,
        started_at            DATE NULL,
        ended_at              DATE NULL,
        summary               TEXT NULL,
        archived_at           TIMESTAMPTZ NULL,
        legacy_experience_id  UUID NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_activities_user_archived ON activities(user_id, archived_at, created_at DESC);`,
    );

    await qr.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        activity_id         UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        user_id             UUID NOT NULL,
        title               VARCHAR(200) NOT NULL,
        occurred_at         DATE NOT NULL,
        cl                  SMALLINT NULL,
        quant_value         NUMERIC NULL,
        quant_unit          VARCHAR(20) NULL,
        comp                VARCHAR(40) NULL,
        keywords            JSONB NOT NULL DEFAULT '[]'::jsonb,
        note                JSONB NULL,
        note_summary        TEXT NULL,
        note_summary_hash   VARCHAR(64) NULL,
        note_summary_at     TIMESTAMPTZ NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_activity_occurred ON activity_logs(activity_id, occurred_at DESC);`,
    );
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id);`,
    );

    await qr.query(`
      CREATE TABLE IF NOT EXISTS activity_reflections (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        activity_id  UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        user_id      UUID NOT NULL,
        content      TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_activity_reflections_activity ON activity_reflections(activity_id, created_at DESC);`,
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS activity_reflections;`);
    await qr.query(`DROP TABLE IF EXISTS activity_logs;`);
    await qr.query(`DROP TABLE IF EXISTS activities;`);
  }
}
