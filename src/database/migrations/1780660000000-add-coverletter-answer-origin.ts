import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A1 자소서 3경로 — 답변 출처 컬럼 (CEO Q2 B안, 2026-07-06).
 *
 * - 'manual'   : 직접 타이핑 (답변 첫 저장 시 origin 미지정 default)
 * - 'imported' : 가져오기 모달 경유 (다른 카드 재활용·내정보)
 * - 'ai_draft' : AI 초안/chat 적용으로 첫 생성
 *
 * 원칙: **최초 출처 불변** — 이후 편집·chat 수정에도 갱신하지 않음
 * (activation ahaAi "AI 초안 후 본인 편집" 해석과 정합).
 * 기존 row 는 NULL 유지 (도입 전 데이터 — 출처 불명으로 정직하게 둠).
 */
export class AddCoverletterAnswerOrigin1780660000000
  implements MigrationInterface
{
  name = 'AddCoverletterAnswerOrigin1780660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "application_coverletters"
      ADD COLUMN "answer_origin" varchar(20),
      ADD CONSTRAINT "ck_coverletters_answer_origin"
        CHECK ("answer_origin" IN ('manual', 'imported', 'ai_draft'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "application_coverletters"
      DROP CONSTRAINT "ck_coverletters_answer_origin",
      DROP COLUMN "answer_origin"
    `);
  }
}
