import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W1 — signup 1 질문 (관심 직군) + 샘플 dismiss 추적.
 *
 * 가입 직후 SignupQuestion 페이지에서 관심 직군 다중 선택 (21개 중 1+, 기타 시 자유 입력).
 * 답변 → 가상 회사 샘플 카드 자동 생성 (각 직군 첫 회사, max 3개).
 * sample_cards_dismissed_at = 사용자가 "전체 숨기기" 누른 시각 (한 번 dismiss 시 영구).
 *
 * **CEO 결정 (2026-06-24/26)**:
 * - signup_job_categories = JSONB array (다중 선택 + 후속 추가 직군 확장 대비)
 * - signup_other_text = VARCHAR(200) ("기타" 선택 시 자유 입력. 자유 직무로 가상 회사 생성)
 * - sample_cards_dismissed_at = TIMESTAMPTZ NULL (NULL = 샘플 살아있음, NOT NULL = dismiss 됨)
 */
export class AddUserSignupAnswer1780540000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN signup_job_categories JSONB NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN signup_other_text VARCHAR(200) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN sample_cards_dismissed_at TIMESTAMPTZ NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS sample_cards_dismissed_at`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS signup_other_text`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS signup_job_categories`,
    );
  }
}
