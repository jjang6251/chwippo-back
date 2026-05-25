import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateExperienceToActivity1779920000000
  implements MigrationInterface
{
  name = 'MigrateExperienceToActivity1779920000000';

  async up(qr: QueryRunner): Promise<void> {
    const tableExists = await qr.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'myinfo_experiences'
       ) AS exists;`,
    );
    if (!tableExists?.[0]?.exists) return;

    await qr.query(`
      INSERT INTO activities (user_id, name, org, started_at, ended_at, summary, legacy_experience_id, created_at, updated_at)
      SELECT
        e.user_id,
        e.activity_name,
        e.org,
        e.start_at,
        e.end_at,
        e.content,
        e.id,
        now(),
        now()
      FROM myinfo_experiences e
      WHERE NOT EXISTS (
        SELECT 1 FROM activities a WHERE a.legacy_experience_id = e.id
      );
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(
      `DELETE FROM activities WHERE legacy_experience_id IS NOT NULL;`,
    );
  }
}
