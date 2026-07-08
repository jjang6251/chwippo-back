import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 심층 점검 결과 영속화 — coverletter_feedback (AI 제출 전 점검) 결과를 문항 row 에 저장.
 *
 * 배경: 기존엔 review() 결과를 반환만 하고 저장하지 않아, 사용자가 모달을 닫거나
 * 새로고침하면 코인만 소비되고 결과가 증발했다 (운영 원칙 "AI 호출 1회 = 결과 1개
 * 보장, 유실 금지" 위반). ADR-040 웨이브 후속으로 마지막 점검 결과 1개를 영속화한다.
 *
 * - last_feedback     : 마지막 status='ok' 점검 결과 JSON (strengths·issues·suggestions·summary)
 * - last_feedback_at  : 마지막 점검 시각 (재방문 시 "N일 전 점검" 표시용)
 *
 * 가역 — CI 가 down→up 자동 검증.
 */
export class AddCoverletterLastFeedback1780720000000 implements MigrationInterface {
  name = 'AddCoverletterLastFeedback1780720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "application_coverletters"
      ADD COLUMN "last_feedback" jsonb,
      ADD COLUMN "last_feedback_at" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "application_coverletters"
      DROP COLUMN "last_feedback_at",
      DROP COLUMN "last_feedback"
    `);
  }
}
