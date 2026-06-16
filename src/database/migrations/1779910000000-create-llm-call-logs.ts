import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLlmCallLogs1779910000000 implements MigrationInterface {
  name = 'CreateLlmCallLogs1779910000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS llm_call_logs (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        feature            VARCHAR(40) NOT NULL,
        model              VARCHAR(40) NOT NULL,
        prompt_tokens      INT NOT NULL DEFAULT 0,
        completion_tokens  INT NOT NULL DEFAULT 0,
        cost_usd           NUMERIC(10,6) NOT NULL DEFAULT 0,
        latency_ms         INT NOT NULL DEFAULT 0,
        status             VARCHAR(20) NOT NULL,
        error_message      TEXT NULL,
        resource_type      VARCHAR(40) NULL,
        resource_id        UUID NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_llm_call_logs_user_feature ON llm_call_logs(user_id, feature, created_at DESC);`,
    );
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_llm_call_logs_created ON llm_call_logs(created_at DESC);`,
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS llm_call_logs;`);
  }
}
