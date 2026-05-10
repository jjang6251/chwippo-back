import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateTodosToDailyNotes1778200000000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      INSERT INTO daily_notes (id, user_id, date, hour_slot, content, is_done, created_at)
      SELECT gen_random_uuid(), user_id::uuid, date, NULL, content, is_done, created_at
      FROM todos
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    // todos 테이블이 그대로 남아있으므로 daily_notes의 null-hourSlot 항목만 제거
    await qr.query(`DELETE FROM daily_notes WHERE hour_slot IS NULL`);
  }
}
