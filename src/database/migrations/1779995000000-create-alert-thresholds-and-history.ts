import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F6 PR 2 Phase 5.4 — 임계치 알람 인프라.
 *
 * **alert_thresholds**: 단일 row (CHECK id=1). admin 가 동적 통제.
 *   - daily_cost_threshold_usd — 오늘 누적 비용 (USD) ≥ 임계치 → Discord 알람
 *   - hourly_error_rate_threshold — 최근 1시간 error 비율 ≥ % → 알람
 *   - vs_yesterday_increase_threshold — 오늘 vs 어제 같은 시각 누적 증가율 (%)
 *   - enabled — 전체 알람 kill switch
 *
 * **alert_history**: 알람 발송 audit. dedup 1시간 (같은 type 1회 만).
 *   - 'sent' / 'failed' / 'skipped_dedup' / 'skipped_no_webhook'
 *
 * abuser_ban 도 같은 history 에 type='abuser_ban' 으로 기록 (admin UI 통합 가시).
 */
export class CreateAlertThresholdsAndHistory1779995000000 implements MigrationInterface {
  name = 'CreateAlertThresholdsAndHistory1779995000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE alert_thresholds (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        daily_cost_threshold_usd NUMERIC(8,2) NOT NULL DEFAULT 50.00,
        hourly_error_rate_threshold NUMERIC(4,3) NOT NULL DEFAULT 0.100,
        vs_yesterday_increase_threshold NUMERIC(5,2) NOT NULL DEFAULT 200.00,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`INSERT INTO alert_thresholds (id) VALUES (1)`);

    await queryRunner.query(`
      CREATE TABLE alert_history (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        alert_type VARCHAR(40) NOT NULL,
        triggered_value NUMERIC(10,2) NOT NULL,
        threshold_value NUMERIC(10,2) NOT NULL,
        message TEXT NOT NULL,
        webhook_status VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_alert_history_type_created
        ON alert_history (alert_type, created_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS alert_history`);
    await queryRunner.query(`DROP TABLE IF EXISTS alert_thresholds`);
  }
}
