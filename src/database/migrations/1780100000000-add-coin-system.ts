import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B1 — 코인 시스템 도입.
 *
 * **신규 테이블 4**:
 * - tier_configs (3 row: free/lite/standard)
 * - feature_coin_meta (7 row: coverletter_draft_v2·chat·recommend / interview_prep_session·followup / company_research·note_summary)
 * - user_coin_balances (legacy user 일괄 150 부여)
 * - user_plan_history
 *
 * **기존 ALTER 2**:
 * - llm_call_logs +5 컬럼 (cache_creation_tokens · cache_read_tokens · web_search_count · coin_cost · cost_breakdown)
 * - users +1 컬럼 (onboarded_coin_at)
 *
 * **Legacy user 마이그레이션**: 일괄 balance 150 (100 한도 + 50 onboarding 보너스), next_reset_at = 다음 매월 1일 0시 KST.
 */
export class AddCoinSystem1780100000000 implements MigrationInterface {
  name = 'AddCoinSystem1780100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. tier_configs
    await queryRunner.query(`
      CREATE TABLE tier_configs (
        tier VARCHAR(20) PRIMARY KEY,
        monthly_coin_limit NUMERIC(8,1) NOT NULL,
        input_token_cap_per_call INTEGER NOT NULL,
        default_cooldown_seconds INTEGER NOT NULL DEFAULT 3,
        company_research_daily_cap INTEGER NOT NULL,
        note_summary_cooldown_minutes INTEGER NOT NULL,
        price_krw INTEGER,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      INSERT INTO tier_configs (tier, monthly_coin_limit, input_token_cap_per_call, default_cooldown_seconds, company_research_daily_cap, note_summary_cooldown_minutes, price_krw, active) VALUES
        ('free', 100, 8000, 3, 2, 60, 0, true),
        ('lite', 800, 12000, 3, 5, 10, 4900, true),
        ('standard', 1500, 16000, 3, 10, 1, 9900, true)
    `);

    // 2. feature_coin_meta
    await queryRunner.query(`
      CREATE TABLE feature_coin_meta (
        feature VARCHAR(50) PRIMARY KEY,
        charges_coins BOOLEAN NOT NULL,
        avg_coin_cost NUMERIC(6,1) NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      INSERT INTO feature_coin_meta (feature, charges_coins, avg_coin_cost, description) VALUES
        ('coverletter_draft_v2', true, 12, '자소서 전체 초안 생성 (input ~8K + output ~2K)'),
        ('coverletter_chat', true, 3, '자소서 chat 수정 (input ~1.5K + output ~0.5K)'),
        ('coverletter_recommend', true, 5, '자소서 추천 키워드·문장'),
        ('interview_prep_session', true, 10, '면접 prep 세션 (질문 20개 또는 질문만)'),
        ('interview_prep_followup', true, 6, '면접 prep 단일 꼬리질문'),
        ('company_research', false, 0, '우리 부담 — web_search tool 비용 ($0.01/search)'),
        ('note_summary', false, 0, '우리 부담 — cooldown 으로 abuse 방어')
    `);

    // 3. user_coin_balances
    await queryRunner.query(`
      CREATE TABLE user_coin_balances (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        tier VARCHAR(20) NOT NULL DEFAULT 'free' REFERENCES tier_configs(tier),
        balance NUMERIC(8,1) NOT NULL DEFAULT 0,
        cycle_start_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        next_reset_at TIMESTAMPTZ NOT NULL,
        plan_started_at TIMESTAMPTZ,
        plan_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_user_coin_balances_next_reset
        ON user_coin_balances(next_reset_at)
    `);

    // 4. user_plan_history
    await queryRunner.query(`
      CREATE TABLE user_plan_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        from_tier VARCHAR(20) NOT NULL,
        to_tier VARCHAR(20) NOT NULL,
        changed_by VARCHAR(20) NOT NULL,
        changed_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
        reason TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_user_plan_history_user
        ON user_plan_history(user_id, changed_at DESC)
    `);

    // 5. llm_call_logs ALTER
    await queryRunner.query(`
      ALTER TABLE llm_call_logs
        ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN web_search_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN coin_cost NUMERIC(6,2) NOT NULL DEFAULT 0,
        ADD COLUMN cost_breakdown JSONB
    `);

    // 6. users ALTER
    await queryRunner.query(`
      ALTER TABLE users ADD COLUMN onboarded_coin_at TIMESTAMPTZ
    `);

    // 7. Legacy user 마이그레이션 — 일괄 balance 150 (100 + 보너스 50)
    //    next_reset_at = 다음 매월 1일 0시 KST (UTC = 전월 마지막 일 15시)
    await queryRunner.query(`
      INSERT INTO user_coin_balances (user_id, tier, balance, cycle_start_at, next_reset_at)
      SELECT
        id,
        'free',
        150,
        NOW(),
        (date_trunc('month', (NOW() AT TIME ZONE 'Asia/Seoul') + INTERVAL '1 month')) AT TIME ZONE 'Asia/Seoul'
      FROM users
      WHERE suspended_at IS NULL
      ON CONFLICT (user_id) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS onboarded_coin_at`,
    );
    await queryRunner.query(`
      ALTER TABLE llm_call_logs
        DROP COLUMN IF EXISTS cost_breakdown,
        DROP COLUMN IF EXISTS coin_cost,
        DROP COLUMN IF EXISTS web_search_count,
        DROP COLUMN IF EXISTS cache_read_tokens,
        DROP COLUMN IF EXISTS cache_creation_tokens
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS user_plan_history`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_coin_balances`);
    await queryRunner.query(`DROP TABLE IF EXISTS feature_coin_meta`);
    await queryRunner.query(`DROP TABLE IF EXISTS tier_configs`);
  }
}
