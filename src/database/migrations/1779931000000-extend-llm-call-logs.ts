import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR 0 (LLM Provider Abstraction + 보안 인프라) 마이그레이션 A.
 *
 * llm_call_logs 확장:
 * - provider     — OpenAI/Anthropic 등 multi-provider 식별 (기존 row 는 'openai' backfill)
 * - prompt_hash  — SHA256(스크럽 후 prompt) — 사용자 데이터 권리(GDPR 조회) 용
 * - prompt_excerpt — PII 스크럽 후 앞 200자 — 디버깅·CS·audit
 * - output_redacted — 응답 본문에 PII 패턴 검출 시 true (hallucination 감시 metric)
 * - attempts     — callJson retry 횟수 (1=정상 / 2=parsing 재시도 / SDK transport retry 는 0 강제)
 */
export class ExtendLlmCallLogs1779931000000 implements MigrationInterface {
  name = 'ExtendLlmCallLogs1779931000000';

  async up(qr: QueryRunner): Promise<void> {
    // 1) 컬럼 추가 (NULL 허용으로 먼저)
    await qr.query(`
      ALTER TABLE llm_call_logs
        ADD COLUMN IF NOT EXISTS provider         VARCHAR(20) NULL,
        ADD COLUMN IF NOT EXISTS prompt_hash      VARCHAR(64) NULL,
        ADD COLUMN IF NOT EXISTS prompt_excerpt   VARCHAR(200) NULL,
        ADD COLUMN IF NOT EXISTS output_redacted  BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS attempts         INT NOT NULL DEFAULT 1;
    `);

    // 2) 기존 row 의 provider 를 'openai' 로 backfill (F5 NoteSummary 호출 모두 OpenAI 였음)
    await qr.query(`
      UPDATE llm_call_logs
      SET provider = 'openai'
      WHERE provider IS NULL;
    `);

    // 3) provider NOT NULL 강제
    await qr.query(`
      ALTER TABLE llm_call_logs
        ALTER COLUMN provider SET NOT NULL;
    `);

    // 4) 인덱스 — provider 별 집계 (admin /ai-usage)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_llm_call_logs_provider ON llm_call_logs(provider, created_at DESC);`,
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_llm_call_logs_provider;`);
    await qr.query(`
      ALTER TABLE llm_call_logs
        DROP COLUMN IF EXISTS attempts,
        DROP COLUMN IF EXISTS output_redacted,
        DROP COLUMN IF EXISTS prompt_excerpt,
        DROP COLUMN IF EXISTS prompt_hash,
        DROP COLUMN IF EXISTS provider;
    `);
  }
}
