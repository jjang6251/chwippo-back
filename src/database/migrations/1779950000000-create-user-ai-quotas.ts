import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F6 PR 1 — abuser ban / fair-use 정책 적용용 사용자별 quota override 테이블.
 *
 * **설계 결정** (focus.md F6 PR 1 H2 + ADR-027):
 * - **per-request lookup** (cron 불필요) — LlmService 진입점 전에 user_ai_quotas 조회.
 *   `valid_until > now()` 이면서 row 존재 시 daily_cap_override 가 활성. 만료된 row 는 자연히 무시
 * - **PK = user_id** — 사용자당 최대 1 row (active vs expired 구분은 valid_until 만으로). 새 ban 발동 시 UPSERT
 * - **reason** — 자동 ban (`auto_ban_3_consecutive_days`) / 어드민 수동 (`manual_admin`) / fair-use 정책 (`fair_use`) 등 audit
 * - **daily_cap_override NULL = 통상 한도 그대로** — row 가 있어도 cap 변경 없음 (warning only · 어드민 reference 용도)
 * - `admin_audit_logs.action='auto_ban_ai'` 와 쌍으로 작동 — 이 테이블은 enforce, audit_logs 는 history
 */
export class CreateUserAiQuotas1779950000000 implements MigrationInterface {
  name = 'CreateUserAiQuotas1779950000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE user_ai_quotas (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        daily_cap_override INT NULL,
        valid_until TIMESTAMPTZ NULL,
        reason VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // 만료 안 된 row 만 빠르게 조회 (LlmService 진입점 매 호출)
    await queryRunner.query(`
      CREATE INDEX idx_user_ai_quotas_valid
        ON user_ai_quotas (valid_until)
        WHERE valid_until IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS user_ai_quotas`);
  }
}
