import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR 0 마이그레이션 B — AI 사용 별도 동의 컬럼.
 *
 * 개인정보보호법 26조 (제3자 처리위탁: OpenAI·Anthropic 미국 소재) 별도 명시 동의.
 * LlmService 진입점에서 ai_consent_at IS NULL 이면 'blocked_consent' 차단.
 *
 * **기존 F5 NoteSummary 사용자도 재동의 트리거** —
 * 베타 사용자 (terms 동의는 했지만 AI 약관 항목 없었음) 가 F6 출시 후 자소서·면접 외에도
 * note_summary 호출 시 blocked → 다음 접속 시 모달 노출 → 동의 후 정상 호출.
 */
export class AddAiConsentToUsers1779932000000 implements MigrationInterface {
  name = 'AddAiConsentToUsers1779932000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS ai_consent_at      TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS ai_consent_version VARCHAR(10) NULL;
    `);
    // 기존 사용자는 NULL 유지 → 다음 AI 호출 시 blocked_consent → 프론트 모달
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS ai_consent_version,
        DROP COLUMN IF EXISTS ai_consent_at;
    `);
  }
}
