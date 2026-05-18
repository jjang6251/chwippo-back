import { MigrationInterface, QueryRunner } from 'typeorm';

export class InquiryThread1777600000000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    await qr.query(`
      ALTER TABLE inquiries
        ADD COLUMN IF NOT EXISTS user_unread  INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS admin_unread INT NOT NULL DEFAULT 1;
    `);

    await qr.query(`
      CREATE TABLE IF NOT EXISTS inquiry_comments (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        inquiry_id  UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
        author_role VARCHAR NOT NULL,
        author_id   UUID NOT NULL,
        content     TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT now()
      );
    `);

    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_inq_comments_inquiry ON inquiry_comments(inquiry_id);`,
    );
  }

  async down(qr: QueryRunner) {
    await qr.query(`DROP TABLE IF EXISTS inquiry_comments`);
    await qr.query(
      `ALTER TABLE inquiries DROP COLUMN IF EXISTS user_unread, DROP COLUMN IF EXISTS admin_unread`,
    );
  }
}
