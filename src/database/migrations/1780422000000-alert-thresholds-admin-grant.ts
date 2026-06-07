import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B2 Phase 1 — alert_thresholds 에 admin grant 임계치 2개 추가.
 *
 * **S1 (운영 사고 시뮬)**: admin 1명 시간당 100만 코인 grant 같은 abuse / 실수 차단.
 *
 * - `admin_grant_per_hour_alert INT DEFAULT 10000` — admin 시간당 grant 합계 임계치 (Discord 알림)
 * - `admin_grant_single_alert INT DEFAULT 10000` — 한 번의 grant amount 임계치 (Discord 알림)
 *
 * 적용은 Phase 2 의 ThresholdCheckService 가 cron 매시간 SUM 검사 + grant endpoint 의 진입 검사.
 */
export class AlertThresholdsAdminGrant1780422000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alert_thresholds
       ADD COLUMN admin_grant_per_hour_alert INT NOT NULL DEFAULT 10000`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds
       ADD COLUMN admin_grant_single_alert INT NOT NULL DEFAULT 10000`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alert_thresholds DROP COLUMN IF EXISTS admin_grant_single_alert`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds DROP COLUMN IF EXISTS admin_grant_per_hour_alert`,
    );
  }
}
