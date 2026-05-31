import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F1 자소서 풀페이지 Phase G.1 — coverletter_chat_messages 에 citations 추가.
 *
 * **shape** (jsonb):
 *   - user role: `{ selectedLogIds: ['log-uuid-1', ...] }` (사용자가 컨텍스트로 선택한 log)
 *   - assistant role: `{ citedLogIds: ['log-uuid-1', ...], citedResearch: true }` (AI 활용 컨텍스트)
 *
 * **목적** (Notion AI citation 패턴): AI 응답이 어떤 외부 컨텍스트를 활용했는지 사용자에게
 *   가시화 → hallucination 감지 + 사용자 검증 가능. nullable (이전 메시지 호환).
 */
export class AddCitationsToChatMessages1779999000000 implements MigrationInterface {
  name = 'AddCitationsToChatMessages1779999000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE coverletter_chat_messages
        ADD COLUMN citations JSONB NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE coverletter_chat_messages
        DROP COLUMN citations
    `);
  }
}
