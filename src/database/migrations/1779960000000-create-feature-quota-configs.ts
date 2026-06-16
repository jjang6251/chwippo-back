import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F6 PR 2 Phase 1 — `feature_quota_configs` 테이블 + `users.tier` 컬럼.
 *
 * **설계 결정** (focus.md F6 PR 2 + memory `feedback_admin_quota_control`):
 * - **admin 100% 통제 의무** — 모든 LLM feature 는 cooldown/dayLimit/monthLimit/enabled 4 항목 admin 조절 가능
 * - **kill switch (enabled)** — admin 즉시 ON/OFF. 다음 호출부터 blocked
 * - **tier 분리** — PK (feature, tier). 'free' 조절이 'pro' 영향 0 (유료 보호)
 * - **베타 정책**: day/month 1000/10000 (사실상 무제한) + cooldown 만 차등 제한
 *
 * **seed** (12 feature × 'free' tier = 12 row):
 *   기존 LlmFeature enum 의 모든 값 INSERT. 'pro'/'enterprise' tier 는 F7 결제 인프라 도입 시 추가.
 *
 * **users.tier** 컬럼 추가 — default 'free'. F7 결제 시 admin (또는 결제 시스템) 이 'pro' 로 UPDATE.
 */
export class CreateFeatureQuotaConfigs1779960000000 implements MigrationInterface {
  name = 'CreateFeatureQuotaConfigs1779960000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ── users.tier 컬럼 추가 ──
    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN tier VARCHAR(20) NOT NULL DEFAULT 'free'
        CHECK (tier IN ('free', 'pro', 'enterprise'))
    `);

    // ── feature_quota_configs 테이블 ──
    await queryRunner.query(`
      CREATE TABLE feature_quota_configs (
        feature           VARCHAR(40) NOT NULL,
        tier              VARCHAR(20) NOT NULL CHECK (tier IN ('free', 'pro', 'enterprise')),
        day_limit         INT NOT NULL CHECK (day_limit BETWEEN 0 AND 10000),
        month_limit       INT NOT NULL CHECK (month_limit BETWEEN 10 AND 100000),
        cooldown_seconds  INT NOT NULL CHECK (cooldown_seconds BETWEEN 0 AND 3600),
        enabled           BOOLEAN NOT NULL DEFAULT TRUE,
        updated_by        UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (feature, tier)
      )
    `);

    // enabled=false 빠른 조회 (admin kill switch 활성 feature 식별)
    await queryRunner.query(`
      CREATE INDEX idx_fqc_disabled
        ON feature_quota_configs (feature, tier)
        WHERE enabled = FALSE
    `);

    // ── seed: 12 feature × free tier ──
    // 베타: day/month 사실상 무제한 + cooldown 만 차등
    const seeds: Array<[string, number]> = [
      ['note_summary', 30],
      ['coverletter', 60],
      ['interview', 60],
      ['interview_followup', 60],
      ['score', 30],
      ['analysis', 30],
      ['auto_tag', 30],
      ['coverletter_draft_v2', 120],
      ['coverletter_feedback', 120],
      ['coverletter_recommend', 60],
      ['interview_prep_session', 300],
      ['interview_prep_followup', 60],
    ];
    for (const [feature, cooldown] of seeds) {
      await queryRunner.query(
        `INSERT INTO feature_quota_configs
          (feature, tier, day_limit, month_limit, cooldown_seconds, enabled)
         VALUES ($1, 'free', 1000, 10000, $2, TRUE)`,
        [feature, cooldown],
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS feature_quota_configs`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS tier`);
  }
}
