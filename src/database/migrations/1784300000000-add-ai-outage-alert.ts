import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI 제공사 장애 관측 — LlmService error audit hook (ProviderOutageAlertService).
 *
 * **alert_thresholds** (admin 조절 가능한 알림 임계치와 동일 패턴 편입):
 *   - `ai_outage_alert_count_10m INT DEFAULT 3` — 최근 10분(고정 윈도우) provider error ≥ N → 알림
 *   - `ai_outage_alert_cooldown_min INT DEFAULT 30` — 동일 provider 재발송 쿨다운(분)
 *
 * **alert_history**:
 *   - `dedup_key VARCHAR(200) NULL` — provider_outage 발송 idempotency 키.
 *     `uq_alert_history_dedup_key` partial UNIQUE(NULL 제외) 로 동시 2 레플리카 race 차단.
 *     기존 알림 type 은 dedup_key = NULL 이라 index 대상 아님(영향 없음).
 */
export class AddAiOutageAlert1784300000000 implements MigrationInterface {
  name = 'AddAiOutageAlert1784300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alert_thresholds ADD COLUMN ai_outage_alert_count_10m INT NOT NULL DEFAULT 3`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds ADD COLUMN ai_outage_alert_cooldown_min INT NOT NULL DEFAULT 30`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_history ADD COLUMN dedup_key VARCHAR(200) NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_alert_history_dedup_key"
         ON alert_history (dedup_key)
         WHERE dedup_key IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_alert_history_dedup_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_history DROP COLUMN IF EXISTS dedup_key`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds DROP COLUMN IF EXISTS ai_outage_alert_cooldown_min`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_thresholds DROP COLUMN IF EXISTS ai_outage_alert_count_10m`,
    );
  }
}
