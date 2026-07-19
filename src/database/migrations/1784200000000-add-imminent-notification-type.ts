import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 알림 2차 Phase A (notification-coverage) — 'imminent'(2시간 전 리마인드) 알림 유형 허용.
 *
 * notifications · notification_logs 의 type CHECK 화이트리스트에 'imminent' 추가.
 * 테이블·컬럼·데이터 무변경 (허용 목록 확장만).
 *
 * down(): 구 제약 복원 — imminent 행이 이미 쌓인 DB 에서는 CHECK 위반으로 실패할 수 있음
 * (가산 유형 마이그레이션의 통상 특성 · CI 는 빈 DB 라운드트립이라 무관).
 *
 * 참고: uq_notification_logs_daily_dedup 부분 인덱스는 WHERE type IN ('briefing','deadline_urgent')
 * 한정이라 imminent 는 하루 다건 허용 (per-refId dedup 은 서비스 레벨) — 인덱스 변경 불필요.
 */
export class AddImminentNotificationType1784200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "ck_notifications_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "ck_notifications_type" CHECK (type IN ('briefing', 'deadline_urgent', 'imminent', 'admin'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" DROP CONSTRAINT "ck_notification_logs_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" ADD CONSTRAINT "ck_notification_logs_type" CHECK (type IN ('briefing', 'deadline_urgent', 'imminent', 'admin'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "ck_notifications_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "ck_notifications_type" CHECK (type IN ('briefing', 'deadline_urgent', 'admin'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" DROP CONSTRAINT "ck_notification_logs_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" ADD CONSTRAINT "ck_notification_logs_type" CHECK (type IN ('briefing', 'deadline_urgent', 'admin'))`,
    );
  }
}
