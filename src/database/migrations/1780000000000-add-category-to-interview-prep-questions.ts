import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F1 v2 (2026-06-01) — interview_prep_questions 에 category 컬럼 추가.
 *
 * deep research verified 카테고리 (INTERVIEW_CATEGORIES 18종):
 *   base 7: self_intro·motivation·personality·failure·collaboration·executive·culture_fit
 *   직무: cs_tech·business_reasoning·data_metrics·trend_ai·customer_handling·performance·portfolio_decision·design_process
 *   기타: coverletter_based·company_industry·reverse_question
 *
 * VARCHAR(40) nullable — 옛 세션은 NULL (호환).
 */
export class AddCategoryToInterviewPrepQuestions1780000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions ADD COLUMN IF NOT EXISTS category VARCHAR(40) NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions DROP COLUMN IF EXISTS category`,
    );
  }
}
