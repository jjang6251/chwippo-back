import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F5 schema 를 mock (plans/activity-journal-mock.html) 1:1 로 정렬.
 *
 * activities:
 *   - RENAME category → type, 값 변환 (internship→intern, etc→other)
 *   - DROP summary
 *   - ADD role / result_url / outcome
 *
 * activity_logs:
 *   - RENAME title → content
 *   - DROP cl(smallint) / comp(varchar) / quant_value / quant_unit (mock 와 의미 다름)
 *   - ADD cl(jsonb 배열, 6 카테고리) / comps(jsonb 배열, 10 역량) / quant(jsonb 객체)
 *         / cat(varchar 12종) / mood(varchar 4종) / archived_at(timestamptz)
 *
 * activity_reflections:
 *   - ADD week_start(date) / growth(jsonb) / challenges(jsonb) / next_actions(jsonb)
 *
 * down() 은 CI 가 down→up cycle 자동 검증하므로 reversible 하게 작성.
 */
export class AlignActivitySchemaToMock1779930000000
  implements MigrationInterface
{
  name = 'AlignActivitySchemaToMock1779930000000';

  async up(qr: QueryRunner): Promise<void> {
    // ── activities ────────────────────────────────────────────────
    await qr.query(`ALTER TABLE activities RENAME COLUMN category TO type;`);
    await qr.query(`
      UPDATE activities SET type = CASE type
        WHEN 'internship' THEN 'intern'
        WHEN 'etc' THEN 'other'
        ELSE type
      END;
    `);
    await qr.query(`ALTER TABLE activities DROP COLUMN IF EXISTS summary;`);
    await qr.query(`
      ALTER TABLE activities
        ADD COLUMN role VARCHAR(120) NULL,
        ADD COLUMN result_url VARCHAR(500) NULL,
        ADD COLUMN outcome VARCHAR(200) NULL;
    `);

    // ── activity_logs ─────────────────────────────────────────────
    await qr.query(`ALTER TABLE activity_logs RENAME COLUMN title TO content;`);
    await qr.query(`ALTER TABLE activity_logs DROP COLUMN IF EXISTS cl;`);
    await qr.query(`ALTER TABLE activity_logs DROP COLUMN IF EXISTS comp;`);
    await qr.query(
      `ALTER TABLE activity_logs DROP COLUMN IF EXISTS quant_value;`,
    );
    await qr.query(
      `ALTER TABLE activity_logs DROP COLUMN IF EXISTS quant_unit;`,
    );
    await qr.query(`
      ALTER TABLE activity_logs
        ADD COLUMN cl JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN comps JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN quant JSONB NULL,
        ADD COLUMN cat VARCHAR(30) NULL,
        ADD COLUMN mood VARCHAR(20) NULL,
        ADD COLUMN archived_at TIMESTAMPTZ NULL;
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_activity_logs_archived ON activity_logs(activity_id, archived_at);`,
    );

    // ── activity_reflections ─────────────────────────────────────
    await qr.query(`
      ALTER TABLE activity_reflections
        ADD COLUMN week_start DATE NULL,
        ADD COLUMN growth JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN challenges JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN next_actions JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    // ── activity_reflections (역방향) ─────────────────────────────
    await qr.query(`
      ALTER TABLE activity_reflections
        DROP COLUMN IF EXISTS week_start,
        DROP COLUMN IF EXISTS growth,
        DROP COLUMN IF EXISTS challenges,
        DROP COLUMN IF EXISTS next_actions;
    `);

    // ── activity_logs (역방향) ────────────────────────────────────
    await qr.query(`DROP INDEX IF EXISTS idx_activity_logs_archived;`);
    await qr.query(`
      ALTER TABLE activity_logs
        DROP COLUMN IF EXISTS cl,
        DROP COLUMN IF EXISTS comps,
        DROP COLUMN IF EXISTS quant,
        DROP COLUMN IF EXISTS cat,
        DROP COLUMN IF EXISTS mood,
        DROP COLUMN IF EXISTS archived_at;
    `);
    await qr.query(`
      ALTER TABLE activity_logs
        ADD COLUMN cl SMALLINT NULL,
        ADD COLUMN comp VARCHAR(40) NULL,
        ADD COLUMN quant_value NUMERIC NULL,
        ADD COLUMN quant_unit VARCHAR(20) NULL;
    `);
    await qr.query(`ALTER TABLE activity_logs RENAME COLUMN content TO title;`);

    // ── activities (역방향) ──────────────────────────────────────
    await qr.query(`
      ALTER TABLE activities
        DROP COLUMN IF EXISTS role,
        DROP COLUMN IF EXISTS result_url,
        DROP COLUMN IF EXISTS outcome;
    `);
    await qr.query(`ALTER TABLE activities ADD COLUMN summary TEXT NULL;`);
    // category 값 역변환 (intern→internship, other→etc, mock-only 7종은 NULL)
    await qr.query(`
      UPDATE activities SET type = CASE type
        WHEN 'intern' THEN 'internship'
        WHEN 'other' THEN 'etc'
        WHEN 'project' THEN 'project'
        WHEN 'volunteer' THEN 'volunteer'
        WHEN 'club' THEN 'club'
        WHEN 'study' THEN 'study'
        ELSE NULL
      END;
    `);
    await qr.query(`ALTER TABLE activities RENAME COLUMN type TO category;`);
  }
}
