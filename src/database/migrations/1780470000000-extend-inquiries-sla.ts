import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B2 Phase 4 — inquiries 의 assign / priority / SLA 컬럼 추가.
 *
 * - `assigned_to` UUID NULL — admin user FK (어떤 admin 이 처리 중인가)
 * - `priority` varchar(10) DEFAULT 'medium' CHECK ('high','medium','low')
 * - `sla_deadline_at` TIMESTAMPTZ NULL — 처리 기한 (priority 별 default high=4h/medium=24h/low=72h)
 *
 * 인덱스: `(status, sla_deadline_at) WHERE status != 'CLOSED'` — sla-overdue 쿼리 핫패스.
 */
export class ExtendInquiriesSla1780470000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE inquiries
       ADD COLUMN assigned_to UUID NULL REFERENCES users(id) ON DELETE SET NULL,
       ADD COLUMN priority VARCHAR(10) NOT NULL DEFAULT 'medium',
       ADD COLUMN sla_deadline_at TIMESTAMPTZ NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE inquiries
       ADD CONSTRAINT inquiries_priority_check
       CHECK (priority IN ('high', 'medium', 'low'))`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_inquiries_sla_overdue
       ON inquiries (status, sla_deadline_at)
       WHERE status != 'CLOSED'`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_inquiries_assigned_to
       ON inquiries (assigned_to)
       WHERE assigned_to IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_inquiries_assigned_to`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_inquiries_sla_overdue`);
    await queryRunner.query(
      `ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS inquiries_priority_check`,
    );
    await queryRunner.query(
      `ALTER TABLE inquiries
       DROP COLUMN IF EXISTS sla_deadline_at,
       DROP COLUMN IF EXISTS priority,
       DROP COLUMN IF EXISTS assigned_to`,
    );
  }
}
