import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F1 자소서 풀페이지 Phase D — AI 채팅 메시지 영구 보존.
 *
 * - DB 영구 보존 + 90일 KST cron 자동 삭제 (옵션 B: application 마지막 활동 + 90일 inactive)
 * - 사용자 직접 삭제 권리 (DELETE /applications/:appId/coverletter/messages)
 * - PII 스크럽 후 저장 (LlmService 의 scrubPii 재사용)
 * - application CASCADE → 자소서 삭제 시 메시지도 자동 삭제
 * - per-application max 1000 메시지 cap (서비스 단에서 enforce)
 *
 * **suggested_updates schema** (assistant role 일 때만):
 *   `[{ clId: string (uuid), newAnswer: string }]`
 *   - 백엔드가 clId 가 해당 application 의 자식인지 검증 (IDOR 차단)
 */
export class CreateCoverletterChatMessages1779998000000 implements MigrationInterface {
  name = 'CreateCoverletterChatMessages1779998000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE coverletter_chat_messages (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL CHECK (char_length(content) <= 5000),
        suggested_updates JSONB NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // 인덱스: 페이지 진입 시 GET messages (application_id, created_at ASC)
    //       cron 의 application 별 MAX(created_at) GROUP BY 도 활용
    await queryRunner.query(`
      CREATE INDEX idx_coverletter_chat_msgs_app_created
        ON coverletter_chat_messages(application_id, created_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_coverletter_chat_msgs_app_created`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS coverletter_chat_messages`);
  }
}
