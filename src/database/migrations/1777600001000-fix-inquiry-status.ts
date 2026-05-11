import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixInquiryStatus1777600001000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    // 구 스키마(PENDING/RESOLVED)를 신 스키마(OPEN/CLOSED)로 정규화
    await qr.query(
      `UPDATE inquiries SET status = 'OPEN'   WHERE status = 'PENDING'`,
    );
    await qr.query(
      `UPDATE inquiries SET status = 'CLOSED' WHERE status = 'RESOLVED'`,
    );
  }

  async down(qr: QueryRunner) {
    await qr.query(
      `UPDATE inquiries SET status = 'PENDING'  WHERE status = 'OPEN'`,
    );
    await qr.query(
      `UPDATE inquiries SET status = 'RESOLVED' WHERE status = 'CLOSED'`,
    );
  }
}
