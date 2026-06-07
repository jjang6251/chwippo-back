import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B2 Phase 2 — alert_thresholds 에 4 신규 임계치 추가.
 *
 * Q5 모든 alert + 임계치 admin 수정 + Discord 통합.
 *
 * - `inquiry_sla_hours INT DEFAULT 24` — 문의 SLA 임계치 (Phase 4 의 sla_deadline_at 기본값)
 * - `abuser_suspect_daily_calls INT DEFAULT 100` — 사용자 일 100회 초과 시 abuser 의심
 * - `free_user_signup_spike_pct INT DEFAULT 200` — Free 사용자 가입 폭증 (전일 대비 %)
 * - `cost_outlier_stddev NUMERIC(4,2) DEFAULT 2.0` — feature 별 cost 평균 ±N σ 초과 시 outlier
 */
export class ExtendAlertThresholds1780440000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alert_thresholds ADD COLUMN inquiry_sla_hours INT NOT NULL DEFAULT 24`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds ADD COLUMN abuser_suspect_daily_calls INT NOT NULL DEFAULT 100`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds ADD COLUMN free_user_signup_spike_pct INT NOT NULL DEFAULT 200`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds ADD COLUMN cost_outlier_stddev NUMERIC(4,2) NOT NULL DEFAULT 2.0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alert_thresholds DROP COLUMN IF EXISTS cost_outlier_stddev`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds DROP COLUMN IF EXISTS free_user_signup_spike_pct`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds DROP COLUMN IF EXISTS abuser_suspect_daily_calls`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds DROP COLUMN IF EXISTS inquiry_sla_hours`,
    );
  }
}
