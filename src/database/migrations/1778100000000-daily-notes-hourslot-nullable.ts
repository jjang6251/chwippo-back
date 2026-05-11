import { MigrationInterface, QueryRunner } from 'typeorm';

export class DailyNotesHourslotNullable1778100000000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE daily_notes ALTER COLUMN hour_slot DROP NOT NULL`,
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(
      `UPDATE daily_notes SET hour_slot = -1 WHERE hour_slot IS NULL`,
    );
    await qr.query(
      `ALTER TABLE daily_notes ALTER COLUMN hour_slot SET NOT NULL`,
    );
  }
}
