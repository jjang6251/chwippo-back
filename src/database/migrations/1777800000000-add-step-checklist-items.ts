import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStepChecklistItems1777800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE step_checklist_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        step_id UUID NOT NULL REFERENCES application_steps(id) ON DELETE CASCADE,
        content VARCHAR(200) NOT NULL,
        is_done BOOLEAN NOT NULL DEFAULT FALSE,
        order_index INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_step_checklist_step_id ON step_checklist_items (step_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_step_checklist_step_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS step_checklist_items`);
  }
}
