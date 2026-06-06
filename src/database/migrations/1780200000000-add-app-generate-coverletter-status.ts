import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B1c — 자소서 생성 → 회사조사 atomic 흐름.
 *
 * **변경**:
 * 1. `feature_coin_meta` +`fixed_coin_cost INTEGER NULL` 컬럼 — feature 별 고정 차감 (token 환산 무시)
 *    - `company_research`: charges_coins=true, fixed_coin_cost=50, avg_coin_cost=50 (UPDATE)
 *      → 사용자가 자소서 생성 시 회사조사 trigger, 50 코인 차감 (cache hit/miss 무관)
 *      → cache hit 시 우리 이득 (50 코인 부담만, LLM 호출 0)
 *      → cache miss 시 우리 약간 손해 (~$0.045 cost vs ~$0.025 코인 가치)
 *
 * 2. `applications` +`coverletter_generation_status VARCHAR(20) DEFAULT 'idle'` + CHECK
 *    enum: 'idle' / 'in_progress' / 'completed' / 'failed'
 *    +`coverletter_generation_started_at TIMESTAMPTZ NULL` — in_progress stuck timeout (30분) 처리용
 *
 *    **흐름**:
 *    - idle → in_progress (atomic UPDATE WHERE status='idle' RETURNING) — race 차단
 *    - in_progress → completed (회사조사 성공 + 50 코인 차감 + cache 저장)
 *    - in_progress → failed (LLM 실패, 코인 차감 X)
 *    - failed → idle (사용자 재시도 시 service 가 자동 reset)
 *    - completed → no-op (이미 완료, 자소서 작성 가능)
 *
 * **legacy 데이터**: 기존 application 모두 status='idle' default. 이미 자소서가 있는 application 도
 * idle 인 채 유지 — 사용자가 "생성하기" 안 누름 → 회사조사 cache 그대로 활용 (있으면) 또는 없음.
 */
export class AddAppGenerateCoverletterStatus1780200000000 implements MigrationInterface {
  name = 'AddAppGenerateCoverletterStatus1780200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. feature_coin_meta +fixed_coin_cost
    await queryRunner.query(`
      ALTER TABLE feature_coin_meta
      ADD COLUMN fixed_coin_cost INTEGER
    `);
    await queryRunner.query(`
      UPDATE feature_coin_meta
      SET charges_coins = true,
          fixed_coin_cost = 50,
          avg_coin_cost = 50,
          description = '자소서 생성 시 자동 trigger — 50 코인 고정 차감 (cache hit/miss 무관). cache hit 시 우리 이득, miss 시 약간 손해'
      WHERE feature = 'company_research'
    `);

    // 2. applications +coverletter_generation_status (+ started_at)
    await queryRunner.query(`
      ALTER TABLE applications
      ADD COLUMN coverletter_generation_status VARCHAR(20) NOT NULL DEFAULT 'idle',
      ADD COLUMN coverletter_generation_started_at TIMESTAMPTZ
    `);
    await queryRunner.query(`
      ALTER TABLE applications
      ADD CONSTRAINT applications_coverletter_generation_status_check
      CHECK (coverletter_generation_status IN ('idle', 'in_progress', 'completed', 'failed'))
    `);

    // 3. 인덱스 — in_progress stuck 감지 cron 빠르게
    await queryRunner.query(`
      CREATE INDEX idx_applications_coverletter_gen_status
      ON applications(coverletter_generation_status, coverletter_generation_started_at)
      WHERE coverletter_generation_status = 'in_progress'
    `);

    // 4. legacy backfill — 이미 자소서 row 있는 application 은 'completed' (회사조사 안 했어도)
    //    → 기존 자소서 작성 흐름 보존. "자소서 생성하기" 버튼 노출 X.
    //    신규 application 만 status='idle' 부터 시작.
    //
    //    PR_B1c CTO 검토 M3 — legacy 사용자가 자소서 페이지 진입 시 silent 50 코인 차감 방지.
    //    backfill 시점에 회사조사 cache 가 실제로 없으므로, 사용자에게 outdated banner 표시.
    //    사용자 명시 "다시 조사" 동의 후만 50 코인 차감 + LLM 호출.
    //    1780300000000 마이그레이션이 outdated_at 컬럼 추가하면 그 다음 cron / 사용자 진입 시점에 정상 노출.
    //
    //    단 이 마이그레이션 적용 시점에 outdated_at 컬럼 자체가 아직 없음 (1780300000000 이 추가).
    //    따라서 이 마이그레이션에서는 status 만 'completed' 처리하고,
    //    1780300000000 마이그레이션이 legacy 데이터의 outdated_at 도 set 처리한다.
    await queryRunner.query(`
      UPDATE applications
      SET coverletter_generation_status = 'completed'
      WHERE id IN (
        SELECT DISTINCT application_id
        FROM application_coverletters
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_applications_coverletter_gen_status`,
    );
    await queryRunner.query(`
      ALTER TABLE applications
      DROP CONSTRAINT IF EXISTS applications_coverletter_generation_status_check
    `);
    await queryRunner.query(`
      ALTER TABLE applications
      DROP COLUMN IF EXISTS coverletter_generation_started_at,
      DROP COLUMN IF EXISTS coverletter_generation_status
    `);
    // feature_coin_meta — 데이터만 원복 (컬럼은 다른 feature 도 향후 사용 가능 — 컬럼 보존)
    await queryRunner.query(`
      UPDATE feature_coin_meta
      SET charges_coins = false,
          fixed_coin_cost = NULL,
          avg_coin_cost = 0,
          description = '우리 부담 — web_search tool 비용 ($0.01/search)'
      WHERE feature = 'company_research'
    `);
    await queryRunner.query(`
      ALTER TABLE feature_coin_meta DROP COLUMN IF EXISTS fixed_coin_cost
    `);
  }
}
